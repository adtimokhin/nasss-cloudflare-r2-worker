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
  // Set by POST /admin/block-member — an admin-initiated block, distinct
  // from account_disabled (self-service deactivation) above. Reversed by
  // POST /admin/unblock-member. Enforced immediately in authMiddleware
  // (src/auth.ts) rather than relying on Firebase Auth's disableUser alone,
  // since an already-issued ID token stays valid until it naturally expires.
  blocked?: boolean;
  blocked_at?: string;
  blocked_by?: string;
  // Set by POST /delete-account (self-service, permanent). The Firebase Auth
  // user is actually deleted (not just disabled) — this doc and its
  // purchases/subscriptions subcollections are kept as the financial ledger.
  account_deleted?: boolean;
  deleted_at?: string;
  // Pre-checkout preference only: what new-membership.html should pre-check
  // the "mail me a physical copy" box with, before the member has an active
  // purchase/subscription doc to read that from. Written directly by the
  // Squarespace frontend via the Firestore client SDK, like `name`;
  // undefined is treated as true (opted in), since the physical copy was
  // previously unconditional. Not read by this Worker — new-membership.html
  // sends the actual checkout-time choice explicitly in the
  // POST /create-checkout-session body instead of this Worker reading it
  // back off Firestore.
  //
  // Once a member has an active purchase or subscription, that record's own
  // `requires_shipping` / `mailing_address` (see Purchase / Subscription
  // below) is the source of truth for whether they currently receive the
  // physical journal — account-details.html edits those directly rather
  // than this field, and there is deliberately no separate cached address
  // on this doc (same "derive at read time, don't cache on members" pattern
  // as membership status itself — see src/membership.ts).
  wants_physical_journal?: boolean;
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
  // Set for an individual-issue or individual-article purchase/gift (POST
  // /create-issue-checkout-session or POST /admin/gift-membership with
  // grant_type 'issue'/'article' — src/stripe.ts) — null/absent for an
  // ordinary membership purchase. `tier_granted` is 'single-issue' and
  // `coverage_end` is set ~100 years out (there's no real expiry concept for
  // owning one issue/article) whenever this is set. hasIssueAccess
  // (src/membership.ts) checks this field to unlock GET /issues/:slug/pdf
  // for just this one issue, without requiring a membership. Also set
  // (alongside article_slug) on an article-scoped grant, so an article
  // purchase/gift is always attributable to its parent issue too.
  issue_slug?: string | null;
  // Set only for an individual-ARTICLE purchase/gift — issue_slug above is
  // also set on the same doc (the parent issue). There's currently no
  // separate gated article content (see article-preview.html) for this to
  // unlock — it exists for financial record-keeping and so the schema is
  // ready once/if article-level content gating is built.
  //
  // Also set, with amount:0 and no gifted_by, on the extra doc(s)
  // grantBundledArticles (src/stripe.ts) auto-creates alongside a real
  // issue purchase or an admin issue-gift: buying/gifting the whole issue
  // bundles every article in it that's *currently* individually priced, so
  // a member never shows as not owning an article they already paid for as
  // part of the issue. Doc id is `${parentPurchaseId}_article_${slug}`,
  // distinct from both a real article purchase (session id) and an admin
  // article-gift (`gift_{uid}_{ts}`), so it can never collide with one.
  article_slug?: string | null;
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
  // Set by cancelActiveSubscriptions (src/stripe.ts) — immediate cancellation,
  // as opposed to cancel_at_period_end letting the current period finish.
  canceled_at?: string;
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

/**
 * One entry in an issue's table of contents, embedded in `Issue.articles`
 * below rather than its own subcollection — these are small, admin-authored
 * records with no independent lifecycle (nothing writes to them the way the
 * Stripe webhook writes to purchases/subscriptions), so a subcollection
 * would only cost every public page view an extra read for no benefit.
 */
export interface Article {
  // Unique within this issue's `articles` array only, not globally like
  // Issue.slug. Identifies the article in GET /issues/:slug/articles/:slug
  // and in article-preview.html's ?article= query param.
  slug: string;
  title: string;
  authors: string[];
  // Groups rows under a heading in the ToC (e.g. "Articles", "Book
  // Reviews"). Free text, not an enum — the set of sections varies by issue.
  // The ToC is rendered in `articles` array order, grouped by consecutive
  // runs of the same section — there's no separate position field, since
  // any reorder already has to rewrite this whole array (Firestore has no
  // partial-array patch), so a second ordering field would just be a
  // second source of truth to keep in sync with the array itself.
  section: string;
  // Null/absent → article-preview.html hides the Abstract section entirely.
  abstract?: string | null;
  // R2 key for this article's own preview PDF, distinct from the issue's
  // full paywalled PDF. Set by POST /admin/issues/:slug/articles/:slug/preview-pdf.
  // Null/absent → GET .../preview-pdf 404s and the frontend shows a
  // "preview not available" placeholder instead of fetching anything.
  // Every article in the ToC gets a working article-preview.html link —
  // there's no separate "has a preview page" flag to keep in sync with this
  // one; whether there's anything to show there is exactly what this field
  // already answers.
  preview_pdf_object_key?: string | null;
  // R2 key for this article's own FULL PDF — distinct from
  // preview_pdf_object_key above (first pages only, publicly viewable) and
  // from the issue's own pdf_object_key (the whole issue, every article
  // included). Set by POST /admin/issues/:slug/articles/:slug/pdf. Null/
  // absent → GET /issues/:slug/articles/:slug/pdf 404s / returns the same
  // "authenticated but not yet uploaded" placeholder shape as the issue-level
  // pdf_object_key flow (GET /issues/:slug/pdf, src/index.ts). Gated by
  // hasArticleAccess (src/membership.ts) — full-issue access unlocks this
  // too, same as every other article in the issue.
  pdf_object_key?: string | null;
  // Stripe Product this article's one-time price belongs to. Created
  // automatically by POST /admin/issues/:slug/articles/:slug/price the first
  // time the article is priced, then reused on every later price change
  // (Stripe Prices are immutable — "changing the price" mints a new Price
  // under this same Product and archives the old one; see src/journalPricing.ts).
  // Null until the article has ever been sold individually.
  stripe_product_id?: string | null;
  // Stripe price id for buying this one article. Null when it isn't sold
  // individually — article-preview.html then hides its "Purchase" button.
  // IMPORTANT: once set, admin-pannel.html blocks removing this article from
  // the issue's table of contents (a member may have already bought it on
  // its own) — editing it, including changing the price, stays allowed.
  price_id: string | null;
  // Denormalized display price kept alongside price_id so this public,
  // unauthenticated page can render "$5" without a live Stripe lookup on
  // every anonymous view. Null exactly when price_id is null.
  price_cents: number | null;
  currency: string | null; // e.g. "usd"
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
  // Set by POST /admin/issues/:slug/cover — not in the original schema
  // but already read (GET /issues) and written (that handler) elsewhere,
  // so documented here for completeness.
  cover_image_url?: string | null;
  // R2 key for the issue-level preview PDF (first few pages, publicly
  // viewable) — distinct from pdf_object_key, which is the full, paywalled
  // issue and must never be served to a logged-out visitor. Set by
  // POST /admin/issues/:slug/preview-pdf. Null/absent → GET
  // /issues/:slug/preview-pdf 404s and the frontend shows a "preview not
  // available" placeholder instead of fetching anything.
  preview_pdf_object_key?: string | null;
  // Stripe Product this issue's one-time price belongs to — see the matching
  // comment on Article.stripe_product_id above; same mechanism, created by
  // POST /admin/issues/:slug/price.
  stripe_product_id?: string | null;
  // Stripe price id for buying this issue as a single one-time purchase —
  // independent of the sitewide membership products. Null when the issue
  // isn't sold individually (membership access only) — journal-preview.html
  // then hides its "Purchase" button and shows only "Start Membership".
  price_id: string | null;
  // Same denormalized-display-price rationale as Article.price_cents /
  // Article.currency above. Null exactly when price_id is null.
  price_cents: number | null;
  currency: string | null;
  // The table of contents. Missing/empty → journal-preview.html hides the
  // "Table of Contents" heading and every section label entirely, rather
  // than showing an empty list under a heading. Plenty of real issues (an
  // older scan, a single-essay special issue) have no ToC catalogued.
  articles?: Article[];
}
