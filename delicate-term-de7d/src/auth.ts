import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';

type HonoEnv = { Bindings: Env; Variables: { user: JWTPayload } };

// Firebase signs ID tokens with rotating Google keys published at this endpoint.
// The URL is not project-specific, so a single module-level set is enough; jose
// handles fetching, caching and key rotation internally.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or malformed Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  const projectId = c.env.FIREBASE_PROJECT_ID;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });

    // Firebase-specific sanity checks beyond signature / aud / iss / exp.
    if (!payload.sub || typeof payload.sub !== 'string') {
      return c.json({ error: 'Invalid token: missing subject' }, 401);
    }
    const authTime = (payload as { auth_time?: number }).auth_time;
    if (typeof authTime === 'number' && authTime > Math.floor(Date.now() / 1000) + 60) {
      return c.json({ error: 'Invalid token: auth_time is in the future' }, 401);
    }

    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};
