import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { adminMiddleware, blockMember, unblockMember, importMembers } from './admin';
import { paywallMiddleware, articlePaywallMiddleware } from './paywall';
import { getFirestore } from './firestore';
import {
  createCheckoutSession,
  createIssueCheckoutSession,
  createArticleCheckoutSession,
  createDonationCheckoutSession,
  stripeWebhook,
  cancelSubscription,
  deactivateAccount,
  deleteAccount,
  giftMembership,
} from './stripe';
import { capturePosthogEvent } from './posthog';
import { scheduled } from './renewal';
import { updatePhysicalJournalPreference } from './shippingPreference';
import {
  getIssueDetail,
  getIssueAccess,
  getIssueOwnedArticles,
  getArticleAccess,
  getIssuePreviewPdf,
  getArticlePreviewPdf,
  uploadIssuePreviewPdf,
  uploadArticlePreviewPdf,
  getEndOfPreviewPdf,
} from './journalPreview';
import { upsertIssuePrice, upsertArticlePrice } from './journalPricing';

type Variables = { user: JWTPayload };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', (c, next) => {
  const allowed = c.env.ALLOWED_ORIGIN;
  if (!allowed) return next();
  const allowedOrigins = allowed.split(',').map((o) => o.trim()).filter(Boolean);
  return cors({
    // Hono echoes back the request's Origin only if it's in this list;
    // a non-listed origin gets no Access-Control-Allow-Origin header at all.
    origin: allowedOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  })(c, next);
});

app.get('/health', (c) => c.json({ ok: true }));

// GET /issues
// Public. Returns all published issues ordered by issue_number desc.
// Firestore is queried with an equality filter only (no server-side orderBy),
// so no composite index is required; the sort happens here.
app.get('/issues', async (c) => {
  try {
    const db = getFirestore(c.env);
    const issues = await db.queryAll('issues', [['published', true]]);
    issues.sort((a, b) => (b.issue_number ?? 0) - (a.issue_number ?? 0));

    const list = issues.map((i) => ({
      slug: i.slug,
      issue_number: i.issue_number,
      issue_date: i.issue_date,
      cover_image_url: i.cover_image_url ?? null,
      title: i.title ?? null,
    }));

    return c.json({ issues: list });
  } catch (err) {
    console.error('Error fetching issues:', err);
    return c.json({ error: 'Failed to fetch issues' }, 500);
  }
});

// GET /issues/:slug
// Public. Full detail for one published issue, including its table of
// contents — see src/journalPreview.ts. Backs journal-preview.html.
app.get('/issues/:slug', getIssueDetail);

// GET /issues/:slug/access
// Requires a Firebase ID token (authMiddleware). Whether the caller can
// currently view this issue's full PDF — see src/journalPreview.ts.
app.get('/issues/:slug/access', authMiddleware, getIssueAccess);

// GET /issues/:slug/owned-articles
// Requires a Firebase ID token (authMiddleware). Which articles in this
// issue the caller has individually purchased/been gifted — see
// src/journalPreview.ts.
app.get('/issues/:slug/owned-articles', authMiddleware, getIssueOwnedArticles);

// GET /issues/:slug/articles/:articleSlug/access
// Requires a Firebase ID token (authMiddleware). Whether the caller can
// currently view this one article's own full PDF — see src/journalPreview.ts.
app.get('/issues/:slug/articles/:articleSlug/access', authMiddleware, getArticleAccess);

// GET /issues/:slug/preview-pdf
// GET /issues/:slug/articles/:articleSlug/preview-pdf
// Public — no auth, unlike /issues/:slug/pdf below. These serve the
// deliberately-public preview PDFs; see src/journalPreview.ts.
app.get('/issues/:slug/preview-pdf', getIssuePreviewPdf);
app.get('/issues/:slug/articles/:articleSlug/preview-pdf', getArticlePreviewPdf);

// GET /assets/end-of-preview-pdf
// Public. The single, global "blurred final page" shown at the end of every
// issue/article preview — not tied to any one issue. There's no upload
// endpoint for this on purpose: it's updated by uploading directly to R2
// (bucket "nasss-api-files", key "assets/end-of-preview.pdf"), not through
// the admin panel. See src/journalPreview.ts.
app.get('/assets/end-of-preview-pdf', getEndOfPreviewPdf);

app.get('/issues/:slug/pdf', authMiddleware, paywallMiddleware, async (c) => {
  const { slug } = c.req.param();
  try {
    const db = getFirestore(c.env);
    const issue = await db.queryFirst('issues', [
      ['slug', slug],
      ['published', true],
    ]);

    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }

    const object = await c.env.PDFS.get(issue.pdf_object_key);
    if (!object) {
      return c.json({
        status: 'authenticated',
        message: 'Auth works. PDF not yet uploaded.',
        issue: {
          slug: issue.slug,
          issue_number: issue.issue_number,
          issue_date: issue.issue_date,
          pdf_object_key: issue.pdf_object_key,
        },
      });
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}.pdf"`,
      },
    });
  } catch (err) {
    console.error('Error serving PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /issues/:slug/articles/:articleSlug/pdf
// Requires a Firebase ID token (authMiddleware) + articlePaywallMiddleware —
// same shape as GET /issues/:slug/pdf below, scoped to one article's own
// full PDF (distinct from both the issue's full PDF and the article's
// public preview PDF — see the pdf_object_key comment on Article in
// src/types.ts). Full-issue access unlocks this too (hasArticleAccess,
// src/membership.ts), same as every other article in that issue.
app.get(
  '/issues/:slug/articles/:articleSlug/pdf',
  authMiddleware,
  articlePaywallMiddleware,
  async (c) => {
    const { slug, articleSlug } = c.req.param();
    try {
      const db = getFirestore(c.env);
      const issue = await db.queryFirst('issues', [
        ['slug', slug],
        ['published', true],
      ]);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }

      const articles = Array.isArray(issue.articles) ? issue.articles : [];
      const article = articles.find((a: { slug?: unknown }) => a.slug === articleSlug);
      if (!article) {
        return c.json({ error: 'Article not found' }, 404);
      }

      if (!article.pdf_object_key) {
        return c.json({
          status: 'authenticated',
          message: 'Auth works. PDF not yet uploaded.',
          article: { slug: article.slug, title: article.title },
        });
      }

      const object = await c.env.PDFS.get(article.pdf_object_key);
      if (!object) {
        return c.json({
          status: 'authenticated',
          message: 'Auth works. PDF not yet uploaded.',
          article: { slug: article.slug, title: article.title },
        });
      }

      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${articleSlug}.pdf"`,
        },
      });
    } catch (err) {
      console.error('Error serving article PDF:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  },
);

// POST /admin/issues/:slug/articles/:articleSlug/pdf
// Admin-only. Same multipart/form-data shape as POST /admin/issues/:slug/pdf
// below, scoped to one article's full PDF. Firestore's REST API has no way
// to patch one element of an array field in place, so this reads the full
// `articles` array, replaces the matching entry, and writes the whole array
// back — same pattern as uploadArticlePreviewPdf (src/journalPreview.ts).
app.post(
  '/admin/issues/:slug/articles/:articleSlug/pdf',
  authMiddleware,
  adminMiddleware,
  async (c) => {
    const { slug, articleSlug } = c.req.param();
    try {
      const db = getFirestore(c.env);
      const issue = await db.queryFirst('issues', [['slug', slug]]);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }

      const articles = Array.isArray(issue.articles) ? issue.articles : [];
      const index = articles.findIndex((a: { slug?: unknown }) => a.slug === articleSlug);
      if (index === -1) {
        return c.json({ error: 'Article not found' }, 404);
      }

      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return c.json({ error: 'No file field in request' }, 400);
      }
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        return c.json({ error: 'File must be a PDF' }, 400);
      }

      const key = `issues/${slug}/${articleSlug}.pdf`;
      console.log(
        'Uploading article PDF — slug:', slug, 'article:', articleSlug,
        'file:', file.name, 'size:', file.size, 'R2 key:', key,
      );
      await c.env.PDFS.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: 'application/pdf' },
      });

      const updatedArticles = articles.slice();
      updatedArticles[index] = { ...updatedArticles[index], pdf_object_key: key };
      await db.patchDoc(`issues/${issue._id}`, { articles: updatedArticles });

      return c.json({ ok: true, key });
    } catch (err) {
      console.error('Error uploading article PDF:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  },
);

// POST /admin/issues/:slug/pdf
// Admin-only. Accepts multipart/form-data with a "file" field (PDF).
// Stores the file in R2 at the key already recorded in issues.pdf_object_key.
// Does NOT require the issue to be published.
app.post('/admin/issues/:slug/pdf', authMiddleware, adminMiddleware, async (c) => {
  const { slug } = c.req.param();
  try {
    const db = getFirestore(c.env);
    const issue = await db.queryFirst('issues', [['slug', slug]]);

    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file field in request' }, 400);
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return c.json({ error: 'File must be a PDF' }, 400);
    }

    console.log('Uploading PDF — slug:', slug, 'file:', file.name, 'size:', file.size, 'R2 key:', issue.pdf_object_key);
    await c.env.PDFS.put(issue.pdf_object_key, await file.arrayBuffer(), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    console.log('PDF upload complete — R2 key:', issue.pdf_object_key);

    return c.json({ ok: true, key: issue.pdf_object_key });
  } catch (err) {
    console.error('Error uploading PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /covers/:filename
// Public — no auth. Serves cover images stored in R2 under the "covers/" prefix.
// Cover images are not gated content, so anyone can fetch them by URL.
app.get('/covers/:filename', async (c) => {
  const { filename } = c.req.param();
  try {
    const object = await c.env.PDFS.get(`covers/${filename}`);
    if (!object) {
      return c.json({ error: 'Not found' }, 404);
    }
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.error('Error serving cover:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /admin/issues/:slug/cover
// Admin-only. Accepts multipart/form-data with a "file" field (any image type).
// Stores in R2 at "covers/<slug>.<ext>", then updates issues.cover_image_url
// to the public Worker URL for that object.
app.post('/admin/issues/:slug/cover', authMiddleware, adminMiddleware, async (c) => {
  const { slug } = c.req.param();
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file field in request' }, 400);
    }
    if (!file.type.startsWith('image/')) {
      return c.json({ error: 'File must be an image' }, 400);
    }

    const db = getFirestore(c.env);
    const issue = await db.queryFirst('issues', [['slug', slug]]);
    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }

    const nameParts = file.name.split('.');
    const ext = (nameParts.length > 1 ? nameParts.pop()! : 'jpg').toLowerCase();
    const key = `covers/${slug}.${ext}`;

    console.log('Uploading cover — slug:', slug, 'file:', file.name, 'size:', file.size, 'R2 key:', key);
    await c.env.PDFS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    console.log('Cover upload complete — R2 key:', key);

    // Derive the public URL from the incoming request origin so this works
    // both in local dev (http://localhost:8787) and in production.
    const origin = new URL(c.req.url).origin;
    const publicUrl = `${origin}/covers/${slug}.${ext}`;

    try {
      await db.patchDoc(`issues/${issue._id}`, { cover_image_url: publicUrl });
    } catch (updateErr) {
      console.error('Failed to update cover_image_url:', updateErr);
      return c.json({ error: 'Uploaded to R2 but failed to update the issues record' }, 500);
    }

    return c.json({ ok: true, key, url: publicUrl });
  } catch (err) {
    console.error('Error uploading cover:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /admin/issues/:slug/preview-pdf
// POST /admin/issues/:slug/articles/:articleSlug/preview-pdf
// Admin-only. Same multipart/form-data shape as POST /admin/issues/:slug/pdf
// above — one "file" field. See src/journalPreview.ts.
app.post('/admin/issues/:slug/preview-pdf', authMiddleware, adminMiddleware, uploadIssuePreviewPdf);
app.post(
  '/admin/issues/:slug/articles/:articleSlug/preview-pdf',
  authMiddleware,
  adminMiddleware,
  uploadArticlePreviewPdf,
);

// POST /admin/issues/:slug/price
// POST /admin/issues/:slug/articles/:articleSlug/price
// Admin-only. Body: { amount_cents: number, currency?: string }. Creates or
// updates the Stripe Product/Price behind an individual purchase price —
// see src/journalPricing.ts for why "updating" means minting a new Price.
app.post('/admin/issues/:slug/price', authMiddleware, adminMiddleware, upsertIssuePrice);
app.post(
  '/admin/issues/:slug/articles/:articleSlug/price',
  authMiddleware,
  adminMiddleware,
  upsertArticlePrice,
);

// Remove or restrict to admin role before production
app.get('/debug/list-bucket', authMiddleware, async (c) => {
  try {
    const list = await c.env.PDFS.list();
    return c.json({ objects: list.objects.map((o) => o.key) });
  } catch (err) {
    console.error('Error listing bucket:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// --- Stripe membership ---
// POST /create-checkout-session       — requires a Firebase ID token (authMiddleware).
// POST /create-issue-checkout-session   — requires a Firebase ID token (authMiddleware);
//                                          buys one published issue individually — see src/stripe.ts.
// POST /create-article-checkout-session — requires a Firebase ID token (authMiddleware);
//                                          buys one article individually — see src/stripe.ts.
// POST /create-donation-checkout-session — requires a Firebase ID token (authMiddleware);
//                                           standalone donation, independent of membership — see src/stripe.ts.
// POST /cancel-subscription           — requires a Firebase ID token (authMiddleware).
// POST /deactivate-account            — requires a Firebase ID token (authMiddleware).
// POST /delete-account                — requires a Firebase ID token (authMiddleware). Permanent.
// POST /admin/gift-membership         — admin-only; grants a purchase without Stripe.
// POST /webhooks/stripe               — no auth; verified by the Stripe signature.
app.post('/create-checkout-session', authMiddleware, createCheckoutSession);
app.post('/create-issue-checkout-session', authMiddleware, createIssueCheckoutSession);
app.post('/create-article-checkout-session', authMiddleware, createArticleCheckoutSession);
app.post('/create-donation-checkout-session', authMiddleware, createDonationCheckoutSession);
app.post('/cancel-subscription', authMiddleware, cancelSubscription);
app.post('/deactivate-account', authMiddleware, deactivateAccount);
app.post('/delete-account', authMiddleware, deleteAccount);
app.post('/admin/gift-membership', authMiddleware, adminMiddleware, giftMembership);
app.post('/webhooks/stripe', stripeWebhook);

// POST /update-physical-journal
// Requires a Firebase ID token (authMiddleware). Toggles wants_physical_journal
// and (optionally) sets the mailing address on the member's currently-active
// purchase/subscription doc — see src/shippingPreference.ts for why this can't
// be a direct client write.
app.post('/update-physical-journal', authMiddleware, updatePhysicalJournalPreference);

// --- Admin: block/unblock a member ---
// POST /admin/block-member    — admin-only; { target_uid }. Immediately
//                                revokes site access (see src/admin.ts).
// POST /admin/unblock-member  — admin-only; { target_uid }. Reverses it.
app.post('/admin/block-member', authMiddleware, adminMiddleware, blockMember);
app.post('/admin/unblock-member', authMiddleware, adminMiddleware, unblockMember);

// POST /admin/import-members  — admin-only; { members: [{ name, email, gifts?: [...] }] }.
// Bulk data-migration: creates Firebase Auth + members/{uid} per row, then
// applies any `gifts` via the same no-checkout grant logic as gift-membership.
app.post('/admin/import-members', authMiddleware, adminMiddleware, importMembers);

// GET /renewal-redirect?uid=...
// Public — the link inside renewal-reminder emails (src/renewal.ts) routes
// through here so the click can be captured to PostHog before bouncing to
// the membership page.
app.get('/renewal-redirect', (c) => {
  const uid = c.req.query('uid');
  if (uid) {
    c.executionCtx.waitUntil(capturePosthogEvent(c.env, 'renewal_email_clicked', uid, {}));
  }
  return c.redirect('https://www.serbianstudies.org/new-membership?ref=renewal', 302);
});

export default {
  fetch: app.fetch,
  scheduled,
};
