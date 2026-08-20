# Cloudflare cron worker (daily safety net)

The storefront's draws fire in real time from the client countdown trigger, so
they work with NO cron at all. This tiny Workers project is the **server-side
safety net** on Cloudflare — the equivalent of `vercel.json`'s cron or
`netlify/functions/cron-tasks.mjs`. Once a day it pings the app's own endpoints:

- `/api/checkout/cron-draw` → the Redis-driven auto-draw engine
- `/api/cron/recovery` → entry-recovery reminder emails
- `/api/analytics/social-tick` → social-proof counter tick

All three authenticate with `Authorization: Bearer $CRON_SECRET`
(see `lib/cron-auth.ts` in the parent app).

> ⚠️ **Deploy the main storefront app FIRST** (follow `DEPLOY-CLOUDFLARE.md` in
> the repo root) — this worker needs a deployed store URL for `TARGET_URL`.

## Deploy

From this directory (commands must be run in this order):

```bash
# 1. Deploy the worker (wrangler.jsonc defines the daily cron trigger).
#    Deploy BEFORE adding secrets — wrangler attaches secrets to an existing worker.
npx wrangler deploy

# 2. Point it at your store (the deployed URL, e.g. https://your-store.com)
npx wrangler secret put TARGET_URL

# 3. Set the shared scheduler secret (same value you use on Vercel/Netlify)
npx wrangler secret put CRON_SECRET
```

Done — Cloudflare's scheduler invokes this worker at `0 0 * * *` (UTC) every
day and it forwards the run to your store's endpoints.

## Verify

The cron fires at `00:00 UTC` daily, so right after deploying you can check the
logs: dashboard → **Workers & Pages → `storefront-cron` → Logs**. Each daily
run should log three lines like:

```
[storefront-cron] /api/checkout/cron-draw -> 200
[storefront-cron] /api/cron/recovery -> 200
[storefront-cron] /api/analytics/social-tick -> 200
```

If you see `SKIPPED — TARGET_URL or CRON_SECRET not configured`, run the two
`secret put` commands above again (the worker must be deployed first).

## How the main app deploys on Cloudflare

Deploy the main Next.js app with the official OpenNext Cloudflare adapter
(`@opennextjs/cloudflare`) — the whole app (routes, proxy, `/og`, `/media`) runs
as a single Worker, and it uses the standard `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_URL`/`KV_REST_API_TOKEN`
aliases) to talk to the same Upstash Redis, so no other code changes are needed.
The `/api/store`, `/api/catalog/status`, `/api/config/public`, `/og`, `/icon`
and `/media` responses already ship `CDN-Cache-Control` headers that
Cloudflare's edge honors.
