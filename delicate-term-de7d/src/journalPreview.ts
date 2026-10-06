import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import type { Env, Article } from './types';
import { getFirestore, type FirestoreDoc } from './firestore';
import { hasIssueAccess, hasArticleAccess } from './membership';

// -----------------------------------------------------------------------------
// Backs journal-preview.html and article-preview.html (nasss-sqaurespace-
// duplicate-pages) — public, unauthenticated routes that serve an issue's
// (or one article's) preview metadata and preview PDF by slug, plus the
// admin-only uploads that populate those preview PDFs.
//
// None of this is paywalled: a preview PDF is, by definition, something a
// logged-out visitor should be able to see. The full issue PDF
// (GET /issues/:slug/pdf, src/index.ts) stays behind authMiddleware +
// paywallMiddleware exactly as before — this file never touches that key.
// -----------------------------------------------------------------------------

type Ctx = Context<{ Bindings: Env; Variables: { user: JWTPayload } }>;

// Fixed R2 key for the single, global "blurred final page" shown at the end
// of every issue/article preview (journal-preview.html / article-preview.html)
// — not tied to any one issue, so unlike everything else in this file there's
// no Firestore doc involved, just this one object. Deliberately uploaded
// directly to R2 (bucket "nasss-api-files") rather than through an admin
// panel upload endpoint — see getEndOfPreviewPdf below for the read side.
const END_OF_PREVIEW_PDF_KEY = 'assets/end-of-preview.pdf';

// Shape returned to the public preview pages. Deliberately omits raw R2
// object keys (a has_preview_pdf boolean instead — the client always fetches
// the preview through this file's GET .../preview-pdf routes, same pattern
// as the full PDF never exposing pdf_object_key to the client) and the
// issue's pdf_object_key, which is irrelevant to an unauthenticated preview.
function publicArticle(a: Article) {
  return {
    slug: a.slug,
    title: a.title,
    authors: Array.isArray(a.authors) ? a.authors : [],
    section: a.section,
    abstract: a.abstract ?? null,
    has_preview_pdf: !!a.preview_pdf_object_key,
    price:
      a.price_id && typeof a.price_cents === 'number'
        ? { price_id: a.price_id, price_cents: a.price_cents, currency: a.currency ?? 'usd' }
        : null,
  };
}

function findArticle(issue: FirestoreDoc, articleSlug: string): Article | null {
  const articles: Article[] = Array.isArray(issue.articles) ? issue.articles : [];
  return articles.find((a) => a.slug === articleSlug) ?? null;
}

// =============================================================================
// GET /issues/:slug
// Public. Full detail for one published issue, including its table of
// contents — the list endpoint (GET /issues) only returns summary fields.
// =============================================================================
export async function getIssueDetail(c: Ctx): Promise<Response> {
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

    const articles: Article[] = Array.isArray(issue.articles) ? issue.articles : [];

    return c.json({
      issue: {
        slug: issue.slug,
        issue_number: issue.issue_number,
        issue_date: issue.issue_date,
        title: issue.title ?? null,
        cover_image_url: issue.cover_image_url ?? null,
        has_preview_pdf: !!issue.preview_pdf_object_key,
        price:
          issue.price_id && typeof issue.price_cents === 'number'
            ? { price_id: issue.price_id, price_cents: issue.price_cents, currency: issue.currency ?? 'usd' }
            : null,
        articles: articles.map(publicArticle),
      },
    });
  } catch (err) {
    console.error('Error fetching issue detail:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

// =============================================================================
// GET /issues/:slug/access
// Requires a Firebase ID token (authMiddleware) — unlike the rest of this
// file. Lets journal-preview.html know whether to offer "View Full Issue"
// instead of "Purchase" once someone is logged in, without downloading the
// whole PDF just to find out (which hitting GET /issues/:slug/pdf directly
// would mean). Reuses the exact same check paywallMiddleware enforces.
// =============================================================================
export async function getIssueAccess(c: Ctx): Promise<Response> {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const { slug } = c.req.param();
  const db = getFirestore(c.env);
  const member = await db.getDoc(`members/${uid}`);
  const isAdmin = member?.role === 'admin';
  const hasAccess = isAdmin || (await hasIssueAccess(db, uid, slug));

  return c.json({ has_access: hasAccess });
}

// =============================================================================
// GET /issues/:slug/owned-articles
// Requires a Firebase ID token (authMiddleware). Lists which articles *in
// this specific issue* the caller has individually purchased or been
// gifted — i.e. purchases/gifts with issue_slug matching AND article_slug
// set. Deliberately not about full-issue access (that's GET
// /issues/:slug/access above): full-issue ownership already implies every
// article, so journal-preview.html only needs this list to offer a
// "Purchased Articles" filter on the Table of Contents when ownership is a
// genuine strict subset — it doesn't call this at all once has_access is
// true for the whole issue.
// =============================================================================
export async function getIssueOwnedArticles(c: Ctx): Promise<Response> {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const { slug } = c.req.param();
  const db = getFirestore(c.env);
  const now = Date.now();

  const purchases = await db.listDocs(`members/${uid}/purchases`);
  const articleSlugs = new Set(
    purchases
      .filter(
        (p) =>
          p.status === 'completed' &&
          p.issue_slug === slug &&
          typeof p.article_slug === 'string' &&
          p.article_slug &&
          typeof p.coverage_end === 'string' &&
          Date.parse(p.coverage_end) > now,
      )
      .map((p) => p.article_slug as string),
  );

  return c.json({ article_slugs: [...articleSlugs] });
}

// =============================================================================
// GET /issues/:slug/articles/:articleSlug/access
// Requires a Firebase ID token (authMiddleware). Lets article-preview.html
// know whether to offer "View Full Article" instead of "Purchase" once
// someone is logged in, without downloading the whole PDF just to find out.
// Distinct from GET /issues/:slug/access above: that one only reflects
// full-issue ownership, which would miss a member who bought this one
// article on its own without ever owning the whole issue. Reuses the exact
// same check articlePaywallMiddleware enforces.
// =============================================================================
export async function getArticleAccess(c: Ctx): Promise<Response> {
  const uid = c.get('user').sub;
  if (!uid) return c.json({ error: 'Invalid token: missing user ID' }, 401);

  const { slug, articleSlug } = c.req.param();
  const db = getFirestore(c.env);
  const member = await db.getDoc(`members/${uid}`);
  const isAdmin = member?.role === 'admin';
  const hasAccess = isAdmin || (await hasArticleAccess(db, uid, slug, articleSlug));

  return c.json({ has_access: hasAccess });
}

// =============================================================================
// GET /issues/:slug/preview-pdf
// Public. Serves the issue-level preview PDF from R2, or 404 if the issue
// has none uploaded (not an error — most of this schema's optional fields
// are expected to be legitimately absent for some issues, see src/types.ts).
// =============================================================================
export async function getIssuePreviewPdf(c: Ctx): Promise<Response> {
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
    if (!issue.preview_pdf_object_key) {
      return c.json({ error: 'No preview available for this issue' }, 404);
    }

    const object = await c.env.PDFS.get(issue.preview_pdf_object_key);
    if (!object) {
      return c.json({ error: 'Preview PDF not yet uploaded' }, 404);
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}-preview.pdf"`,
      },
    });
  } catch (err) {
    console.error('Error serving issue preview PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

// =============================================================================
// GET /issues/:slug/articles/:articleSlug/preview-pdf
// Public. Same as above, for one article's preview PDF.
// =============================================================================
export async function getArticlePreviewPdf(c: Ctx): Promise<Response> {
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

    const article = findArticle(issue, articleSlug);
    if (!article) {
      return c.json({ error: 'Article not found' }, 404);
    }
    if (!article.preview_pdf_object_key) {
      return c.json({ error: 'No preview available for this article' }, 404);
    }

    const object = await c.env.PDFS.get(article.preview_pdf_object_key);
    if (!object) {
      return c.json({ error: 'Preview PDF not yet uploaded' }, 404);
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}-${articleSlug}-preview.pdf"`,
      },
    });
  } catch (err) {
    console.error('Error serving article preview PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

// =============================================================================
// POST /admin/issues/:slug/preview-pdf
// Admin-only. Same multipart/form-data shape as POST /admin/issues/:slug/pdf
// (src/index.ts) — one "file" field. Unlike the main PDF's key (which the
// admin types in by hand, see admin-pannel.html), the preview PDF's R2 key
// is server-computed, same as the cover image's.
// =============================================================================
export async function uploadIssuePreviewPdf(c: Ctx): Promise<Response> {
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

    const key = `previews/${slug}.pdf`;
    console.log('Uploading issue preview PDF — slug:', slug, 'file:', file.name, 'size:', file.size, 'R2 key:', key);
    await c.env.PDFS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: 'application/pdf' },
    });

    await db.patchDoc(`issues/${issue._id}`, { preview_pdf_object_key: key });

    return c.json({ ok: true, key });
  } catch (err) {
    console.error('Error uploading issue preview PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

// =============================================================================
// POST /admin/issues/:slug/articles/:articleSlug/preview-pdf
// Admin-only. Same shape again. Firestore's REST API has no way to patch one
// element of an array field in place, so this reads the full `articles`
// array, replaces the matching entry, and writes the whole array back — the
// same thing editing any other article field from the admin wizard already
// has to do.
// =============================================================================
export async function uploadArticlePreviewPdf(c: Ctx): Promise<Response> {
  const { slug, articleSlug } = c.req.param();
  try {
    const db = getFirestore(c.env);
    const issue = await db.queryFirst('issues', [['slug', slug]]);
    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }

    const articles: Article[] = Array.isArray(issue.articles) ? issue.articles : [];
    const index = articles.findIndex((a) => a.slug === articleSlug);
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

    const key = `previews/${slug}/${articleSlug}.pdf`;
    console.log(
      'Uploading article preview PDF — slug:', slug, 'article:', articleSlug,
      'file:', file.name, 'size:', file.size, 'R2 key:', key,
    );
    await c.env.PDFS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: 'application/pdf' },
    });

    const updatedArticles = articles.slice();
    updatedArticles[index] = { ...updatedArticles[index], preview_pdf_object_key: key };
    await db.patchDoc(`issues/${issue._id}`, { articles: updatedArticles });

    return c.json({ ok: true, key });
  } catch (err) {
    console.error('Error uploading article preview PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}

// =============================================================================
// GET /assets/end-of-preview-pdf
// Public. The single, global end-of-preview page — see END_OF_PREVIEW_PDF_KEY
// above. 404 (not an error state the frontend needs to alarm on) if it
// hasn't been uploaded yet; journal-preview.html / article-preview.html fall
// back to a plain card when this fails.
// =============================================================================
export async function getEndOfPreviewPdf(c: Ctx): Promise<Response> {
  try {
    const object = await c.env.PDFS.get(END_OF_PREVIEW_PDF_KEY);
    if (!object) {
      return c.json({ error: 'End-of-preview PDF not yet uploaded' }, 404);
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="end-of-preview.pdf"',
        // Same global object for every visitor on every issue/article preview
        // — safe to cache more aggressively than a per-issue preview PDF.
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error('Error serving end-of-preview PDF:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
