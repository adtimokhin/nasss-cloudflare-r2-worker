import type { MiddlewareHandler } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { getFirestore } from './firestore';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

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
