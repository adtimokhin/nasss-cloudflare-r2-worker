import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env, MailingAddress } from './types';
import { getFirestore } from './firestore';
import { findActiveMembershipDoc } from './membership';

// -----------------------------------------------------------------------------
// POST /update-physical-journal — self-service. Lets a member toggle whether
// they receive the physical journal and edit the mailing address on their
// currently-active purchase/subscription doc.
//
// This has to go through the Worker rather than a direct client write: those
// docs are the financial ledger (see src/types.ts), and Firestore rules
// deliberately set `allow write: if false` on purchases/subscriptions —
// only the service-account-authenticated Firestore REST client (src/firestore.ts)
// can touch them, same as the Stripe webhook does for the fields that put
// them there in the first place.
// -----------------------------------------------------------------------------

type Ctx = Context<{ Bindings: Env; Variables: { user: JWTPayload } }>;

export async function updatePhysicalJournalPreference(c: Ctx): Promise<Response> {
  const user = c.get('user');
  const uid = user.sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { wants_physical_journal?: unknown; mailing_address?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.wants_physical_journal !== 'boolean') {
    return c.json({ error: 'wants_physical_journal must be a boolean' }, 400);
  }
  const wantsPhysicalJournal = body.wants_physical_journal;

  const db = getFirestore(c.env);
  const active = await findActiveMembershipDoc(db, uid);
  if (!active) {
    return c.json({ error: 'No active membership to update' }, 404);
  }

  const existingAddress = (active.doc.mailing_address ?? null) as MailingAddress | null;
  const hasExistingAddress = !!existingAddress?.line1;

  let mailingAddress: MailingAddress | null = existingAddress;

  // A submitted mailing_address is applied whenever present, independent of
  // wants_physical_journal — account-details.html's "Edit Address" lets a
  // member update their address while opted out, same as while opted in.
  const rawAddress =
    body.mailing_address && typeof body.mailing_address === 'object'
      ? (body.mailing_address as Record<string, unknown>)
      : null;

  if (rawAddress) {
    const line1 = typeof rawAddress.line1 === 'string' ? rawAddress.line1.trim() : '';
    const line2 = typeof rawAddress.line2 === 'string' ? rawAddress.line2.trim() : '';
    const city = typeof rawAddress.city === 'string' ? rawAddress.city.trim() : '';
    const state = typeof rawAddress.state === 'string' ? rawAddress.state.trim() : '';
    const postalCode = typeof rawAddress.postal_code === 'string' ? rawAddress.postal_code.trim() : '';
    const country = typeof rawAddress.country === 'string' ? rawAddress.country.trim().toUpperCase() : '';

    if (!line1 || !city || !postalCode || !country) {
      return c.json({ error: 'line1, city, postal_code, and country are required' }, 400);
    }

    mailingAddress = {
      line1,
      line2: line2 || null,
      city,
      state: state || null,
      postal_code: postalCode,
      country,
    };
  } else if (wantsPhysicalJournal && !hasExistingAddress) {
    // Opting in cannot succeed without an address — enforced here too, not
    // just in account-details.html's UI.
    return c.json({ error: 'A mailing address is required to receive the physical journal' }, 400);
  }

  await db.patchDoc(active.path, {
    requires_shipping: wantsPhysicalJournal,
    mailing_address: mailingAddress,
  });

  // Keep the pre-checkout preference (Member.wants_physical_journal — see
  // src/types.ts) in sync too. Firestore rules already allow a member to
  // patch this field on their own members/{uid} doc directly, but doing it
  // here keeps both writes in one request/response instead of a second
  // client-side round trip.
  await db.patchDoc(`members/${uid}`, { wants_physical_journal: wantsPhysicalJournal });

  return c.json({ success: true, requires_shipping: wantsPhysicalJournal, mailing_address: mailingAddress });
}
