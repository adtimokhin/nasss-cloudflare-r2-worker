export interface Env {
  PDFS: R2Bucket;
  // Paywall access cache (positive results only) — see src/paywall.ts.
  MEMBERSHIP_CACHE: KVNamespace;
  FIREBASE_PROJECT_ID: string;
  // Service-account credentials — also used to sign privileged Firestore writes.
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  ALLOWED_ORIGIN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // PostHog server-side capture — see src/posthog.ts.
  POSTHOG_API_KEY: string;
  POSTHOG_HOST: string;
  // Resend transactional email — see src/renewal.ts. Requires a verified
  // sending domain in the Resend account.
  RESEND_API_KEY: string;
  // This Worker's own public base URL (custom domain or *.workers.dev), used
  // to build the /renewal-redirect link sent in renewal-reminder emails.
  WORKER_BASE_URL: string;
}

// -----------------------------------------------------------------------------
// Firestore document shapes (reference — the REST client works with plain maps).
// Timestamps are ISO-8601 strings on read, written from `Date` instances.
// -----------------------------------------------------------------------------

/**
 * `members/{uid}` — identity only. Whether a member currently has access is
 * derived at read time from the purchases/subscriptions subcollections below,
 * not cached here.
 */
export interface Member {
  name: string;
  email: string;
  role: 'admin' | null;
  createdAt: string;
  // Set by POST /deactivate-account, alongside disabling the Firebase Auth
  // user. Lets the admin panel list active/deactivated members from a plain
  // Firestore read instead of calling Identity Toolkit's lookup API.
  account_disabled?: boolean;
  deactivated_at?: string;
  // Set by the renewal-reminder cron (src/renewal.ts) once an email goes out.
  // `last_renewal_reminder_expiration` is the coverage_end/current_period_end
  // the reminder was about, so a later run doesn't re-send for the same cycle.
  last_renewal_reminder_sent?: string;
  last_renewal_reminder_expiration?: string;
}

export interface MailingAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

/**
 * `members/{uid}/purchases/{purchaseId}` — one-time payments. Doc id is the
 * Stripe checkout session id for a real purchase, or `gift_{uid}_{ts}` for
 * one granted by an admin via POST /admin/gift-membership (which also sets
 * `stripe_checkout_session_id`/`stripe_payment_intent_id` to null and
 * `amount` to 0, and adds `gifted_by`).
 */
export interface Purchase {
  price_id: string | null;
  product_name: string;
  amount: number;
  currency: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  status: 'completed' | 'refunded';
  tier_granted: string;
  coverage_start: string;
  coverage_end: string;
  requires_shipping: boolean;
  mailing_address: MailingAddress | null;
  purchased_at: string;
  gifted_by?: string;
}

/** `members/{uid}/subscriptions/{stripe_subscription_id}` — recurring memberships. */
export interface Subscription {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  price_id: string | null;
  status: 'active' | 'canceled' | 'past_due' | 'incomplete';
  tier_granted: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  requires_shipping: boolean;
  mailing_address?: MailingAddress | null;
  // Set by POST /deactivate-account. Billing is paused (Stripe
  // pause_collection: void) but `status` is left as "active" — the
  // subscription is not canceled, just not being charged.
  paused?: boolean;
  paused_at?: string;
  created_at: string;
  updated_at: string;
}

/** `products/{price_id}` — admin-managed config read at checkout + webhook time. */
export interface Product {
  name: string;
  mode: 'payment' | 'subscription';
  tier_granted: string;
  requires_shipping: boolean;
  coverage_days: number | null;
}

/** `issues/{slug}` — journal issue metadata. */
export interface Issue {
  slug: string;
  issue_number: number;
  issue_date: string;
  title: string | null;
  pdf_object_key: string;
  published: boolean;
  updated_at: string;
}
