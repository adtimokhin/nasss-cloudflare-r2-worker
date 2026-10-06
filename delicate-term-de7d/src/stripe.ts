import Stripe from 'stripe';
import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore, type Firestore, type FirestoreDoc } from './firestore';
import { hasActiveMembership, hasIssueAccess, hasArticleAccess } from './membership';
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
// and webhook verification needs the SubtleCrypto provider. Exported for
// src/journalPricing.ts, which needs the same client for admin-driven
// Product/Price management — no reason to construct a second one.
export function stripeClient(env: Env): Stripe {
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

  let body: {
    price_id?: unknown;
    donation_amount?: unknown;
    ref?: unknown;
    wants_physical_journal?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const priceId = body.price_id;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    return c.json({ error: 'A valid price_id is required' }, 400);
  }

  // Defaults to true (opted in) when omitted, matching the member-doc field
  // it mirrors (src/types.ts Member.wants_physical_journal).
  const wantsPhysicalJournal = body.wants_physical_journal !== false;

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
        wants_physical_journal: String(wantsPhysicalJournal),
        ...(ref === 'renewal' ? { ref: 'renewal' } : {}),
      },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    };
    // The product may offer a physical copy, but the member's own
    // preference (checked at signup or anytime from account-details) decides
    // whether Stripe actually collects a shipping address for this purchase.
    const effectiveShipping = product.requires_shipping && wantsPhysicalJournal;
    if (effectiveShipping) {
      params.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
    }
    if (product.mode === 'payment') {
      params.customer_creation = 'always';
      // So a payment_intent.payment_failed event (a card decline) can
      // resolve back to the member — see the webhook's Case B handling.
      params.payment_intent_data = {
        metadata: { firebase_uid: uid, price_id: priceId, wants_physical_journal: String(wantsPhysicalJournal) },
      };
    } else {
      // So every later subscription.* event can resolve the member — and,
      // since wants_physical_journal is read back off the live Stripe
      // subscription in upsertSubscription (not just this creation call),
      // this metadata is what lets renewal/status-change events keep
      // computing the same effective shipping choice.
      params.subscription_data = {
        metadata: { firebase_uid: uid, price_id: priceId, wants_physical_journal: String(wantsPhysicalJournal) },
      };
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
// POST /create-issue-checkout-session
// Lets a member buy one specific published issue individually, using the
// price the admin wizard already created on that issue's own doc (src/
// journalPricing.ts) — no products/{price_id} lookup needed, unlike the
// membership flow above, since the Issue doc already carries everything a
// Checkout line item needs. Deliberately not gated by hasActiveMembership:
// an existing member buying one issue à la carte anyway is their call, not
// an error. handleCheckoutCompleted below records the result with
// Purchase.issue_slug set, which is what hasIssueAccess (src/membership.ts)
// checks to unlock GET /issues/:slug/pdf for just this one issue.
// =============================================================================
export async function createIssueCheckoutSession(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { issue_slug?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const issueSlug = body.issue_slug;
  if (typeof issueSlug !== 'string' || !issueSlug) {
    return c.json({ error: 'issue_slug is required' }, 400);
  }

  const db = getFirestore(c.env);
  const issue = await db.queryFirst('issues', [
    ['slug', issueSlug],
    ['published', true],
  ]);
  if (!issue) {
    return c.json({ error: 'Issue not found' }, 404);
  }
  if (!issue.price_id) {
    return c.json({ error: 'This issue is not sold individually' }, 400);
  }

  if (await hasIssueAccess(db, uid, issueSlug)) {
    return c.json({ error: 'You already have access to this issue.' }, 409);
  }

  try {
    const stripe = stripeClient(c.env);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: issue.price_id, quantity: 1 }],
      customer_email: typeof user.email === 'string' ? user.email : undefined,
      client_reference_id: uid,
      customer_creation: 'always',
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: { firebase_uid: uid, purchase_type: 'issue', issue_slug: issueSlug, price_id: issue.price_id },
      // So a payment_intent.payment_failed event can resolve back to the
      // member — mirrors createCheckoutSession above.
      payment_intent_data: {
        metadata: { firebase_uid: uid, purchase_type: 'issue', issue_slug: issueSlug },
      },
      success_url: `https://www.serbianstudies.org/journal-preview?slug=${encodeURIComponent(issueSlug)}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://www.serbianstudies.org/journal-preview?slug=${encodeURIComponent(issueSlug)}&checkout=cancelled`,
    });
    return c.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Failed to create issue Checkout session:', err);
    c.executionCtx.waitUntil(
      capturePosthogEvent(c.env, 'payment_failed', uid, {
        failure_reason: 'session_creation_failed',
        issue_slug: issueSlug,
      }),
    );
    return c.json({ error: 'Could not start checkout' }, 500);
  }
}

// =============================================================================
// POST /create-article-checkout-session
// Same shape as POST /create-issue-checkout-session above, scoped to one
// article's own price instead of the issue's. Not gated by hasActiveMembership
// or hasIssueAccess — buying one article individually is independent of
// membership status (a member can still buy an article à la carte, same as
// an issue). Only blocked if hasArticleAccess already says yes (covers full-
// issue ownership, a prior direct purchase, or a bundled grant).
// =============================================================================
export async function createArticleCheckoutSession(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { issue_slug?: unknown; article_slug?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const issueSlug = body.issue_slug;
  const articleSlug = body.article_slug;
  if (typeof issueSlug !== 'string' || !issueSlug) {
    return c.json({ error: 'issue_slug is required' }, 400);
  }
  if (typeof articleSlug !== 'string' || !articleSlug) {
    return c.json({ error: 'article_slug is required' }, 400);
  }

  const db = getFirestore(c.env);
  const issue = await db.queryFirst('issues', [
    ['slug', issueSlug],
    ['published', true],
  ]);
  if (!issue) {
    return c.json({ error: 'Issue not found' }, 404);
  }

  const articles = Array.isArray(issue.articles) ? issue.articles : [];
  const article = articles.find((a: { slug?: unknown }) => a.slug === articleSlug);
  if (!article) {
    return c.json({ error: 'Article not found' }, 404);
  }
  if (!article.price_id) {
    return c.json({ error: 'This article is not sold individually' }, 400);
  }

  if (await hasArticleAccess(db, uid, issueSlug, articleSlug)) {
    return c.json({ error: 'You already have access to this article.' }, 409);
  }

  try {
    const stripe = stripeClient(c.env);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: article.price_id, quantity: 1 }],
      customer_email: typeof user.email === 'string' ? user.email : undefined,
      client_reference_id: uid,
      customer_creation: 'always',
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: {
        firebase_uid: uid,
        purchase_type: 'article',
        issue_slug: issueSlug,
        article_slug: articleSlug,
        price_id: article.price_id,
      },
      // So a payment_intent.payment_failed event can resolve back to the
      // member — mirrors createCheckoutSession above.
      payment_intent_data: {
        metadata: { firebase_uid: uid, purchase_type: 'article', issue_slug: issueSlug, article_slug: articleSlug },
      },
      success_url: `https://www.serbianstudies.org/article-preview?issue=${encodeURIComponent(issueSlug)}&article=${encodeURIComponent(articleSlug)}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://www.serbianstudies.org/article-preview?issue=${encodeURIComponent(issueSlug)}&article=${encodeURIComponent(articleSlug)}&checkout=cancelled`,
    });
    return c.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Failed to create article Checkout session:', err);
    c.executionCtx.waitUntil(
      capturePosthogEvent(c.env, 'payment_failed', uid, {
        failure_reason: 'session_creation_failed',
        issue_slug: issueSlug,
        article_slug: articleSlug,
      }),
    );
    return c.json({ error: 'Could not start checkout' }, 500);
  }
}

// =============================================================================
// POST /create-donation-checkout-session
// A standalone donation, independent of membership — any signed-in member
// can donate without buying or already holding a membership (unlike
// createCheckoutSession above, this never checks hasActiveMembership).
// Used by both the compact donation box on new-membership.html and the
// dedicated donate.html page; `return_path` lets each send the member back
// to itself after Stripe redirects back, same pattern as every other
// checkout flow in this file returning to the page that started it.
// =============================================================================
const DONATION_MIN_CENTS = 100; // $1.00 — a sane floor, well above Stripe's own minimum charge

export async function createDonationCheckoutSession(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { amount?: unknown; return_path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < DONATION_MIN_CENTS) {
    return c.json({ error: `amount must be an integer number of cents, at least ${DONATION_MIN_CENTS}` }, 400);
  }

  const returnPath =
    typeof body.return_path === 'string' && body.return_path.startsWith('/') ? body.return_path : '/donate';

  try {
    const stripe = stripeClient(c.env);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Donation to NASSS' },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      customer_email: typeof user.email === 'string' ? user.email : undefined,
      client_reference_id: uid,
      customer_creation: 'always',
      metadata: { firebase_uid: uid, purchase_type: 'donation' },
      payment_intent_data: {
        metadata: { firebase_uid: uid, purchase_type: 'donation' },
      },
      success_url: `https://www.serbianstudies.org${returnPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://www.serbianstudies.org${returnPath}?checkout=cancelled`,
    });
    return c.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Failed to create donation Checkout session:', err);
    c.executionCtx.waitUntil(
      capturePosthogEvent(c.env, 'payment_failed', uid, { failure_reason: 'session_creation_failed', donation: true }),
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
// Shared: immediately cancel every not-yet-canceled Stripe subscription for a
// member. Used by deactivateAccount, deleteAccount (below), and blockMember
// (src/admin.ts) — any path that ends the member's access should also stop
// billing right away rather than leaving a subscription to run out or rely
// on a later manual cancellation.
//
// Stripe's own `subscriptions.cancel` is immediate (unlike
// `cancel_at_period_end: true`, which just stops renewal) — billing stops
// now and the subscription's Stripe status becomes "canceled" right away.
// The Firestore doc is patched optimistically to match; the
// customer.subscription.deleted webhook will also fire and re-confirm it.
// =============================================================================
export async function cancelActiveSubscriptions(env: Env, uid: string): Promise<boolean> {
  const db = getFirestore(env);
  const stripe = stripeClient(env);

  const subscriptions = await db.listDocs(`members/${uid}/subscriptions`);
  const cancelable = subscriptions.filter((s) => s.status !== 'canceled');

  const now = new Date();
  let allSucceeded = true;
  for (const sub of cancelable) {
    try {
      await stripe.subscriptions.cancel(sub._id);
      await db.patchDoc(`members/${uid}/subscriptions/${sub._id}`, {
        status: 'canceled',
        cancel_at_period_end: false,
        canceled_at: now,
        updated_at: now,
      });
    } catch (err) {
      allSucceeded = false;
      console.error('Failed to cancel subscription', sub._id, 'for', uid, err);
    }
  }
  return allSucceeded;
}

// =============================================================================
// POST /deactivate-account
// =============================================================================
export async function deactivateAccount(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const db = getFirestore(c.env);

  const allSucceeded = await cancelActiveSubscriptions(c.env, uid);
  if (!allSucceeded) {
    // Don't lock the account out of billing control if cancellation failed.
    return c.json({ error: 'Could not deactivate account' }, 500);
  }

  try {
    await db.disableAuthUser(uid);
    // So the admin panel can list active/deactivated members from a plain
    // Firestore read instead of calling Identity Toolkit's lookup API.
    await db.patchDoc(`members/${uid}`, {
      account_disabled: true,
      deactivated_at: new Date(),
    });
  } catch (err) {
    console.error('Failed to disable Firebase Auth user:', uid, err);
    return c.json({ error: 'Could not deactivate account' }, 500);
  }

  return c.json({ success: true });
}

// =============================================================================
// POST /delete-account
// =============================================================================
// Self-service, permanent: cancels billing immediately (same helper as
// deactivateAccount/blockMember) and permanently deletes the Firebase Auth
// user — not just disables it, so the identity can never sign in again.
// Deliberately does NOT delete members/{uid} or its purchases/subscriptions
// subcollections: that's the financial ledger the admin panel's payment
// history reads from, and accounting/audit needs it to survive the account
// itself being gone. The member doc is instead flagged account_deleted so
// admin views (and authMiddleware, if ever queried for a deleted uid) can
// tell the difference from a merely-disabled account.
export async function deleteAccount(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const db = getFirestore(c.env);

  const allSucceeded = await cancelActiveSubscriptions(c.env, uid);
  if (!allSucceeded) {
    return c.json({ error: 'Could not delete account' }, 500);
  }

  try {
    await db.deleteAuthUser(uid);
    await db.patchDoc(`members/${uid}`, {
      account_deleted: true,
      deleted_at: new Date(),
    });
  } catch (err) {
    console.error('Failed to delete Firebase Auth user:', uid, err);
    return c.json({ error: 'Could not delete account' }, 500);
  }

  return c.json({ success: true });
}

// =============================================================================
// POST /admin/gift-membership
// =============================================================================
// Thrown by applyGift on bad input — carries the HTTP status the original
// single-gift endpoint used to return for that same condition, so
// giftMembership below can reproduce it exactly while the bulk importer
// (src/admin.ts importMembers) can instead catch it per-row and keep going.
export class GiftError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = 'GiftError';
  }
}

export interface GiftInput {
  grant_type?: unknown;
  price_id?: unknown;
  custom_expiration?: unknown;
  wants_physical_journal?: unknown;
  mailing_address?: unknown;
  issue_slug?: unknown;
  article_slug?: unknown;
}

/**
 * Grants `gift` to `targetUid` with no Stripe checkout involved — the same
 * no-payment Purchase-doc write giftMembership (the single-member HTTP
 * endpoint) has always done, factored out so the bulk member importer
 * (POST /admin/import-members, src/admin.ts) can apply the exact same
 * gift shapes to freshly-created members without going through HTTP.
 * Throws GiftError on invalid input or a not-found issue/article/price —
 * callers decide whether that aborts the whole request or just this one gift.
 */
export async function applyGift(
  db: Firestore,
  targetUid: string,
  gift: GiftInput,
  adminUid: string,
): Promise<{ purchase_id: string }> {
  // Defaults to 'membership' so this stays backward-compatible with the
  // original single-purpose shape (just price_id/custom_expiration).
  const grantType = typeof gift.grant_type === 'string' ? gift.grant_type : 'membership';

  if (grantType === 'issue' || grantType === 'article') {
    const issueSlug = gift.issue_slug;
    if (typeof issueSlug !== 'string' || !issueSlug) {
      throw new GiftError('issue_slug is required');
    }
    const issue = await db.getDoc(`issues/${issueSlug}`);
    if (!issue) {
      throw new GiftError('Issue not found', 404);
    }

    let articleSlug: string | null = null;
    let productName = `${issue.title ?? issueSlug} — Single Issue (Gifted)`;
    if (grantType === 'article') {
      const rawArticleSlug = gift.article_slug;
      if (typeof rawArticleSlug !== 'string' || !rawArticleSlug) {
        throw new GiftError('article_slug is required');
      }
      const articles = Array.isArray(issue.articles) ? issue.articles : [];
      const article = articles.find((a: { slug?: unknown }) => a.slug === rawArticleSlug);
      if (!article) {
        throw new GiftError('Article not found', 404);
      }
      articleSlug = rawArticleSlug;
      productName = `${article.title} — Single Article (Gifted)`;
    }

    const now = new Date();
    // Distinct id scheme from real purchases (doc id = checkout session id) —
    // there is no session, so this can't collide with one.
    const purchaseId = `gift_${targetUid}_${Date.now()}`;

    await db.patchDoc(`members/${targetUid}/purchases/${purchaseId}`, {
      price_id: null,
      product_name: productName,
      amount: 0,
      currency: 'usd',
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      status: 'completed',
      tier_granted: 'single-issue',
      issue_slug: issueSlug,
      article_slug: articleSlug,
      coverage_start: now,
      coverage_end: permanentCoverageEnd(now),
      requires_shipping: false,
      mailing_address: null,
      purchased_at: now,
      gifted_by: adminUid,
    });

    // Gifting the whole issue bundles its currently-individually-priced
    // articles too — same reasoning as the real-purchase path in
    // handleIssuePurchaseCompleted below. Not run for grantType === 'article'
    // (that's already scoped to exactly one article).
    if (grantType === 'issue') {
      await grantBundledArticles(db, targetUid, issueSlug, issue, purchaseId, now);
    }

    return { purchase_id: purchaseId };
  }

  if (grantType !== 'membership') {
    throw new GiftError(`Unknown grant_type: ${grantType}`);
  }

  const priceId = gift.price_id;
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    throw new GiftError('A valid price_id is required');
  }
  const expirationInput = gift.custom_expiration;
  const expiration =
    typeof expirationInput === 'string' || typeof expirationInput === 'number'
      ? new Date(expirationInput)
      : new Date(NaN);
  if (Number.isNaN(expiration.getTime())) {
    throw new GiftError('custom_expiration must be a valid date');
  }

  const productDoc = await db.getDoc(`products/${priceId}`);
  if (!productDoc) {
    throw new GiftError('Unknown price_id');
  }
  const product = readProduct(productDoc, priceId);

  // Mirrors the real checkout flow's effectiveShipping (handleCheckoutCompleted
  // above): the product merely supporting a physical copy isn't enough on its
  // own — the admin must have actually opted in for *this* gift via the
  // "Ship the physical journal?" checkbox, same as a member opting in
  // themselves at checkout. Without this, every gift of a shippable product
  // was unconditionally marked requires_shipping:true regardless of whether
  // an address was even given.
  const wantsPhysicalJournal = gift.wants_physical_journal === true;
  const effectiveShipping = product.requires_shipping && wantsPhysicalJournal;
  const mailingAddress =
    effectiveShipping && gift.mailing_address && typeof gift.mailing_address === 'object'
      ? (gift.mailing_address as Record<string, unknown>)
      : null;

  const now = new Date();
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
    requires_shipping: effectiveShipping,
    mailing_address: mailingAddress,
    purchased_at: now,
    gifted_by: adminUid,
  });

  return { purchase_id: purchaseId };
}

export async function giftMembership(c: Ctx): Promise<Response> {
  const admin = c.get('user');
  const adminUid = admin.sub;
  if (!adminUid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { target_uid?: unknown } & GiftInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetUid = body.target_uid;
  if (typeof targetUid !== 'string' || !targetUid) {
    return c.json({ error: 'target_uid is required' }, 400);
  }

  const db = getFirestore(c.env);

  const member = await db.getDoc(`members/${targetUid}`);
  if (!member) {
    return c.json({ error: 'Member not found' }, 404);
  }

  try {
    const result = await applyGift(db, targetUid, body, adminUid);
    return c.json({ success: true, purchase_id: result.purchase_id });
  } catch (err) {
    if (err instanceof GiftError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
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

  // Individual-issue purchases (POST /create-issue-checkout-session) don't
  // go through products/{price_id} at all — the Issue doc already has
  // everything needed — so this branches off before any of the
  // membership-product logic below, which would otherwise fall back to a
  // generic 365-day "standard" grant with no issue_slug.
  if (session.metadata?.purchase_type === 'issue') {
    await handleIssuePurchaseCompleted(db, session, uid, env, waitUntil, stripeEventId);
    return;
  }
  // Individual-article purchases (POST /create-article-checkout-session) —
  // same reasoning as the issue branch above, just scoped to one article.
  if (session.metadata?.purchase_type === 'article') {
    await handleArticlePurchaseCompleted(db, session, uid, env, waitUntil, stripeEventId);
    return;
  }
  // Standalone donations (POST /create-donation-checkout-session) — a
  // donation grants no access to anything, so it never touches
  // products/{price_id} either.
  if (session.metadata?.purchase_type === 'donation') {
    await handleDonationCompleted(db, session, uid, env, waitUntil, stripeEventId);
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

  const wantsPhysicalJournal = session.metadata?.wants_physical_journal !== 'false';
  const effectiveShipping = product.requires_shipping && wantsPhysicalJournal;

  if (session.mode === 'payment') {
    const start = new Date();
    const days = product.coverage_days ?? 365;
    const end = new Date(start.getTime() + days * 86_400_000);
    const mailingAddress = effectiveShipping && shipping?.address ? plainAddress(shipping.address) : null;

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
      requires_shipping: effectiveShipping,
      mailing_address: mailingAddress,
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
 * ~100 years out — a practical "permanent" marker reused by every
 * individual-issue/article grant (real purchase or admin gift): there's no
 * coverage_days concept for owning one outright, and this lets them reuse
 * the existing coverage_end > now check (hasIssueAccess, src/membership.ts)
 * rather than inventing a separate "permanent: true" field every access-check
 * and admin view would need to special-case.
 */
function permanentCoverageEnd(start: Date): Date {
  return new Date(start.getTime() + 100 * 365 * 86_400_000);
}

/**
 * Auto-grants every currently-individually-priced article in `issue` to
 * `uid` whenever they come to own the whole issue outright (a real purchase
 * via POST /create-issue-checkout-session, or an admin gift with
 * grant_type 'issue') — owning the full issue already includes its
 * articles, so without this a member who only ever bought the issue would
 * show as not owning an article that's separately for sale, which will
 * matter the moment article-level content gating is built (see the
 * article_slug comment on the Purchase type in types.ts). Each grant is its
 * own Purchase doc, keyed off `parentPurchaseId` so it can never collide
 * with a genuine standalone purchase/gift of the same article. Articles
 * added to the issue, or priced, after this runs are not retroactively
 * granted — this only runs at the moment the issue itself is purchased/gifted.
 */
async function grantBundledArticles(
  db: Firestore,
  uid: string,
  issueSlug: string,
  issue: FirestoreDoc | null,
  parentPurchaseId: string,
  start: Date,
): Promise<void> {
  const articles = Array.isArray(issue?.articles)
    ? (issue!.articles as Array<Record<string, unknown>>)
    : [];
  const pricedArticles = articles.filter(
    (article) => typeof article.price_id === 'string' && article.price_id,
  );
  if (pricedArticles.length === 0) return;

  const end = permanentCoverageEnd(start);
  await Promise.all(
    pricedArticles.map((article) =>
      db.patchDoc(`members/${uid}/purchases/${parentPurchaseId}_article_${article.slug}`, {
        price_id: null,
        product_name: `${article.title} — Single Article (Included with Issue Purchase)`,
        amount: 0,
        currency: 'usd',
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
        status: 'completed',
        tier_granted: 'single-issue',
        issue_slug: issueSlug,
        article_slug: article.slug,
        coverage_start: start,
        coverage_end: end,
        requires_shipping: false,
        mailing_address: null,
        purchased_at: start,
      }),
    ),
  );
}

/**
 * Records an individual issue purchase from POST /create-issue-checkout-session.
 * There's no coverage_days concept for owning one issue outright, so
 * coverage_end is set ~100 years out — a practical "permanent" marker that
 * reuses the existing coverage_end > now check (hasIssueAccess, src/membership.ts)
 * rather than inventing a separate "permanent: true" field every access-check
 * and admin view would need to special-case.
 */
async function handleIssuePurchaseCompleted(
  db: Firestore,
  session: Stripe.Checkout.Session,
  uid: string,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  stripeEventId: string,
): Promise<void> {
  const issueSlug = session.metadata?.issue_slug;
  if (!issueSlug) {
    console.warn('Issue checkout.session.completed without an issue_slug:', session.id);
    return;
  }

  const issue = await db.getDoc(`issues/${issueSlug}`);
  const start = new Date();
  const end = permanentCoverageEnd(start);

  await db.patchDoc(`members/${uid}/purchases/${session.id}`, {
    price_id: session.metadata?.price_id ?? null,
    product_name: issue?.title ? `${issue.title} — Single Issue Purchase` : 'Single Issue Purchase',
    amount: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    status: 'completed',
    tier_granted: 'single-issue',
    issue_slug: issueSlug,
    coverage_start: start,
    coverage_end: end,
    requires_shipping: false,
    mailing_address: null,
    purchased_at: start,
  });

  await grantBundledArticles(db, uid, issueSlug, issue, session.id, start);

  waitUntil(
    capturePosthogEvent(
      env,
      'payment_succeeded',
      uid,
      { mode: 'payment', amount: session.amount_total ?? 0, issue_slug: issueSlug },
      stripeEventId,
    ),
  );
}

/**
 * Records an individual article purchase from POST /create-article-checkout-session.
 * Same ~100-year "permanent" coverage_end reasoning as handleIssuePurchaseCompleted
 * above. Unlike that one, this never calls grantBundledArticles — buying a
 * single article doesn't grant anything beyond itself.
 */
async function handleArticlePurchaseCompleted(
  db: Firestore,
  session: Stripe.Checkout.Session,
  uid: string,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  stripeEventId: string,
): Promise<void> {
  const issueSlug = session.metadata?.issue_slug;
  const articleSlug = session.metadata?.article_slug;
  if (!issueSlug || !articleSlug) {
    console.warn('Article checkout.session.completed without issue_slug/article_slug:', session.id);
    return;
  }

  const issue = await db.getDoc(`issues/${issueSlug}`);
  const articles = Array.isArray(issue?.articles) ? (issue!.articles as Array<Record<string, unknown>>) : [];
  const article = articles.find((a) => a.slug === articleSlug);
  const start = new Date();
  const end = permanentCoverageEnd(start);

  await db.patchDoc(`members/${uid}/purchases/${session.id}`, {
    price_id: session.metadata?.price_id ?? null,
    product_name: article?.title ? `${article.title} — Single Article Purchase` : 'Single Article Purchase',
    amount: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    status: 'completed',
    tier_granted: 'single-issue',
    issue_slug: issueSlug,
    article_slug: articleSlug,
    coverage_start: start,
    coverage_end: end,
    requires_shipping: false,
    mailing_address: null,
    purchased_at: start,
  });

  waitUntil(
    capturePosthogEvent(
      env,
      'payment_succeeded',
      uid,
      { mode: 'payment', amount: session.amount_total ?? 0, issue_slug: issueSlug, article_slug: articleSlug },
      stripeEventId,
    ),
  );
}

/**
 * Records a standalone donation from POST /create-donation-checkout-session.
 * Unlike every other purchase type, this grants no access to anything, so
 * coverage_end is deliberately left null rather than set to any date (past
 * or future) — hasActiveMembership/findActiveMembershipDoc (src/membership.ts)
 * and every client-side copy of that same "is this an active membership"
 * check (new-membership.html, account-details.html, the admin shipping CSV)
 * all gate on coverage_end being a parseable future date, so a null one is
 * excluded everywhere automatically, with no extra exclusion logic needed —
 * the same category of bug the issue_slug exclusion above was written to fix
 * doesn't get a chance to happen here in the first place.
 */
async function handleDonationCompleted(
  db: Firestore,
  session: Stripe.Checkout.Session,
  uid: string,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  stripeEventId: string,
): Promise<void> {
  const start = new Date();

  await db.patchDoc(`members/${uid}/purchases/${session.id}`, {
    price_id: null,
    product_name: 'Donation',
    amount: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    status: 'completed',
    tier_granted: 'donation',
    coverage_start: start,
    coverage_end: null,
    requires_shipping: false,
    mailing_address: null,
    purchased_at: start,
  });

  waitUntil(
    capturePosthogEvent(
      env,
      'donation_completed',
      uid,
      { amount: session.amount_total ?? 0 },
      stripeEventId,
    ),
  );
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

  // Read off the live Stripe subscription's own metadata (set at creation in
  // createCheckoutSession) rather than `opts`, so later events like
  // customer.subscription.updated — which don't have the original checkout
  // request — still compute the same effective shipping choice.
  const wantsPhysicalJournal = sub.metadata?.wants_physical_journal !== 'false';
  const effectiveShipping = product.requires_shipping && wantsPhysicalJournal;

  const fields: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    price_id: priceId,
    status: sub.status,
    tier_granted: product.tier_granted,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    requires_shipping: effectiveShipping,
    created_at: new Date(sub.created * 1000),
    updated_at: new Date(),
  };
  // Only touch mailing_address when we actually have one in hand (checkout), so
  // renewals / status changes never blank it.
  if (effectiveShipping && opts.shipping?.address) {
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
