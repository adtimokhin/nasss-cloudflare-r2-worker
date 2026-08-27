# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project layout

All source code lives under `delicate-term-de7d/`. Run all commands from that directory.

- `src/index.ts` — worker entry point; exports a `fetch` handler (Hono app)
- `src/auth.ts` — Firebase ID token verification middleware
- `src/admin.ts` — admin role check against `members/{uid}.role` in Firestore
- `src/firestore.ts` — Firestore REST client; mints a service-account OAuth2 token
- `wrangler.jsonc` — Wrangler config (bindings, compatibility flags, name)
- `test/index.spec.ts` — vitest tests using `@cloudflare/vitest-pool-workers`
- `worker-configuration.d.ts` — auto-generated `Env` type (regenerate with `cf-typegen`)

## Commands

All commands run from `delicate-term-de7d/`:

```
npm run dev        # local dev server at http://localhost:8787
npm run test       # run vitest test suite
npm run deploy     # deploy to Cloudflare
npm run cf-typegen # regenerate TypeScript types after changing wrangler.jsonc bindings
```

Run a single test file: `npx vitest run test/index.spec.ts`

## Architecture

This is a Cloudflare Workers project. The worker runtime has important constraints vs. Node.js:

- **No persistent in-process state** — use KV, R2, D1, or Durable Objects for storage
- **`nodejs_compat` flag is enabled** — Node.js built-ins are available but check CF docs for which ones
- **`Env` type** is generated from `wrangler.jsonc` bindings via `npm run cf-typegen`; the `worker-configuration.d.ts` file should not be edited manually
- **Tests** run inside the actual Workers runtime via `@cloudflare/vitest-pool-workers`; use `cloudflare:test` imports (`env`, `SELF`, `createExecutionContext`) rather than mocking

## Key guidance (from AGENTS.md)

Always retrieve current Cloudflare documentation before working on Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK tasks — runtime APIs and limits change frequently. Docs at `https://developers.cloudflare.com/workers/`. After changing bindings in `wrangler.jsonc`, run `npm run cf-typegen`.
