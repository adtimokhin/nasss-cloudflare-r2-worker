import Stripe from 'stripe';
import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore, type Firestore, type FirestoreDoc } from './firestore';
import { hasActiveMembership } from './membership';
import { capturePosthogEvent } from './posthog';

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
  'https://www.serbianstudies.org/new-membership?checkout=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'https://www.serbianstudies.org/new-membership?checkout=cancelled';

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

  let body: { price_id?: unknown; donation_amount?: unknown; ref?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const priceId = body.price_id;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    return c.json({ error: 'A valid price_id is required' }, 400);
  }

  const donationAmountInput = body.donation_amount;
  let donationAmount = 0;
  if (donationAmountInput !== undefined) {
    if (
      typeof donationAmountInput !== 'number' ||
      !Number.isInteger(donationAmountInput) ||
      donationAmountInput < 0
    ) {
      return c.json({ error: 'donation_amount must be a non-negative integer' }, 400);
    }
    donationAmount = donationAmountInput;
  }

  const ref = typeof body.ref === 'string' ? body.ref : undefined;

  const db = getFirestore(c.env);

  // Both membership products (one-time and subscription) grant the same
  // access, so don't let an already-active member start a checkout for
  // either one — they'd just be paying to stack a second grant on top.
  if (await hasActiveMembership(db, uid)) {
    c.executionCtx.waitUntil(
      capturePosthogEvent(c.env, 'checkout_blocked_existing_membership', uid, {}),
    );
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
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: priceId, quantity: 1 },
    ];
    if (donationAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Donation' },
          unit_amount: donationAmount,
        },
        quantity: 1,
      });
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: product.mode,
      line_items: lineItems,
      customer_email: typeof user.email === 'string' ? user.email : undefined,
      client_reference_id: uid,
      metadata: {
        firebase_uid: uid,
        price_id: priceId,
        ...(ref === 'renewal' ? { ref: 'renewal' } : {}),
      },
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
      // So a payment_intent.payment_failed event (a card decline) can
      // resolve back to the member — see the webhook's Case B handling.
      params.payment_intent_data = { metadata: { firebase_uid: uid, price_id: priceId } };
    } else {
      // So every later subscription.* event can resolve the member.
      params.subscription_data = { metadata: { firebase_uid: uid, price_id: priceId } };
    }

    const session = await stripe.checkout.sessions.create(params);
    return c.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Failed to create Checkout session:', err);
    c.executionCtx.waitUntil(
      capturePosthogEvent(c.env, 'payment_failed', uid, {
        failure_reason: 'session_creation_failed',
      }),
    );
    return c.json({ error: 'Could not start checkout' }, 500);
  }
}

// =============================================================================
// POST /cancel-subscription
// =============================================================================
export async function cancelSubscription(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { subscription_doc_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const subId = body.subscription_doc_id;
  if (typeof subId !== 'string' || !subId) {
    return c.json({ error: 'subscription_doc_id is required' }, 400);
  }

  // Scoped under the caller's own uid, so this doubles as the ownership check
  // — a subscription doc id that isn't theirs simply won't be found.
  const db = getFirestore(c.env);
  const path = `members/${uid}/subscriptions/${subId}`;
  const sub = await db.getDoc(path);
  if (!sub) {
    return c.json({ error: 'Subscription not found' }, 404);
  }
  if (sub.status !== 'active') {
    return c.json({ error: `Subscription is already ${sub.status}` }, 409);
  }

  try {
    const stripe = stripeClient(c.env);
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
  } catch (err) {
    console.error('Failed to cancel Stripe subscription:', subId, err);
    return c.json({ error: 'Could not cancel subscription' }, 500);
  }

  // Stripe keeps `status: "active"` until the period actually lapses — the
  // subscription doc reflects that too; customer.subscription.updated will
  // also fire and re-sync this same doc from Stripe.
  await db.patchDoc(path, {
    cancel_at_period_end: true,
    updated_at: new Date(),
  });

  return c.json({ success: true });
}

// =============================================================================
// POST /deactivate-account
// =============================================================================
export async function deactivateAccount(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const db = getFirestore(c.env);
  const stripe = stripeClient(c.env);

  // Pause billing on every active subscription and schedule it to actually
  // end at the current period boundary, without changing `status` and
  // without touching the purchases subcollection — the ledger stays intact,
  // only login + future charges + renewal stop. members/{uid} itself is
  // touched below, but only with the account_disabled / deactivated_at flags.
  const subscriptions = await db.listDocs(`members/${uid}/subscriptions`);
  const active = subscriptions.filter((s) => s.status === 'active');

  const now = new Date();
  let pauseFailed = false;
  for (const sub of active) {
    try {
      await stripe.subscriptions.update(sub._id, {
        // 'void' immediately voids any invoice generated while paused — no
        // charge, and nothing left uncollected/draft to reconcile later.
        // ('mark_uncollectible' still finalizes and flags an invoice;
        // 'keep_as_draft' leaves drafts accumulating — neither is "walk away
        // cleanly" the way 'void' is.)
        pause_collection: { behavior: 'void' },
        // Also stop it renewing — otherwise a paused-forever subscription
        // just sits "active" indefinitely with no invoices ever produced.
        cancel_at_period_end: true,
      });
      // Mirror both flags in Firestore so a later customer.subscription.updated
      // re-sync (which reads cancel_at_period_end straight from Stripe) agrees
      // with what we just wrote instead of clobbering it back to false.
      await db.patchDoc(`members/${uid}/subscriptions/${sub._id}`, {
        paused: true,
        paused_at: now,
        cancel_at_period_end: true,
      });
    } catch (err) {
      pauseFailed = true;
      console.error('Failed to pause subscription', sub._id, 'for', uid, err);
    }
  }
  if (pauseFailed) {
    // Don't lock the account out of billing control if a pause failed.
    return c.json({ error: 'Could not deactivate account' }, 500);
  }

  try {
    await db.disableAuthUser(uid);
    // So the admin panel can list active/deactivated members from a plain
    // Firestore read instead of calling Identity Toolkit's lookup API.
    await db.patchDoc(`members/${uid}`, {
      account_disabled: true,
      deactivated_at: now,
    });
  } catch (err) {
    console.error('Failed to disable Firebase Auth user:', uid, err);
    return c.json({ error: 'Could not deactivate account' }, 500);
  }

  return c.json({ success: true });
}

// =============================================================================
// POST /admin/gift-membership
// =============================================================================
export async function giftMembership(c: Ctx): Promise<Response> {
  const admin = c.get('user');
  const adminUid = admin.sub;
  if (!adminUid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: {
    target_uid?: unknown;
    price_id?: unknown;
    custom_expiration?: unknown;
    mailing_address?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetUid = body.target_uid;
  if (typeof targetUid !== 'string' || !targetUid) {
    return c.json({ error: 'target_uid is required' }, 400);
  }
  const priceId = body.price_id;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    return c.json({ error: 'A valid price_id is required' }, 400);
  }
  const expirationInput = body.custom_expiration;
  const expiration =
    typeof expirationInput === 'string' || typeof expirationInput === 'number'
      ? new Date(expirationInput)
      : new Date(NaN);
  if (Number.isNaN(expiration.getTime())) {
    return c.json({ error: 'custom_expiration must be a valid date' }, 400);
  }

  const db = getFirestore(c.env);

  const member = await db.getDoc(`members/${targetUid}`);
  if (!member) {
    return c.json({ error: 'Member not found' }, 404);
  }

  const productDoc = await db.getDoc(`products/${priceId}`);
  if (!productDoc) {
    return c.json({ error: 'Unknown price_id' }, 400);
  }
  const product = readProduct(productDoc, priceId);

  const mailingAddress =
    product.requires_shipping && body.mailing_address && typeof body.mailing_address === 'object'
      ? (body.mailing_address as Record<string, unknown>)
      : null;

  const now = new Date();
  // Distinct id scheme from real purchases (doc id = checkout session id) —
  // there is no session, so this can't collide with one.
  const purchaseId = `gift_${targetUid}_${Date.now()}`;

  await db.patchDoc(`members/${targetUid}/purchases/${purchaseId}`, {
    price_id: priceId,
    product_name: product.name,
    amount: 0,
    currency: 'usd',
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    status: 'completed',
    tier_granted: product.tier_granted,
    coverage_start: now,
    coverage_end: expiration,
    requires_shipping: product.requires_shipping,
    mailing_address: mailingAddress,
    purchased_at: now,
    gifted_by: adminUid,
  });

  return c.json({ success: true, purchase_id: purchaseId });
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
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripe, db, event.data.object, c.env, waitUntil, event.id);
        break;

      case 'invoice.paid': {
        const subId = invoiceSubscriptionId(event.data.object);
        if (subId) await upsertSubscription(stripe, db, subId, {});
        break;
      }

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        const uid = session.client_reference_id || session.metadata?.firebase_uid;
        if (uid) {
          waitUntil(
            capturePosthogEvent(
              c.env,
              'payment_failed',
              uid,
              {
                failure_reason: 'async_payment_failed',
                price_id: session.metadata?.price_id ?? null,
              },
              event.id,
            ),
          );
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const uid = pi.metadata?.firebase_uid;
        if (uid) {
          waitUntil(
            capturePosthogEvent(
              c.env,
              'payment_failed',
              uid,
              {
                failure_reason:
                  pi.last_payment_error?.decline_code ??
                  pi.last_payment_error?.code ??
                  'card_declined',
                price_id: pi.metadata?.price_id ?? null,
              },
              event.id,
            ),
          );
        }
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
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  stripeEventId: string,
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

  // Read before the write below so a renewal's lapse can be measured against
  // whatever membership record already existed (this checkout always creates
  // a new purchase/subscription doc, so the prior one is never overwritten).
  const ref = session.metadata?.ref;
  const priorExpiration = ref === 'renewal' ? await latestExpiration(db, uid) : null;

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

  // Fired only after the Firestore write above succeeds — this must reflect
  // confirmed state, not attempted state.
  waitUntil(
    capturePosthogEvent(
      env,
      'payment_succeeded',
      uid,
      {
        price_id: priceId ?? null,
        mode: session.mode,
        amount: session.amount_total ?? 0,
        ...(ref ? { ref } : {}),
      },
      stripeEventId,
    ),
  );

  if (ref === 'renewal') {
    waitUntil(
      capturePosthogEvent(
        env,
        'renewal_completed',
        uid,
        {
          ...(priorExpiration
            ? { lapse_days: Math.floor((Date.now() - priorExpiration.getTime()) / 86_400_000) }
            : {}),
        },
        stripeEventId,
      ),
    );
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
export function uidFromName(name: string): string {
  const parts = name.split('/');
  const i = parts.indexOf('members');
  return i >= 0 ? (parts[i + 1] ?? '') : '';
}

// Latest coverage_end/current_period_end across everything this member already
// had before this checkout, used to measure a renewal's lapse. Any status is
// considered — a lapsed/expired record is exactly what we want to measure from.
async function latestExpiration(db: Firestore, uid: string): Promise<Date | null> {
  const [purchases, subscriptions] = await Promise.all([
    db.listDocs(`members/${uid}/purchases`),
    db.listDocs(`members/${uid}/subscriptions`),
  ]);

  let latest: number | null = null;
  for (const p of purchases) {
    if (typeof p.coverage_end !== 'string') continue;
    const t = Date.parse(p.coverage_end);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  for (const s of subscriptions) {
    if (typeof s.current_period_end !== 'string') continue;
    const t = Date.parse(s.current_period_end);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest);
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
