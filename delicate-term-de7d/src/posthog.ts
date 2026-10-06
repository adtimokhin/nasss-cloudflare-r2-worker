import type { Env } from './types';

// -----------------------------------------------------------------------------
// PostHog server-side capture. One helper, reused by every call site, so event
// shape (distinct_id convention, source tag, idempotency) stays consistent.
// See the integration spec for the full event list and naming conventions.
// -----------------------------------------------------------------------------

/**
 * Sends a single event to PostHog's capture endpoint.
 *
 * - `distinctId` must always be the Firebase uid — it has to match the
 *   distinct_id set client-side via posthog.identify(uid, ...), or server and
 *   client events land on different person profiles and the funnel breaks.
 * - Never `await` this inline in a response path that Stripe or another
 *   caller is waiting on; call it via `c.executionCtx.waitUntil(...)` instead
 *   so a slow/failing PostHog call can't delay or fail that response.
 * - Pass `uuid` (the Stripe event id) for webhook-triggered events, so a
 *   retried delivery doesn't double-fire the event.
 */
export async function capturePosthogEvent(
  env: Env,
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
  uuid: string | null = null,
): Promise<void> {
  const payload: Record<string, unknown> = {
    api_key: env.POSTHOG_API_KEY,
    event,
    distinct_id: distinctId,
    properties: {
      ...properties,
      source: 'cloudflare_worker',
    },
    timestamp: new Date().toISOString(),
  };
  if (uuid) payload.uuid = uuid;

  try {
    const res = await fetch(`${env.POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`PostHog capture failed for "${event}":`, res.status, await res.text());
    }
  } catch (err) {
    // A PostHog outage must never surface as an error to the caller.
    console.error(`PostHog capture threw for "${event}":`, err);
  }
}
