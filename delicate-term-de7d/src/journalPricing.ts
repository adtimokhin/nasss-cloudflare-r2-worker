import type { Context } from 'hono';
import type { JWTPayload } from 'jose';
import Stripe from 'stripe';
import type { Env, Article } from './types';
import { getFirestore } from './firestore';
import { stripeClient } from './stripe';

// -----------------------------------------------------------------------------
// Admin-only: creates/updates the Stripe Product + Price behind an issue's or
// article's individual purchase price, so admin-pannel.html never has to ask
// for a hand-typed Price ID — it posts a dollar amount, this does the Stripe
// side of it.
//
// Stripe Prices are immutable (no "edit the amount" API) — the only way to
// change a price is to create a new Price and stop offering the old one.
// upsertStripePrice() below does exactly that: it reuses the same Product
// (renaming it to track title edits), and either reuses the existing Price
// if the amount/currency are unchanged, or creates a new one and archives
// (`active: false`) the old one. Archiving, not deleting — a Price already
// referenced by a completed Checkout Session or a Purchase/Subscription doc
// must keep existing and keep resolving, just stop being offered for new
// checkouts. This is also why admin-pannel.html separately blocks removing
// an already-priced article from an issue's table of contents: deleting the
// Article record itself would orphan that history-bearing price_id.
// -----------------------------------------------------------------------------

type Ctx = Context<{ Bindings: Env; Variables: { user: JWTPayload } }>;

function parsePriceBody(body: unknown): { amountCents: number; currency: string } | { error: string } {
  const b = (body ?? {}) as { amount_cents?: unknown; currency?: unknown };
  if (typeof b.amount_cents !== 'number' || !Number.isInteger(b.amount_cents) || b.amount_cents <= 0) {
    return { error: 'amount_cents must be a positive integer' };
  }
  const currency = typeof b.currency === 'string' && b.currency ? b.currency : 'usd';
  return { amountCents: b.amount_cents, currency };
}

// =============================================================================
// POST /admin/issues/:slug/price — body: { amount_cents, currency? }.
// Patches stripe_product_id/price_id/price_cents/currency onto the issue doc
// and returns them.
// =============================================================================
export async function upsertIssuePrice(c: Ctx): Promise<Response> {
  const { slug } = c.req.param();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parsePriceBody(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const db = getFirestore(c.env);
  const issue = await db.queryFirst('issues', [['slug', slug]]);
  if (!issue) return c.json({ error: 'Issue not found' }, 404);

  try {
    const stripe = stripeClient(c.env);
    const result = await upsertStripePrice(stripe, {
      existingProductId: (issue.stripe_product_id as string | null) ?? null,
      existingPriceId: (issue.price_id as string | null) ?? null,
      name: `${issue.title || issue.slug} — Single Issue Purchase`,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
    });

    await db.patchDoc(`issues/${issue._id}`, {
      stripe_product_id: result.productId,
      price_id: result.priceId,
      price_cents: parsed.amountCents,
      currency: parsed.currency,
    });

    return c.json({ price_id: result.priceId, price_cents: parsed.amountCents, currency: parsed.currency });
  } catch (err) {
    console.error('Error upserting issue Stripe price:', err);
    return c.json({ error: 'Failed to create/update Stripe price' }, 500);
  }
}

// =============================================================================
// POST /admin/issues/:slug/articles/:articleSlug/price — same shape, scoped
// to one article. Firestore's REST API can't patch one array element in
// place, so this reads the full `articles` array, updates the matching
// entry, and writes the whole array back (same pattern as the article
// preview-PDF upload endpoint in src/journalPreview.ts).
// =============================================================================
export async function upsertArticlePrice(c: Ctx): Promise<Response> {
  const { slug, articleSlug } = c.req.param();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parsePriceBody(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const db = getFirestore(c.env);
  const issue = await db.queryFirst('issues', [['slug', slug]]);
  if (!issue) return c.json({ error: 'Issue not found' }, 404);

  const articles: Article[] = Array.isArray(issue.articles) ? issue.articles : [];
  const index = articles.findIndex((a) => a.slug === articleSlug);
  if (index === -1) return c.json({ error: 'Article not found' }, 404);
  const article = articles[index];

  try {
    const stripe = stripeClient(c.env);
    const result = await upsertStripePrice(stripe, {
      existingProductId: article.stripe_product_id ?? null,
      existingPriceId: article.price_id ?? null,
      name: `${article.title} — Single Article Purchase`,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
    });

    const updatedArticles = articles.slice();
    updatedArticles[index] = {
      ...article,
      stripe_product_id: result.productId,
      price_id: result.priceId,
      price_cents: parsed.amountCents,
      currency: parsed.currency,
    };
    await db.patchDoc(`issues/${issue._id}`, { articles: updatedArticles });

    return c.json({ price_id: result.priceId, price_cents: parsed.amountCents, currency: parsed.currency });
  } catch (err) {
    console.error('Error upserting article Stripe price:', err);
    return c.json({ error: 'Failed to create/update Stripe price' }, 500);
  }
}

// =============================================================================
// Shared create-or-replace logic — see the file-level comment for why this
// doesn't just call stripe.prices.update().
// =============================================================================
async function upsertStripePrice(
  stripe: Stripe,
  opts: { existingProductId: string | null; existingPriceId: string | null; name: string; amountCents: number; currency: string },
): Promise<{ productId: string; priceId: string }> {
  let productId = opts.existingProductId;

  if (productId) {
    // Keeps the Stripe dashboard's product name in sync with an issue/article
    // title edit — cheap, and avoids stale names accumulating there.
    await stripe.products.update(productId, { name: opts.name });
  } else {
    const product = await stripe.products.create({ name: opts.name });
    productId = product.id;
  }

  // Reuse the existing price outright if nothing actually changed — avoids
  // minting a pointless new Price (and archiving a perfectly good one) every
  // time the admin re-saves without touching the amount.
  if (opts.existingPriceId) {
    const existing = await stripe.prices.retrieve(opts.existingPriceId);
    if (existing.active && existing.unit_amount === opts.amountCents && existing.currency === opts.currency) {
      return { productId, priceId: existing.id };
    }
  }

  const newPrice = await stripe.prices.create({
    product: productId,
    unit_amount: opts.amountCents,
    currency: opts.currency,
  });

  if (opts.existingPriceId && opts.existingPriceId !== newPrice.id) {
    try {
      await stripe.prices.update(opts.existingPriceId, { active: false });
    } catch (err) {
      // Non-fatal: the new price is already live and about to be saved — a
      // stray still-active old price is Stripe-dashboard clutter, not a
      // correctness problem (nothing in Firestore references it anymore).
      console.error('Failed to archive old Stripe price', opts.existingPriceId, err);
    }
  }

  return { productId, priceId: newPrice.id };
}
