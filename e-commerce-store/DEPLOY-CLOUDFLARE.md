# Deploying to Cloudflare (Workers)

This storefront is deliberately platform-agnostic — every route talks to
Upstash Redis, Stripe and Resend over plain HTTPS, and the public routes
already emit `Cache-Control` **and** `CDN-Cache-Control` headers that
Cloudflare's edge honors. This guide walks you through the whole setup end to
end: **follow the steps in order and copy/paste the commands**. There are six
steps and each one tells you exactly what to type and what you should see.

Deploying to Cloudflare means two pieces:

| Piece | What it is | Config |
| --- | --- | --- |
| **1. Main storefront** | The whole Next.js app (pages, `/api/*`, middleware, `/og`, `/icon`, `/media`) as ONE Cloudflare Worker via the official OpenNext adapter | `open-next.config.ts` + `wrangler.jsonc` (repo root) |
| **2. Daily safety net** | A tiny scheduled Worker that pings `/api/checkout/cron-draw`, `/api/cron/recovery` and `/api/analytics/social-tick` once a day | `cron-worker/` |

> 💡 Draws also fire in **real time** from the client countdown trigger, so the
> scheduled worker is only a backstop — but you should still run it so a drop
> never silently misses when nobody has a tab open.

---

## Before you start — prerequisites (do these once)

- [ ] **Node.js 20+ and `npm`** installed (`node -v` shows v20 or newer).
- [ ] A **Cloudflare account** (free plan works; the **Workers Paid** plan
  ($5/mo) removes CPU/scheduling limits and is recommended once the store has
  real traffic).
- [ ] An **Upstash Redis database** with its REST URL + token handy (create one
  at upstash.com → Console → Create database → copy
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).
- [ ] Your **Stripe** API keys + webhook signing secret handy.
- [ ] An email address for the admin two-step codes (`ADMIN_VERIFY_EMAIL`).
- [ ] Log in to Cloudflare from the terminal (opens your browser; pick the
  account you'll deploy to and confirm — once per machine):

```bash
npx wrangler login
```

---

## The big picture (six steps)

| Step | What you run | Produces |
| --- | --- | --- |
| 1. Install dependencies | `npm install` | Ready-to-build repo |
| 2. Build the app | `npm run build:cloudflare` | `.open-next/worker.js` + `.open-next/assets` |
| 3. Deploy + set runtime secrets | `npx wrangler deploy` + `npx wrangler secret put …` | Live store on `*.workers.dev` |
| 4. Attach your domain | `npx wrangler domains add …` | Store on your real domain |
| 5. Deploy the cron worker | `cd cron-worker` + `npx wrangler deploy` + secrets | Daily draw safety net |
| 6. Verify | checklist below | Confirmed working store |

---

## Step 1 — Install dependencies

The OpenNext Cloudflare adapter (`@opennextjs/cloudflare`) and `wrangler` are
**already in `package.json`** — there is nothing extra to install:

```bash
npm install
```

> If you ever want the newest adapter later: `npm install @opennextjs/cloudflare@latest wrangler@latest`.

---

## Step 2 — Build the app

### The two kinds of environment variables (do not mix these up)

| Kind | Variables | When you set them | Where they live |
| --- | --- | --- | --- |
| **BUILD-TIME** | `NEXT_PUBLIC_URL`, `NEXT_PUBLIC_SITE_NAME`, `NEXT_PUBLIC_MAPBOX_TOKEN` | In your shell **before** you run the build | Inlined into the code — **cannot** be changed later in the dashboard |
| **RUNTIME** | everything else (Redis, Stripe, admin, Resend…) | After the worker is deployed (Step 3) | `npx wrangler secret put` — stored encrypted server-side |

**Set the build-time vars in your shell FIRST, then build:**

```bash
# macOS / Linux / Git Bash
export NEXT_PUBLIC_URL=https://your-store.com
export NEXT_PUBLIC_SITE_NAME="Your Brand"
export NEXT_PUBLIC_MAPBOX_TOKEN=pk_live_xxxxxxxxxxxx
npm run build:cloudflare
```

```powershell
# Windows PowerShell
$env:NEXT_PUBLIC_URL       = "https://your-store.com"
$env:NEXT_PUBLIC_SITE_NAME = "Your Brand"
$env:NEXT_PUBLIC_MAPBOX_TOKEN = "pk_live_xxxxxxxxxxxx"
npm run build:cloudflare
```

`npm run build:cloudflare` runs the Mapbox-token injection step, then the
OpenNext build. It outputs `.open-next/worker.js` (the whole app) and
`.open-next/assets` (static files) — exactly what the root `wrangler.jsonc`
expects.

> - `NEXT_PUBLIC_MAPBOX_TOKEN` is **optional** (address autofill is a
>   nice-to-have; without it customers type addresses manually).
> - `NEXT_PUBLIC_URL` is **optional too** — when unset the app falls back to the
>   request host automatically. Set it once you attach your real domain (Step 4)
>   and rebuild once, so emails/OG cards always use it.

---

## Step 3 — Deploy the Worker + set runtime secrets

**Deploy first, then add secrets** — `wrangler secret put` attaches to an
existing worker, so this order matters.

```bash
# 1. Create/update the worker (name + assets come from the root wrangler.jsonc)
npx wrangler deploy
```

You should see a success message with a `*.workers.dev` URL at the end. Open it
— the page will load, but `/api/*` will error until you add the secrets below.

**2. Set the runtime secrets** (each command prompts you; paste the value and
press Enter):

```bash
# REQUIRED — without these nothing works:
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ADMIN_BASIC_AUTH_PASSWORD
npx wrangler secret put ADMIN_VERIFY_EMAIL

# RECOMMENDED — needed for draws + transactional email:
npx wrangler secret put CRON_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM

# OPTIONAL — brand polish:
npx wrangler secret put SUPPORT_EMAIL
npx wrangler secret put BRAND_NAME
npx wrangler secret put STRIPE_PRODUCT_ID
```

> Secrets take effect **immediately** — you do NOT need to redeploy after
> changing one. To change a secret later, re-run `wrangler secret put` or edit
> it in the dashboard: **Workers → `storefront-app` → Settings → Variables →
> Edit**.

---

## Step 4 — Attach your domain (skip if testing on `*.workers.dev`)

**Workers custom domain** (recommended — no extra routing, no DNS fiddling):

```bash
npx wrangler domains add your-store.com
```

or click through the dashboard: **Workers → `storefront-app` → Settings →
Domains → Add** — Cloudflare creates the CNAME record for you.

Once the domain is live, **rebuild with `NEXT_PUBLIC_URL=https://your-store.com`
(Step 2) and re-run `npx wrangler deploy`** so metadata, emails and OG cards
point at the real domain.

> ℹ️ The admin **SetUp tab** (`/admin → SetUp`) shows ✓/✗ status for every env
> var and a production launch checklist — use it after the first deploy.

---

## Step 5 — Deploy the daily safety-net cron worker

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

## Step 6 — Verify the deployment

1. **Storefront** — open your domain: run **Seed Defaults** from
   `/admin → Developer → Seed Defaults`, confirm products render on `/` and
   `/catalog`, and open one product page (the gallery, countdown, size chips
   and CTA should work).
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
| `✘ Could not find Worker` when putting secrets | You ran `wrangler secret put` **before** `wrangler deploy`. Run `npx wrangler deploy` first. |
| `✘ authorization` / `1033` login errors | Not logged in (or logged into the wrong account). Run `npx wrangler login` and retry. |
| `NEXT_PUBLIC_*` values are empty on the site | They are build-time — set them in your shell before `npm run build:cloudflare`, then redeploy. |
| `/api/*` returns 500 with Redis errors | `UPSTASH_REDIS_REST_URL`/`TOKEN` secrets not set, or the REST pair is wrong (wire `redis://` URLs are skipped — use the REST URLs from Upstash). |
| Cron worker logs `SKIPPED — TARGET_URL or CRON_SECRET not configured` | Run `npx wrangler secret put TARGET_URL` and `npx wrangler secret put CRON_SECRET` inside `cron-worker/` (deploy the worker first). |
| `Worker size too large` at deploy | The OpenNext bundle can be trimmed via `open-next.config.ts` (exclude unused incremental cache) or by moving heavy deps out of the bundle. |
| `ERROR Node.js middleware is not currently supported` at build | This template already ships the legacy **Edge** `middleware.ts` convention (the Next 16 `proxy.ts` rename — see the 2026-08-20 AGENTS.md changelog). Make sure `@opennextjs/cloudflare` is at the latest version and rebuild. |
| The proxy/middleware doesn't run | OpenNext supports Next middleware — make sure `@opennextjs/cloudflare` is at the latest version (`npm install @opennextjs/cloudflare@latest wrangler@latest`). |
| Admin email (2FA / winners) never arrives | `RESEND_API_KEY` + `RESEND_FROM` secrets missing, or the code only echoes in non-production (see `lib/customer-verify.ts` / `lib/admin-verify.ts`). |
| `CF_PAGES_URL` fallback not used | Only applies when no `NEXT_PUBLIC_URL`/`NEXT_PUBLIC_SITE_URL`/`SITE_URL` is set anywhere — otherwise the configured URL wins by design. |

---

## Notes

- **The whole app is one Worker** — there are no separate functions, so the
  `/admin` middleware guard, `/og` image card, `/icon` favicon and `/media`
  streams behave exactly like the Vercel deploy. No code changes are needed for
  Cloudflare; the same `npm test` / `npm run lint` / `npm run typecheck` gates
  apply.
- **Cloudflare Pages alternative** — if you prefer Pages (git-connected CI +
  `pages.dev` previews), the same OpenNext adapter supports Pages deploys.
  Point the CI at this repo, run `npm run build:cloudflare` with the public env
  vars, and deploy the `.open-next` output as a Pages project. The cron worker
  stays a separate Workers project either way.
- **Cache invalidation is already handled** — `/media` and `/og` URLs carry
  `?v=` content hashes that change on admin saves, and the JSON routes use
  short `s-maxage` + `stale-while-revalidate`, so stale Cloudflare edge copies
  are never served.
