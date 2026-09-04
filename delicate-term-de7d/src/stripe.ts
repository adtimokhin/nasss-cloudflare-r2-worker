import Stripe from 'stripe';
import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore, type Firestore, type FirestoreDoc } from './firestore';
import { hasActiveMembership } from './membership';

// -----------------------------------------------------------------------------
// Stripe membership integration, per the NASSS Firestore schema.
//
//  POST /create-checkout-session — authMiddleware runs first. Looks up
//    products/{price_id} to decide session mode + shipping collection.
//  POST /webhooks/stripe — no auth; verified by the Stripe signature. Writes
//    one-time payments to members/{uid}/purchases/{checkout_session_id} and
//    recurring memberships to members/{uid}/subscriptions/{subscription_id}
//    (deterministic doc ids = idempotent against Stripe's retries).
//
// There is no membership-status cache on members/{uid} — "is this member
// active" is derived at read time from these subcollections wherever it's
// needed (paywall check, account page, admin dashboard), not written here.
//
// Extra secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
// Firestore writes reuse FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.
// -----------------------------------------------------------------------------

type Ctx = Context<{ Bindings: Env; Variables: { user: JWTPayload } }>;

const SUCCESS_URL =
  'https://www.serbianstudies.org/membership-success?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://www.serbianstudies.org/membership';

// Countries offered in the Checkout shipping-address form (only used when the
// product's `requires_shipping` is true). Trim/extend to taste.
const SHIPPING_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'IE', 'RS', 'BA', 'HR', 'SI', 'ME', 'MK', 'AL', 'BG',
  'RO', 'HU', 'AT', 'DE', 'CH', 'FR', 'BE', 'NL', 'LU', 'IT', 'ES', 'PT', 'GR',
  'CZ', 'SK', 'PL', 'DK', 'SE', 'NO', 'FI', 'IS', 'EE', 'LV', 'LT', 'UA', 'MD',
  'TR', 'AU', 'NZ', 'JP', 'KR', 'IL', 'BR', 'AR', 'CL', 'ZA',
] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection['allowed_countries'];

// Workers have no Node crypto / sockets — Stripe needs the fetch HTTP client,
// and webhook verification needs the SubtleCrypto provider.
function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}
const webCrypto = Stripe.createSubtleCryptoProvider();

type ProductConfig = {
  name: string;
  mode: 'payment' | 'subscription';
  tier_granted: string;
  requires_shipping: boolean;
  coverage_days: number | null;
};

// =============================================================================
// POST /create-checkout-session
// =============================================================================
export async function createCheckoutSession(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { price_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const priceId = body.price_id;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    return c.json({ error: 'A valid price_id is required' }, 400);
  }

  const db = getFirestore(c.env);

  // Both membership products (one-time and subscription) grant the same
  // access, so don't let an already-active member start a checkout for
  // either one — they'd just be paying to stack a second grant on top.
  if (await hasActiveMembership(db, uid)) {
    return c.json({ error: 'You already have an active membership.' }, 409);
  }

  const productDoc = await db.getDoc(`products/${priceId}`);
  if (!productDoc) {
    return c.json({ error: 'Unknown price_id' }, 400);
  }
  const product = readProduct(productDoc, priceId);
  if (product.mode !== 'payment' && product.mode !== 'subscription') {
    console.error('products/%s has invalid mode:', priceId, productDoc.mode);
    return c.json({ error: 'Product is misconfigured' }, 500);
  }

  try {
    const stripe = stripeClient(c.env);
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: product.mode,
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: typeof user.email === 'string' ? user.email : undefined,
      client_reference_id: uid,
      metadata: { firebase_uid: uid, price_id: priceId },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    };
    if (product.requires_shipping) {
      params.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
    }
    if (product.mode === 'payment') {
      params.customer_creation = 'always';
    } else {
      // So every later subscription.* event can resolve the member.
      params.subscription_data = { metadata: { firebase_uid: uid, price_id: priceId } };
    }

    const session = await stripe.checkout.sessions.create(params);
    return c.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Failed to create Checkout session:', err);
    return c.json({ error: 'Could not start checkout' }, 500);
  }
}

// =============================================================================
// POST /webhooks/stripe
// =============================================================================
export async function stripeWebhook(c: Ctx): Promise<Response> {
  const stripe = stripeClient(c.env);
  const signature = c.req.header('stripe-signature') ?? '';
  const payload = await c.req.text(); // raw body — required for signature check

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      webCrypto,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Webhook signature verification failed:', message);
    return c.text(`Webhook Error: ${message}`, 400);
  }

  const db = getFirestore(c.env);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripe, db, event.data.object);
        break;

      case 'invoice.paid': {
        const subId = invoiceSubscriptionId(event.data.object);
        if (subId) await upsertSubscription(stripe, db, subId, {});
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await upsertSubscription(stripe, db, sub.id, { uid: sub.metadata?.firebase_uid });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const uid = sub.metadata?.firebase_uid ?? (await uidBySubscription(db, sub.id));
        if (uid) {
          await db.patchDoc(`members/${uid}/subscriptions/${sub.id}`, {
            status: 'canceled',
            cancel_at_period_end: sub.cancel_at_period_end ?? false,
            updated_at: new Date(),
          });
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const pi =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (pi) {
          const [purchase] = await db.queryGroup(
            'purchases',
            [['stripe_payment_intent_id', pi]],
            1,
          );
          if (purchase) {
            const uid = uidFromName(purchase._name);
            await db.patchDoc(`members/${uid}/purchases/${purchase._id}`, { status: 'refunded' });
          } else {
            console.warn('charge.refunded: no purchase for payment_intent', pi);
          }
        }
        break;
      }

      default:
        break; // ignore everything else
    }
  } catch (err) {
    console.error('Error handling Stripe event:', event.type, err);
    return c.text('Handler error', 500); // 500 → Stripe retries the delivery
  }

  return c.json({ received: true });
}

// =============================================================================
// Event handlers
// =============================================================================

async function handleCheckoutCompleted(
  stripe: Stripe,
  db: Firestore,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const uid = session.client_reference_id || session.metadata?.firebase_uid;
  if (!uid) {
    console.warn('checkout.session.completed without a Firebase uid:', session.id);
    return;
  }

  const priceId =
    session.metadata?.price_id ?? (await firstLineItemPrice(stripe, session.id));
  const product = await loadProduct(db, priceId);
  const shipping = getShippingDetails(session);

  if (session.mode === 'payment') {
    const start = new Date();
    const days = product.coverage_days ?? 365;
    const end = new Date(start.getTime() + days * 86_400_000);

    await db.patchDoc(`members/${uid}/purchases/${session.id}`, {
      price_id: priceId ?? null,
      product_name: product.name,
      amount: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
      status: 'completed',
      tier_granted: product.tier_granted,
      coverage_start: start,
      coverage_end: end,
      requires_shipping: product.requires_shipping,
      mailing_address:
        product.requires_shipping && shipping?.address ? plainAddress(shipping.address) : null,
      purchased_at: start,
    });
  } else if (session.mode === 'subscription' && typeof session.subscription === 'string') {
    await upsertSubscription(stripe, db, session.subscription, {
      uid,
      priceIdHint: priceId,
      shipping,
    });
  }

  // Best-effort: mirror name + shipping onto the Stripe Customer for the
  // Dashboard / any Stripe-side fulfilment views. Billing address is left to
  // Stripe's own payment records and is not stored in Firestore.
  if (typeof session.customer === 'string') {
    const details = session.customer_details;
    const update: Stripe.CustomerUpdateParams = {};
    if (details?.name) update.name = details.name;
    if (details?.address) update.address = toStripeAddressParam(details.address);
    if (shipping?.address?.line1) {
      update.shipping = {
        name: shipping.name ?? details?.name ?? 'Member',
        address: toStripeAddressParam(shipping.address),
      };
    }
    if (Object.keys(update).length) {
      try {
        await stripe.customers.update(session.customer, update);
      } catch (err) {
        console.error('Failed to update Stripe customer:', session.customer, err);
      }
    }
  }
}

/**
 * Create or refresh members/{uid}/subscriptions/{subId} from the live Stripe
 * subscription. Returns the resolved uid (or null if it can't be determined).
 */
async function upsertSubscription(
  stripe: Stripe,
  db: Firestore,
  subId: string,
  opts: {
    uid?: string;
    priceIdHint?: string | null;
    shipping?: { name?: string | null; address?: Stripe.Address | null } | null;
  },
): Promise<string | null> {
  const sub = await stripe.subscriptions.retrieve(subId);
  const uid = opts.uid ?? sub.metadata?.firebase_uid ?? (await uidBySubscription(db, subId));
  if (!uid) {
    console.warn('subscription event without a resolvable firebase_uid:', subId);
    return null;
  }

  const priceId = sub.items.data[0]?.price?.id ?? opts.priceIdHint ?? null;
  const product = await loadProduct(db, priceId);
  const period = subscriptionPeriod(sub);
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  const fields: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    price_id: priceId,
    status: sub.status,
    tier_granted: product.tier_granted,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    requires_shipping: product.requires_shipping,
    created_at: new Date(sub.created * 1000),
    updated_at: new Date(),
  };
  // Only touch mailing_address when we actually have one in hand (checkout), so
  // renewals / status changes never blank it.
  if (product.requires_shipping && opts.shipping?.address) {
    fields.mailing_address = plainAddress(opts.shipping.address);
  }

  await db.patchDoc(`members/${uid}/subscriptions/${sub.id}`, fields);
  return uid;
}

// =============================================================================
// Helpers
// =============================================================================

async function loadProduct(db: Firestore, priceId: string | null): Promise<ProductConfig> {
  const fallback: ProductConfig = {
    name: priceId ?? 'Membership',
    mode: 'payment',
    tier_granted: 'standard',
    requires_shipping: false,
    coverage_days: 365,
  };
  if (!priceId) return fallback;
  const doc = await db.getDoc(`products/${priceId}`);
  if (!doc) {
    console.warn('No products/ doc for', priceId, '- using fallback config');
    return fallback;
  }
  return readProduct(doc, priceId);
}

function readProduct(doc: FirestoreDoc, priceId: string): ProductConfig {
  return {
    name: typeof doc.name === 'string' ? doc.name : priceId,
    mode: doc.mode === 'subscription' ? 'subscription' : 'payment',
    tier_granted: typeof doc.tier_granted === 'string' ? doc.tier_granted : 'standard',
    requires_shipping: doc.requires_shipping === true,
    coverage_days: typeof doc.coverage_days === 'number' ? doc.coverage_days : null,
  };
}

async function firstLineItemPrice(stripe: Stripe, sessionId: string): Promise<string | null> {
  try {
    const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 1 });
    return items.data[0]?.price?.id ?? null;
  } catch {
    return null;
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const anyInvoice = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } } } | null;
  };
  const raw =
    anyInvoice.subscription ?? anyInvoice.parent?.subscription_details?.subscription ?? null;
  return typeof raw === 'string' ? raw : (raw?.id ?? null);
}

// current_period_* moved onto subscription items in newer Stripe API versions;
// read whichever the response carries.
function subscriptionPeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const anySub = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  const startUnix = anySub.current_period_start ?? anySub.items?.data?.[0]?.current_period_start;
  const endUnix = anySub.current_period_end ?? anySub.items?.data?.[0]?.current_period_end;
  return {
    start: startUnix ? new Date(startUnix * 1000) : null,
    end: endUnix ? new Date(endUnix * 1000) : null,
  };
}

async function uidBySubscription(db: Firestore, subId: string): Promise<string | null> {
  const [doc] = await db.queryGroup('subscriptions', [['stripe_subscription_id', subId]], 1);
  return doc ? uidFromName(doc._name) : null;
}

// name: projects/<p>/databases/(default)/documents/members/<uid>/<sub>/<id>
function uidFromName(name: string): string {
  const parts = name.split('/');
  const i = parts.indexOf('members');
  return i >= 0 ? (parts[i + 1] ?? '') : '';
}

// Stripe address (nullable fields) -> plain map for Firestore.
function plainAddress(a: Stripe.Address): Record<string, string | null> {
  return {
    line1: a.line1 ?? null,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    postal_code: a.postal_code ?? null,
    country: a.country ?? null,
  };
}

// Same data as an API param object, with null/empty fields dropped (the Stripe
// write API rejects null address fields).
function toStripeAddressParam(a: Stripe.Address): Stripe.AddressParam {
  const out: Stripe.AddressParam = {};
  if (a.line1) out.line1 = a.line1;
  if (a.line2) out.line2 = a.line2;
  if (a.city) out.city = a.city;
  if (a.state) out.state = a.state;
  if (a.postal_code) out.postal_code = a.postal_code;
  if (a.country) out.country = a.country;
  return out;
}

// Shipping details live under different keys depending on the account's Stripe
// API version: newer -> collected_information.shipping_details, older ->
// shipping_details. Read whichever is populated.
function getShippingDetails(
  session: Stripe.Checkout.Session,
): { name?: string | null; address?: Stripe.Address | null } | null {
  const s = session as unknown as {
    shipping_details?: { name?: string | null; address?: Stripe.Address | null } | null;
    collected_information?: {
      shipping_details?: { name?: string | null; address?: Stripe.Address | null } | null;
    } | null;
  };
  return s.collected_information?.shipping_details ?? s.shipping_details ?? null;
}
