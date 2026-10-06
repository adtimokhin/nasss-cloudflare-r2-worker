import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore } from './firestore';
import { hasIssueAccess, hasArticleAccess } from './membership';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// 2 hours. Matches the freshness the schema's read-time derivation is willing
// to trade for not re-reading two subcollections on every PDF request.
const CACHE_TTL_SECONDS = 2 * 60 * 60;

// Keyed per issue, not just per uid — access is no longer uniform across
// every issue now that an individual purchase can unlock just one of them
// (hasIssueAccess, src/membership.ts). A single per-uid key would let a
// cached "yes" for one issue leak access to every other issue within the
// TTL; this is the fix for that.
const cacheKey = (uid: string, slug: string) => `access:${uid}:${slug}`;

// NOTE: authMiddleware must run before this (and this route must have a
// :slug param) — it puts the Firebase ID-token payload on the context, and
// user.sub is the uid this checks.
//
// Grants access if the member is an admin, OR hasIssueAccess says so (active
// membership, which covers every issue, OR a standing individual purchase of
// this specific one — see src/membership.ts).
//
// Caching is deliberately one-directional: a positive result is cached for
// CACHE_TTL_SECONDS, a negative result is never cached. That means a member
// who just paid gets in immediately (nothing was ever cached saying "no"),
// at the cost of a revoked/expired member possibly keeping cached access for
// up to two hours after the fact.
export const paywallMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'Missing issue slug' }, 400);
  const key = cacheKey(uid, slug);

  const cached = await c.env.MEMBERSHIP_CACHE.get(key);
  if (cached === '1') {
    await next();
    return;
  }

  const db = getFirestore(c.env);
  const member = await db.getDoc(`members/${uid}`);
  const isAdmin = member?.role === 'admin';

  const allowed = isAdmin || (await hasIssueAccess(db, uid, slug));
  if (!allowed) {
    return c.json({ error: 'An active membership or individual purchase is required to view this issue.' }, 403);
  }

  await c.env.MEMBERSHIP_CACHE.put(key, '1', { expirationTtl: CACHE_TTL_SECONDS });
  await next();
};

// Keyed per issue+article, same reasoning as cacheKey above — a cached "yes"
// for one article must never leak to a different article (or a different
// issue's same-named one).
const articleCacheKey = (uid: string, slug: string, articleSlug: string) =>
  `access:${uid}:${slug}:${articleSlug}`;

// NOTE: authMiddleware must run before this (and this route must have both
// :slug and :articleSlug params).
//
// Grants access if the member is an admin, OR hasArticleAccess says so
// (full-issue access, which covers every article in it, OR a standing
// purchase/gift of this specific article — see src/membership.ts).
export const articlePaywallMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const slug = c.req.param('slug');
  const articleSlug = c.req.param('articleSlug');
  if (!slug || !articleSlug) return c.json({ error: 'Missing issue or article slug' }, 400);
  const key = articleCacheKey(uid, slug, articleSlug);

  const cached = await c.env.MEMBERSHIP_CACHE.get(key);
  if (cached === '1') {
    await next();
    return;
  }

  const db = getFirestore(c.env);
  const member = await db.getDoc(`members/${uid}`);
  const isAdmin = member?.role === 'admin';

  const allowed = isAdmin || (await hasArticleAccess(db, uid, slug, articleSlug));
  if (!allowed) {
    return c.json(
      { error: 'An active membership or individual purchase is required to view this article.' },
      403,
    );
  }

  await c.env.MEMBERSHIP_CACHE.put(key, '1', { expirationTtl: CACHE_TTL_SECONDS });
  await next();
};
