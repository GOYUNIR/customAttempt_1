# Deploying to Cloudflare

This storefront is deliberately platform-agnostic — every route talks to
Upstash Redis, Stripe and Resend over plain HTTPS, and the public routes
already emit `Cache-Control` **and** `CDN-Cache-Control` headers that
Cloudflare's edge honors. Deploying to Cloudflare means two pieces:

| Piece | What it is | Config |
| --- | --- | --- |
| **Main storefront** | The whole Next.js app (pages, `/api/*`, proxy, `/og`, `/icon`, `/media`) as ONE Cloudflare Worker via the official OpenNext adapter | `open-next.config.ts` + `wrangler.jsonc` (repo root) |
| **Daily safety net** | A tiny scheduled Worker that pings `/api/checkout/cron-draw`, `/api/cron/recovery` and `/api/analytics/social-tick` once a day | `cron-worker/` |

> 💡 Draws also fire in **real time** from the client countdown trigger, so the
> scheduled worker is only a backstop — but you should still run it so a drop
> never silently misses when nobody has a tab open.

---

## 0. Prerequisites

- Node.js 20+ and `npm`.
- A Cloudflare account (free plan works; the **Workers Paid** plan ($5/mo)
  removes CPU/scheduling limits and is recommended once the store has real
  traffic).
- The domain you want the store on, added to Cloudflare DNS (or use the free
  `*.workers.dev` subdomain to test first).
- `npx wrangler login` — opens the browser to authorize `wrangler`.

```bash
cd e-commerce-store

# Install the OpenNext Cloudflare adapter + wrangler (dev-only):
npm install -D @opennextjs/cloudflare@latest wrangler@latest
```

> ⚠️ Verify the adapter's peer range supports your Next version before relying
> on it: `npm ls next` then check the `@opennextjs/cloudflare` README. If the
> adapter does not yet support the Next major you're on, use the
> "Any other Node host" path (plain `next build` + `next start`) on a VPS or
> Railway/Render/Fly instead — everything else in this repo is host-agnostic.

---

## 1. Build with OpenNext

**Set the build-time (public) env vars in your shell FIRST.** `NEXT_PUBLIC_*`
variables are inlined into the bundle at build time — they cannot be set later
in the Workers dashboard.

```bash
# macOS / Linux / Git Bash
export NEXT_PUBLIC_URL=https://your-store.com
export NEXT_PUBLIC_SITE_NAME="Your Brand"
export NEXT_PUBLIC_MAPBOX_TOKEN=pk_live_xxxxxxxxxxxx
npx opennextjs-cloudflare build
```

```powershell
# Windows PowerShell
$env:NEXT_PUBLIC_URL   = "https://your-store.com"
$env:NEXT_PUBLIC_SITE_NAME = "Your Brand"
$env:NEXT_PUBLIC_MAPBOX_TOKEN = "pk_live_xxxxxxxxxxxx"
npx opennextjs-cloudflare build
```

The build outputs `.open-next/worker.js` (the app) and `.open-next/assets`
(static files) — exactly what the root `wrangler.jsonc` expects.

> `NEXT_PUBLIC_MAPBOX_TOKEN` is optional (address autofill is a nice-to-have).
> `NEXT_PUBLIC_URL` can be skipped too — when unset the app falls back to the
> platform's own variables, and Cloudflare Workers/Pages provides
> `CF_PAGES_URL` automatically (see `lib/env.ts`).

---

## 2. Create the Worker + set runtime secrets

```bash
# Create/update the worker (name + assets come from the root wrangler.jsonc)
npx wrangler deploy

# Runtime secrets — each one prompts interactively; paste the value, press Enter
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_BASIC_AUTH_USERNAME
npx wrangler secret put ADMIN_BASIC_AUTH_PASSWORD
npx wrangler secret put ADMIN_VERIFY_EMAIL
npx wrangler secret put CRON_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM

# Optional but recommended:
npx wrangler secret put SUPPORT_EMAIL
npx wrangler secret put BRAND_NAME
npx wrangler secret put STRIPE_PRODUCT_ID
```

Any time you change a secret, run `npx wrangler deploy` again (or use the
dashboard's **Workers → your worker → Settings → Variables**).

---

## 3. Custom domain (skip if testing on `*.workers.dev`)

**Workers custom domain** (recommended — no extra routing):

```bash
npx wrangler domains add your-store.com
```

or the dashboard: **Workers → `storefront-app` → Settings → Domains → Add**.
Then add the CNAME record Cloudflare asks for (or let it do it automatically).
Set `NEXT_PUBLIC_URL` at build time so metadata/emails/OG cards point at the
real domain.

> ℹ️ The admin **SetUp tab** (`/admin → SetUp`) shows ✓/✗ status for every env
> var and a production launch checklist — use it after the first deploy.

---

## 4. Deploy the daily safety-net cron worker

```bash
cd cron-worker

# Deploy (wrangler.jsonc defines the daily 0 0 * * * trigger)
npx wrangler deploy

# Point it at the store + share the same CRON_SECRET used everywhere else
npx wrangler secret put TARGET_URL     # e.g. https://your-store.com
npx wrangler secret put CRON_SECRET
cd ..
```

That's the whole setup. Cloudflare's scheduler now calls the worker at
`00:00 UTC` daily; it forwards the run to your store's three safety-net
endpoints with `Authorization: Bearer $CRON_SECRET` (the same contract as
Vercel's cron and Netlify's scheduled function — see `lib/cron-auth.ts`).

---

## 5. Verify the deployment

1. **Storefront** — open your domain: seed defaults from `/admin → Developer →
   Seed Defaults`, confirm products render on `/` and `/catalog`, and open one
   product page (the gallery, countdown, size chips and CTA should work).
2. **Admin security** — `/admin` prompts for Basic Auth + the emailed two-step
   code. Both must work before anything else.
3. **Site Self-Test** — `/admin → Developer → Site Self-Test` should pass
   (Redis connected, schema tidy, promos readable).
4. **Edge caching** — `curl -sI https://your-store.com/api/store | grep -i cache`
   should show `cache-control: public, s-maxage=10, stale-while-revalidate=30`
   and `cdn-cache-control: ...`. `/og` and `/media/*` should be `immutable`
   with `?v=` hashes.
5. **Drop safety net** — trigger the cron manually once:
   `curl -X POST https://your-store.com/api/checkout/cron-draw -H "Authorization: Bearer $CRON_SECRET"`
   (a 200 means the engine ran; it's idempotent).
6. **Webhook** — in Stripe, set the webhook URL to
   `https://your-store.com/api/stripe/webhook` and re-send a test event; the
   Stripe dashboard should show 200.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `NEXT_PUBLIC_*` values are empty on the site | They are build-time — set them in your shell before `opennextjs-cloudflare build`, then redeploy. |
| `/api/*` returns 500 with Redis errors | `UPSTASH_REDIS_REST_URL`/`TOKEN` secrets not set, or the REST pair is wrong (wire `redis://` URLs are skipped — use the REST URLs from Upstash). |
| Cron worker logs `SKIPPED — TARGET_URL or CRON_SECRET not configured` | Run `npx wrangler secret put TARGET_URL` and `... CRON_SECRET` inside `cron-worker/`. |
| `Worker size too large` at deploy | The OpenNext bundle can be trimmed via `open-next.config.ts` (exclude unused incremental cache) or by moving heavy deps out of the bundle. |
| `ERROR Node.js middleware is not currently supported` at build | Next.js 16 renamed middleware to `proxy`, and `proxy.ts` is HARDCODED to the Node.js runtime — OpenNext Cloudflare only supports the legacy **Edge** `middleware` convention. Rename `proxy.ts` → `middleware.ts` (export `middleware`, keep the matcher) and **do NOT** add `runtime: 'edge'` to its config (Next 16.2.12 rejects it with E1015; `middleware.ts` is Edge by default). See the 2026-08-20 AGENTS.md changelog entry. |
| The proxy/middleware doesn't run | OpenNext v3.6+ supports Next middleware — make sure `@opennextjs/cloudflare` is at the latest version. |
| Admin email (2FA / winners) never arrives | `RESEND_API_KEY` + `RESEND_FROM` secrets missing, or the code only echoes in non-production (see `lib/customer-verify.ts` / `lib/admin-verify.ts`). |
| `CF_PAGES_URL` fallback not used | Only applies when no `NEXT_PUBLIC_URL`/`NEXT_PUBLIC_SITE_URL`/`SITE_URL` is set anywhere — otherwise the configured URL wins by design. |

---

## Notes

- **The whole app is one Worker** — there are no separate functions, so the
  `/admin` proxy guard, `/og` image card, `/icon` favicon and `/media` streams
  behave exactly like the Vercel deploy. No code changes are needed for
  Cloudflare; the same `npm test` / `npm run lint` / `npm run typecheck` gates
  apply.
- **Cloudflare Pages alternative** — if you prefer Pages (git-connected CI +
  `pages.dev` previews), the same OpenNext adapter supports Pages deploys.
  Point the CI at this repo, run the OpenNext build with the public env vars,
  and deploy the `.open-next` output as a Pages project. The cron worker stays
  a separate Workers project either way.
- **Cache invalidation is already handled** — `/media` and `/og` URLs carry
  `?v=` content hashes that change on admin saves, and the JSON routes use
  short `s-maxage` + `stale-while-revalidate`, so stale Cloudflare edge copies
  are never served.
