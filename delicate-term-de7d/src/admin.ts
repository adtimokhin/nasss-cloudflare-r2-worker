import type { Context, MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore, AuthUserCreateError } from './firestore';
import { cancelActiveSubscriptions, applyGift, type GiftInput } from './stripe';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };
type Ctx = Context<HonoEnv>;

// NOTE: authMiddleware must run before this. It attaches the Firebase ID-token
// payload to the Hono context; user.sub is the Firebase UID, which we use to
// look up the members/{uid} document and check its role.
// This is a UX gate — the real security is that the Firestore service-account
// key and the R2 binding only exist inside this trusted Worker.
export const adminMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const userId = c.get('user').sub;

  if (!userId) {
    return c.json({ error: 'Invalid token: missing user ID' }, 401);
  }

  try {
    const member = await getFirestore(c.env).getDoc(`members/${userId}`);
    if (!member || member.role !== 'admin') {
      console.error('Admin check failed — userId:', userId, 'member:', member);
      return c.json({ error: 'Admin access required' }, 403);
    }
  } catch (err) {
    console.error('Admin check error — userId:', userId, 'error:', err);
    return c.json({ error: 'Admin access required' }, 403);
  }

  await next();
};

// =============================================================================
// POST /admin/block-member
// =============================================================================
// Admin-only. Immediately blocks a member from accessing the site: disables
// their Firebase Auth user (stops any new sign-in) and sets `blocked: true`
// on their members/{uid} doc, which authMiddleware (src/auth.ts) checks on
// every request — so an already-issued, not-yet-expired ID token is rejected
// too, not just future logins.
export async function blockMember(c: Ctx): Promise<Response> {
  const adminUid = c.get('user').sub;
  if (!adminUid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { target_uid?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetUid = body.target_uid;
  if (typeof targetUid !== 'string' || !targetUid) {
    return c.json({ error: 'target_uid is required' }, 400);
  }
  if (targetUid === adminUid) {
    return c.json({ error: "You can't block your own account" }, 400);
  }

  const allSucceeded = await cancelActiveSubscriptions(c.env, targetUid);
  if (!allSucceeded) {
    return c.json({ error: 'Could not block member (subscription cancellation failed)' }, 500);
  }

  const db = getFirestore(c.env);
  try {
    await db.setAuthUserDisabled(targetUid, true);
  } catch (err) {
    console.error('Failed to disable Firebase Auth user for block:', targetUid, err);
    return c.json({ error: 'Could not block member' }, 500);
  }

  await db.patchDoc(`members/${targetUid}`, {
    blocked: true,
    blocked_at: new Date(),
    blocked_by: adminUid,
  });

  return c.json({ success: true });
}

// =============================================================================
// POST /admin/unblock-member
// =============================================================================
// Admin-only. Reverses blockMember: re-enables the Firebase Auth user and
// clears the `blocked` flag so authMiddleware lets them through again.
export async function unblockMember(c: Ctx): Promise<Response> {
  const adminUid = c.get('user').sub;
  if (!adminUid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { target_uid?: unknown };
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
  try {
    await db.setAuthUserDisabled(targetUid, false);
  } catch (err) {
    console.error('Failed to re-enable Firebase Auth user for unblock:', targetUid, err);
    return c.json({ error: 'Could not unblock member' }, 500);
  }

  await db.patchDoc(`members/${targetUid}`, { blocked: false });

  return c.json({ success: true });
}

// =============================================================================
// POST /admin/import-members
// =============================================================================
// Admin-only. Bulk data-migration entry point: body is
// { members: [{ name, email, gifts?: [...] }] }. Creates a Firebase Auth
// user + members/{uid} doc per row, then applies each entry in `gifts` with
// the exact same no-checkout grant logic as POST /admin/gift-membership
// (applyGift, src/stripe.ts — same shape: { grant_type: 'membership'|'issue'
// |'article', ... }). Every row is independent: a bad email, a duplicate
// account, or a failed gift only marks that one row as failed/skipped in the
// response — it never aborts the rest of the batch.
//
// New accounts get no password here. The admin panel's Data Migration tab
// sends each successfully-created member a normal Firebase "forgot password"
// email right after this call returns, reusing the same client-side
// sendPasswordResetEmail already wired up for the per-member "Send Password
// Reset Email" action — this endpoint only creates identities, it never
// sends any email itself.
const IMPORT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMPORT_MAX_ROWS = 500;

interface ImportMemberInput {
  name?: unknown;
  email?: unknown;
  gifts?: unknown;
}

interface ImportGiftResult {
  grant_type: string;
  ok: boolean;
  error?: string;
}

interface ImportMemberResult {
  email: string;
  name: string | null;
  status: 'created' | 'skipped_existing' | 'failed';
  uid?: string;
  error?: string;
  gifts: ImportGiftResult[];
}

export async function importMembers(c: Ctx): Promise<Response> {
  const adminUid = c.get('user').sub;
  if (!adminUid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  let body: { members?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const rows = Array.isArray(body.members) ? (body.members as ImportMemberInput[]) : null;
  if (!rows || rows.length === 0) {
    return c.json({ error: 'members must be a non-empty array' }, 400);
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    return c.json({ error: `Import is limited to ${IMPORT_MAX_ROWS} members per request` }, 400);
  }

  const db = getFirestore(c.env);
  const results: ImportMemberResult[] = [];

  // Sequential, not parallel — Identity Toolkit's accounts:insert and the
  // Google OAuth2 token exchange are both rate-sensitive, and the ordering
  // of `results` matching the input order makes the admin's review table
  // easier to reconcile against the file they uploaded.
  for (const row of rows) {
    const rawEmail = typeof row.email === 'string' ? row.email.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const gifts = Array.isArray(row.gifts) ? (row.gifts as GiftInput[]) : [];

    if (!name) {
      results.push({ email: rawEmail || '(missing)', name: null, status: 'failed', error: 'Missing name', gifts: [] });
      continue;
    }
    if (!rawEmail || !IMPORT_EMAIL_PATTERN.test(rawEmail)) {
      results.push({ email: rawEmail || '(missing)', name, status: 'failed', error: 'Invalid or missing email', gifts: [] });
      continue;
    }

    let uid: string;
    try {
      uid = await db.createAuthUser(rawEmail, name);
    } catch (err) {
      if (err instanceof AuthUserCreateError && err.message === 'EMAIL_EXISTS') {
        results.push({ email: rawEmail, name, status: 'skipped_existing', error: 'Email already registered', gifts: [] });
      } else {
        results.push({
          email: rawEmail,
          name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          gifts: [],
        });
      }
      continue;
    }

    // Mirrors register.html's own members/{uid} doc exactly (name, email,
    // createdAt) plus imported_by for an audit trail — membership status is
    // still derived at read time from the purchases/subscriptions
    // subcollections, so there's nothing else to initialize here.
    await db.patchDoc(`members/${uid}`, {
      name,
      email: rawEmail,
      createdAt: new Date().toISOString(),
      imported_by: adminUid,
    });

    const giftResults: ImportGiftResult[] = [];
    for (const gift of gifts) {
      const grantType = typeof gift.grant_type === 'string' ? gift.grant_type : 'membership';
      try {
        await applyGift(db, uid, gift, adminUid);
        giftResults.push({ grant_type: grantType, ok: true });
      } catch (err) {
        giftResults.push({
          grant_type: grantType,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    results.push({ email: rawEmail, name, status: 'created', uid, gifts: giftResults });
  }

  return c.json({ results });
}
