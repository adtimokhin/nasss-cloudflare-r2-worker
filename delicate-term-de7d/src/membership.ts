import type { Firestore, FirestoreDoc } from './firestore';

// -----------------------------------------------------------------------------
// Membership status is derived at read time from the purchases/subscriptions
// subcollections — there is no cached field on members/{uid}. This mirrors the
// Firestore schema's "Deriving membership status" section exactly:
//
//   1. A purchase counts if status == "completed", now < coverage_end, AND
//      it isn't an individual-issue purchase (issue_slug unset) — a
//      single-issue purchase has the same completed+coverage_end shape
//      (coverage_end is just set ~100 years out, see
//      handleIssuePurchaseCompleted in src/stripe.ts) but must NOT read as
//      "has a membership", or buying one issue would silently unlock every
//      other issue too via hasIssueAccess below, which trusts this function
//      to mean "every issue, not just one". This was a real bug caught
//      during manual testing — a single-issue purchase was granting access
//      to every issue, not just the one bought, because this check didn't
//      exclude it.
//   2. A subscription counts if status == "active" and now < current_period_end
//      (cancel_at_period_end doesn't matter — it stays "active" until the
//      period actually lapses). Subscriptions never carry issue_slug — only
//      the membership checkout flow creates them.
//   3. The member is active if either check finds a hit.
// -----------------------------------------------------------------------------

/** True if the member currently has access via any purchase or subscription. */
export async function hasActiveMembership(db: Firestore, uid: string): Promise<boolean> {
  const now = Date.now();

  const [purchases, subscriptions] = await Promise.all([
    db.listDocs(`members/${uid}/purchases`),
    db.listDocs(`members/${uid}/subscriptions`),
  ]);

  const purchaseActive = purchases.some(
    (p) =>
      p.status === 'completed' &&
      !p.issue_slug &&
      typeof p.coverage_end === 'string' &&
      Date.parse(p.coverage_end) > now,
  );
  if (purchaseActive) return true;

  return subscriptions.some(
    (s) =>
      s.status === 'active' &&
      typeof s.current_period_end === 'string' &&
      Date.parse(s.current_period_end) > now,
  );
}

/**
 * True if the member can view one specific issue's full PDF — either an
 * active membership (which grants every issue, same as hasActiveMembership
 * above), or a standing individual purchase of this one issue specifically.
 * Used by paywallMiddleware (src/paywall.ts) instead of hasActiveMembership
 * now that GET /issues/:slug/pdf can be unlocked per-issue, not just via
 * membership — see POST /create-issue-checkout-session (src/stripe.ts) for
 * where Purchase.issue_slug gets set.
 *
 * `!p.article_slug` excludes a purchase/gift scoped to just one article
 * (grant_type 'article' in POST /admin/gift-membership, or a real
 * per-article purchase) — buying/being gifted a single article must not
 * unlock the whole issue's full PDF. It does not need to, and must not,
 * match the bundled per-article docs grantBundledArticles (src/stripe.ts)
 * writes alongside a real full-issue grant either: those are redundant for
 * this check, since the full-issue grant they're bundled with already has
 * no article_slug and already passes on its own.
 */
export async function hasIssueAccess(db: Firestore, uid: string, issueSlug: string): Promise<boolean> {
  if (await hasActiveMembership(db, uid)) return true;

  const now = Date.now();
  const purchases = await db.listDocs(`members/${uid}/purchases`);
  return purchases.some(
    (p) =>
      p.status === 'completed' &&
      p.issue_slug === issueSlug &&
      !p.article_slug &&
      typeof p.coverage_end === 'string' &&
      Date.parse(p.coverage_end) > now,
  );
}

/**
 * True if the member can view one specific article's own full PDF — either
 * full-issue access (hasIssueAccess above; owning the whole issue already
 * includes every article in it), or a standing purchase/gift scoped to just
 * this article specifically (a real per-article purchase, an admin gift with
 * grant_type 'article', or the bundled grant grantBundledArticles writes
 * alongside a full-issue purchase/gift — src/stripe.ts). Used by
 * articlePaywallMiddleware (src/paywall.ts).
 */
export async function hasArticleAccess(
  db: Firestore,
  uid: string,
  issueSlug: string,
  articleSlug: string,
): Promise<boolean> {
  if (await hasIssueAccess(db, uid, issueSlug)) return true;

  const now = Date.now();
  const purchases = await db.listDocs(`members/${uid}/purchases`);
  return purchases.some(
    (p) =>
      p.status === 'completed' &&
      p.issue_slug === issueSlug &&
      p.article_slug === articleSlug &&
      typeof p.coverage_end === 'string' &&
      Date.parse(p.coverage_end) > now,
  );
}

/**
 * The one purchase/subscription doc that currently grants the member access,
 * if any — mirrors account-details.html's Membership panel, which prefers an
 * active subscription over an active one-time purchase when (in principle,
 * never in practice) both exist. Used by POST /update-physical-journal
 * (src/shippingPreference.ts) to know which doc's requires_shipping /
 * mailing_address to patch, since clients can't write those fields directly
 * (Firestore rules: `allow write: if false` on purchases/subscriptions).
 */
export async function findActiveMembershipDoc(
  db: Firestore,
  uid: string,
): Promise<{ path: string; doc: FirestoreDoc } | null> {
  const now = Date.now();

  const [purchases, subscriptions] = await Promise.all([
    db.listDocs(`members/${uid}/purchases`),
    db.listDocs(`members/${uid}/subscriptions`),
  ]);

  const activeSubscription = subscriptions.find(
    (s) =>
      s.status === 'active' &&
      typeof s.current_period_end === 'string' &&
      Date.parse(s.current_period_end) > now,
  );
  if (activeSubscription) {
    return { path: `members/${uid}/subscriptions/${activeSubscription._id}`, doc: activeSubscription };
  }

  // Same exclusion as hasActiveMembership above — an individual-issue
  // purchase isn't a membership doc, so it must never be picked here (it
  // has no requires_shipping/physical-journal concept to manage anyway).
  const activePurchase = purchases.find(
    (p) =>
      p.status === 'completed' &&
      !p.issue_slug &&
      typeof p.coverage_end === 'string' &&
      Date.parse(p.coverage_end) > now,
  );
  if (activePurchase) {
    return { path: `members/${uid}/purchases/${activePurchase._id}`, doc: activePurchase };
  }

  return null;
}
