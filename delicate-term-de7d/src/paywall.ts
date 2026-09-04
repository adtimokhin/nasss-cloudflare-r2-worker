import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore } from './firestore';
import { hasActiveMembership } from './membership';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// 2 hours. Matches the freshness the schema's read-time derivation is willing
// to trade for not re-reading two subcollections on every PDF request.
const CACHE_TTL_SECONDS = 2 * 60 * 60;

const cacheKey = (uid: string) => `access:${uid}`;

// NOTE: authMiddleware must run before this — it puts the Firebase ID-token
// payload on the context, and user.sub is the uid this checks.
//
// Grants access if the member is an admin, OR has an unexpired purchase, OR
// an active-and-unexpired subscription (hasActiveMembership — same "Deriving
// membership status" rule the schema defines and the checkout guard uses).
//
// Caching is deliberately one-directional: a positive result is cached for
// CACHE_TTL_SECONDS, a negative result is never cached. That means a member
// who just paid gets in immediately (nothing was ever cached saying "no"),
// at the cost of a revoked/expired member possibly keeping cached access for
// up to two hours after the fact.
export const paywallMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const cached = await c.env.MEMBERSHIP_CACHE.get(cacheKey(uid));
  if (cached === '1') {
    await next();
    return;
  }

  const db = getFirestore(c.env);
  const member = await db.getDoc(`members/${uid}`);
  const isAdmin = member?.role === 'admin';

  const allowed = isAdmin || (await hasActiveMembership(db, uid));
  if (!allowed) {
    return c.json({ error: 'An active membership is required to view this issue.' }, 403);
  }

  await c.env.MEMBERSHIP_CACHE.put(cacheKey(uid), '1', { expirationTtl: CACHE_TTL_SECONDS });
  await next();
};
