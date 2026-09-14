import type { Env } from './types';
import { getFirestore, type Firestore } from './firestore';
import { capturePosthogEvent } from './posthog';
import { uidFromName } from './stripe';

// -----------------------------------------------------------------------------
// Daily renewal-reminder cron (see wrangler.jsonc triggers.crons).
//
// Scans every completed purchase / active subscription for a coverage_end /
// current_period_end inside the next RENEWAL_WINDOW_DAYS, and emails the
// member once per expiration cycle via Resend. The email link routes through
// GET /renewal-redirect so the click can be captured to PostHog before
// bouncing to the membership page.
// -----------------------------------------------------------------------------

const RENEWAL_WINDOW_DAYS = 7;
const RESEND_FROM = 'renewals@serbianstudies.org';

export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(sendRenewalReminders(env));
}

async function sendRenewalReminders(env: Env): Promise<void> {
  const db = getFirestore(env);
  const now = Date.now();
  const windowEnd = now + RENEWAL_WINDOW_DAYS * 86_400_000;

  const [purchases, subscriptions] = await Promise.all([
    db.queryGroup('purchases', [['status', 'completed']]),
    db.queryGroup('subscriptions', [['status', 'active']]),
  ]);

  // uid -> earliest upcoming expiration, in case a member somehow has more
  // than one membership record expiring in the window.
  const expiring = new Map<string, string>();
  for (const p of purchases) {
    collectExpiring(expiring, p._name, p.coverage_end, now, windowEnd);
  }
  for (const s of subscriptions) {
    collectExpiring(expiring, s._name, s.current_period_end, now, windowEnd);
  }

  for (const [uid, expirationIso] of expiring) {
    try {
      await maybeSendReminder(env, db, uid, expirationIso);
    } catch (err) {
      console.error('Renewal reminder failed for', uid, err);
    }
  }
}

function collectExpiring(
  map: Map<string, string>,
  docName: string,
  expiration: unknown,
  now: number,
  windowEnd: number,
): void {
  if (typeof expiration !== 'string') return;
  const t = Date.parse(expiration);
  if (Number.isNaN(t) || t < now || t > windowEnd) return;

  const uid = uidFromName(docName);
  if (!uid) return;

  const existing = map.get(uid);
  if (!existing || t < Date.parse(existing)) map.set(uid, expiration);
}

async function maybeSendReminder(
  env: Env,
  db: Firestore,
  uid: string,
  expirationIso: string,
): Promise<void> {
  const member = await db.getDoc(`members/${uid}`);
  if (!member || typeof member.email !== 'string' || !member.email) {
    console.warn('Renewal reminder: no email on file for', uid);
    return;
  }

  // Already reminded for this exact expiration cycle.
  if (member.last_renewal_reminder_expiration === expirationIso) return;

  const redirectUrl = `${env.WORKER_BASE_URL}/renewal-redirect?uid=${encodeURIComponent(uid)}`;
  const expirationLabel = new Date(expirationIso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: member.email,
      subject: 'Your NASSS membership is expiring soon',
      html:
        `<p>Your NASSS membership expires on ${expirationLabel}.</p>` +
        `<p><a href="${redirectUrl}">Renew your membership</a></p>`,
    }),
  });

  if (!res.ok) {
    console.error('Resend send failed for', uid, res.status, await res.text());
    return;
  }

  await Promise.all([
    capturePosthogEvent(env, 'renewal_email_sent', uid, { expiration_date: expirationIso }),
    db.patchDoc(`members/${uid}`, {
      last_renewal_reminder_sent: new Date(),
      last_renewal_reminder_expiration: expirationIso,
    }),
  ]);
}
