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
}

export interface MailingAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

/** `members/{uid}/purchases/{stripe_checkout_session_id}` — one-time payments. */
export interface Purchase {
  price_id: string | null;
  product_name: string;
  amount: number;
  currency: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  status: 'completed' | 'refunded';
  tier_granted: string;
  coverage_start: string;
  coverage_end: string;
  requires_shipping: boolean;
  mailing_address: MailingAddress | null;
  purchased_at: string;
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
