# NASSS API — PDF Worker

A Cloudflare Worker API that serves magazine issues from Cloudflare R2, gated by **Firebase Authentication**. Built with [Hono](https://hono.dev/).

## How it works

- **Public routes** return issue metadata and cover images from Firestore / R2 with no auth.
- **Protected routes** require a valid Firebase ID token (`Authorization: Bearer <token>`). The token is verified against Google's public Secure Token keys — issuer `https://securetoken.google.com/<project-id>`, audience `<project-id>`. No shared secret is stored in the Worker.
- **Admin routes** additionally check that the authenticated user has `role = 'admin'` in their `members/{uid}` document in Firestore before allowing PDF or cover uploads.

The Worker talks to Firestore over its **REST API**, authenticating as a Google **service account** (there is no Firebase Admin SDK that runs on Workers). Every request from the Worker uses that service account, so it bypasses Firestore Security Rules — the security boundary is that the service-account key lives only inside this Worker.

## Project structure

```
src/
  index.ts      — Hono app, all route handlers
  auth.ts       — Firebase ID token verification middleware
  admin.ts      — Admin role-check middleware (members/{uid}.role)
  firestore.ts  — Firestore REST client + service-account token minting
  types.ts      — Env and Issue types
```

---

## Setup

### 1. Create the R2 bucket

The bucket name **must** match `wrangler.jsonc` before the worker can deploy:

```bash
wrangler r2 bucket create nasss-api-files
```

### 2. Create a Firebase service account

In the Firebase console → **Project settings → Service accounts → Generate new private key**. This downloads a JSON file containing `project_id`, `client_email`, and `private_key`. You will use those three values as the secrets below.

The default `firebase-adminsdk-*` service account already has the **Cloud Datastore User** role, which is all the Worker needs (read/write Firestore).

### 3. Set secrets

Run each command and enter the value when prompted:

```bash
wrangler secret put FIREBASE_PROJECT_ID     # from the JSON: "project_id"
wrangler secret put FIREBASE_CLIENT_EMAIL   # from the JSON: "client_email"
wrangler secret put FIREBASE_PRIVATE_KEY    # from the JSON: "private_key" — paste verbatim, including the -----BEGIN/END----- lines
wrangler secret put ALLOWED_ORIGIN          # frontend origin, e.g. https://yoursite.vercel.app (comma-separated for multiple)
```

> `FIREBASE_PRIVATE_KEY` contains newlines. When set via `wrangler secret put` you can paste the multi-line value directly. In `.dev.vars` it must be a single quoted line with literal `\n` escapes (the Worker converts `\n` back to real newlines).

### 4. Firestore data model

No Firestore configuration (indexes, rules) is required for this Worker. It only needs two collections:

**`issues`** — one document per magazine issue:

| Field | Type | Notes |
|-------|------|-------|
| `issue_number` | number | used for ordering |
| `issue_date` | string | ISO date |
| `slug` | string | unique; used in URLs |
| `cover_image_url` | string \| null | set by the cover upload route |
| `pdf_object_key` | string | R2 key the PDF is stored under |
| `title` | string \| null | |
| `published` | boolean | public routes only return `true` |

The Worker queries `issues` with equality filters only (`published == true`, `slug == …`) and sorts by `issue_number` in memory, so **no composite index is needed**.

**`members/{uid}`** — one document per user, keyed by Firebase UID:

| Field | Type | Notes |
|-------|------|-------|
| `role` | string | `"admin"` grants access to the admin routes |

To grant admin access, set `role: "admin"` on that user's `members` document.

---

## Local development

Copy the example env file and fill in real values:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` is gitignored. It is loaded automatically by `wrangler dev`.

Start the dev server:

```bash
npm run dev
# Worker available at http://localhost:8787
```

> The R2 binding in local dev hits the **real** bucket by default. Pass `--local` to `wrangler dev` if you want an in-memory R2 simulation instead. Firestore is always the real project.

---

## Deploy

```bash
npm run deploy
```

---

## API reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | Public | Returns `{"ok":true}` |
| `GET` | `/issues` | Public | List all published issues (slug, number, date, cover, title) |
| `GET` | `/issues/:slug/pdf` | Firebase ID token | Stream the PDF for a published issue from R2 |
| `POST` | `/admin/issues/:slug/pdf` | Token + Admin | Upload a PDF for an issue (multipart `file` field) |
| `GET` | `/covers/:filename` | Public | Serve a cover image from R2 (long-lived cache headers) |
| `POST` | `/admin/issues/:slug/cover` | Token + Admin | Upload a cover image; updates `cover_image_url` in Firestore |
| `GET` | `/debug/list-bucket` | Firebase ID token | List all R2 object keys — **remove before production** |

### Request / response notes

**`GET /issues`**
```json
{
  "issues": [
    {
      "slug": "issue-042",
      "issue_number": 42,
      "issue_date": "2024-03-01",
      "cover_image_url": "https://worker.example.com/covers/issue-042.jpg",
      "title": "Spring Edition"
    }
  ]
}
```

**`GET /issues/:slug/pdf`**
- Returns the PDF as `application/pdf` with `Content-Disposition: inline`.
- Returns `{"status":"authenticated","message":"Auth works. PDF not yet uploaded.",...}` if the issue exists but no PDF has been uploaded yet.

**`POST /admin/issues/:slug/pdf`**
- Body: `multipart/form-data` with a `file` field containing the PDF.
- The R2 key used is whatever is stored in `issues.pdf_object_key` for that slug.

**`POST /admin/issues/:slug/cover`**
- Body: `multipart/form-data` with a `file` field containing any image.
- The image is stored at `covers/<slug>.<ext>` in R2.
- `issues.cover_image_url` is updated to the public Worker URL for the image.

---

## curl examples

### Health check

```bash
curl http://localhost:8787/health
# {"ok":true}
```

### List issues

```bash
curl http://localhost:8787/issues
```

### Get a PDF (authenticated)

```bash
TOKEN="eyJhbGci..."

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/issues/issue-042/pdf \
  --output issue-042.pdf
```

### Upload a PDF (admin)

```bash
TOKEN="eyJhbGci..."

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/issue-042.pdf" \
  http://localhost:8787/admin/issues/issue-042/pdf
# {"ok":true,"key":"issues/issue-042.pdf"}
```

### Upload a cover image (admin)

```bash
TOKEN="eyJhbGci..."

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/cover.jpg" \
  http://localhost:8787/admin/issues/issue-042/cover
# {"ok":true,"key":"covers/issue-042.jpg","url":"https://worker.example.com/covers/issue-042.jpg"}
```

### Fetch a cover image (public)

```bash
curl http://localhost:8787/covers/issue-042.jpg --output cover.jpg
```

### List R2 bucket contents (debug)

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/debug/list-bucket
```

---

## Getting a Firebase ID token for curl testing

1. Sign in to your frontend app in a browser.
2. Open DevTools → Console and run:
   ```js
   await firebase.auth().currentUser.getIdToken()
   // or, with the modular SDK:
   // await getAuth().currentUser.getIdToken()
   ```
3. Copy the printed string — that is your ID token.
4. Use it as `TOKEN` in the curl commands above.

ID tokens expire after 1 hour. Call `getIdToken(true)` to force a refresh.

---

## Regenerating types after binding changes

After editing bindings in `wrangler.jsonc`, regenerate `worker-configuration.d.ts`:

```bash
npm run cf-typegen
```
