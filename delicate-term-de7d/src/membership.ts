import type { Firestore } from './firestore';

// -----------------------------------------------------------------------------
// Membership status is derived at read time from the purchases/subscriptions
// subcollections — there is no cached field on members/{uid}. This mirrors the
// Firestore schema's "Deriving membership status" section exactly:
//
//   1. A purchase counts if status == "completed" and now < coverage_end.
//   2. A subscription counts if status == "active" and now < current_period_end
//      (cancel_at_period_end doesn't matter — it stays "active" until the
//      period actually lapses).
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
    (p) => p.status === 'completed' && typeof p.coverage_end === 'string' && Date.parse(p.coverage_end) > now,
  );
  if (purchaseActive) return true;

  return subscriptions.some(
    (s) =>
      s.status === 'active' &&
      typeof s.current_period_end === 'string' &&
      Date.parse(s.current_period_end) > now,
  );
}
