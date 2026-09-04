import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { JWTPayload } from 'jose';
import type { Env } from './types';
import { authMiddleware } from './auth';
import { adminMiddleware } from './admin';
import { getFirestore } from './firestore';

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

app.get('/issues/:slug/pdf', authMiddleware, async (c) => {
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

export default app;
