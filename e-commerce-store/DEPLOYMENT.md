# Deployment Runbook

This is the step-by-step production rollout sequence for this store, covering the environment schema, the Supabase migration sequence, Cloudflare Worker setup, Stripe webhook registration, and the safe order to bring each piece online. It documents what is actually built and wired today — including two explicit gaps flagged inline — rather than the aspirational end state.

## 1. Environment schema reference

The complete variable reference lives as a heavily-commented block at the top of [`wrangler.jsonc`](wrangler.jsonc) (`[REQUIRED]` / `[RECOMMENDED]` / `[OPTIONAL]` / `[SETUP WIZARD]` tags, realistic example values, and whether each value is set in the deploy environment or on-site via `/admin/setup`). That file is the source of truth for *what* to set and *where*; this section covers *validation*.

[`lib/env-schema.ts`](lib/env-schema.ts) (`validateProductionEnv()`) format-checks every credential that IS set — it never requires a variable to be present (everything can instead be entered through the Setup Wizard), but it catches a malformed value: a truncated copy-paste, a key pasted into the wrong field, a literal `"your-key-here"` placeholder, or an unresolved `${VAR}` template token. Malformed values become **errors** (hard-block production writes, enforced in `middleware.ts`); weak-but-valid values (a short `ADMIN_BASIC_AUTH_PASSWORD` or `CRON_SECRET`) become **warnings** (logged, never blocking).

Grouped by provider, the fields it validates:

| Group | Fields |
|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRODUCT_ID` |
| Resend | `RESEND_API_KEY` |
| Supabase | `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Upstash / KV | `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL`, `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` |
| Mapbox | `NEXT_PUBLIC_MAPBOX_TOKEN` |
| Admin / cron | `ADMIN_BASIC_AUTH_PASSWORD`, `CRON_SECRET` |
| Postgres cutover | `USE_POSTGRES_PRIMARY` — must be exactly `true`/`false` (case-insensitive); see §5 for what this flag actually does today |

Run `npx tsc --noEmit && node --test tests/*.test.ts` after touching this file — `tests/env-schema.test.ts` exercises every field's accept/reject boundary.

## 2. Supabase migration sequence

Apply `supabase/migrations/00001` → `00012` in order (Supabase CLI: `supabase db push`, or paste each file into the SQL editor in order). One-line purpose of each:

| Migration | Purpose |
|---|---|
| `00001` | Initial schema |
| `00002` | Operational JSONB settings store |
| `00003` | 4-tier RBAC + tenant routing |
| `00004` | AI secondary provider |
| `00005` | Stripe price ID column |
| `00006` | 3D mesh engine columns |
| `00007` | AI 3D model selector |
| `00008` | RBAC hardening, RLS policies, audit trail |
| `00009` | Commerce + B2B core: `products`, `product_variants`, `inventory_levels`, `customers`, carts, `orders`, `order_line_items`, `companies`, `quotes` |
| `00010` | Cloudflare custom domains (`tenants.cloudflare_hostname_id` / `domain_status` / `ssl_status`) |
| `00011` | Opaque variant/order metadata (raffle/FCFS/tier fields with no relational home yet — see §5) |
| `00012` | Native raffle/FCFS/waitlist/shared-pool schema: `raffle_entries`, `drop_draws`, `waitlist_entries`, `shared_inventory_pools` |

**RLS validation**: after applying migrations, run `npx tsx scripts/production-readiness-check.ts` (§6) — its `checkRlsCoverage` check (`lib/system-diagnostics.ts`) probes every sensitive table (`audit_logs`, `orders`, `customers`, `companies`, `quotes`, `raffle_entries`) with the **anon** key and fails loud if RLS doesn't block it. This is a real network probe, not a static "RLS is enabled" check.

## 3. Cloudflare Worker, KV, and custom-hostname setup

This app deploys as a **single Cloudflare Worker** (`storefront-app`, `wrangler.jsonc`) built by `@opennextjs/cloudflare` — the whole Next.js app (routes, middleware, `/og`, `/icon`, `/media`) compiles to one `.open-next/worker.js`, with static assets served through the `ASSETS` binding. There is no separate edge-router Worker and no KV namespace in this config today (see §7 for what that would take).

1. `npm run build:cloudflare` (runs `scripts/inject-mapbox-token.mjs` then `opennextjs-cloudflare build`) — `NEXT_PUBLIC_*` build-time vars must be in your shell *before* this step; they cannot be set in the Cloudflare dashboard afterward.
2. Set runtime secrets via the dashboard (**Workers & Pages → [project] → Settings → Variables and Secrets**) or `npx wrangler secret put NAME` — never commit a real secret into `wrangler.jsonc`. The full annotated list (required/recommended/optional, example values) is in that file's header comment.
3. `npx wrangler deploy` (or `npm run deploy:cf`, which chains the build first).
4. **Custom hostnames** (merchant custom domains) go through `lib/cloudflare-saas.ts`'s `/zones/:zone_id/custom_hostnames` wrapper — requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`. It fails clean (`{ ok: false, notConfigured: true }`) rather than throwing when unset, so local dev and the test suite never need real Cloudflare credentials. Status (`domain_status`/`ssl_status`) persists onto the owning tenant's row (migration `00010`) via pure mapping logic in `lib/cloudflare-status.ts` (independently unit-tested).

## 4. Stripe webhook registration, idempotency, shadow-write

1. Register a webhook endpoint at `https://<your-domain>/api/stripe/webhook` in the Stripe dashboard (or via CLI for a staging environment), subscribed to at least `checkout.session.completed` and whatever charge/payment events your raffle-charging flow needs. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Idempotency**: `lib/redis-maintenance.ts` dedupes processed Stripe session ids via `PROCESSED_SESSIONS_KEY`, a sorted set scored by timestamp (self-migrates from a legacy plain SET on first write after upgrade — no manual migration step). Verify it after a deploy via `checkWebhookIdempotency` in the readiness check (§6) — it reports the tracked-session count and retention window (72h, matching Stripe's own webhook retry window) without assuming the ZSET shape already exists.
3. **Shadow-write cutover** (`USE_POSTGRES_PRIMARY=true`): every confirmed sale (a raffle winner charged, or an FCFS purchase) is *also* mirrored into Postgres `orders`/`order_line_items` (`lib/postgres-shadow-write.ts`), immediately after — never instead of — the existing Redis archive write, which stays the real source of truth. Raffle/FCFS-specific fields with no relational home yet (`checkoutMode`, promo/tier data) land in `orders.metadata` jsonb (migration `00011`) rather than being dropped. **This deliberately does not touch `inventory_levels`** — the real Redis inventory lock already protected the actual sale; shadow-decrementing a copy that may not even have a seeded row yet would just add noise.

## 5. Zero-downtime rollout sequence

```
npx tsx scripts/production-readiness-check.ts   # confirm every check is OK/NOT_CONFIGURED, zero ERROR
npx tsx scripts/migrate-redis-to-supabase.ts --dry-run   # preview the backfill, no Supabase creds required
npx tsx scripts/migrate-redis-to-supabase.ts             # idempotent upsert backfill (safe to re-run)
# set USE_POSTGRES_PRIMARY=true in the deploy environment, then redeploy
```

**Read this before setting the flag**: `USE_POSTGRES_PRIMARY=true` does **not** make Postgres the source of truth for checkout/catalog reads, and does **not** cut over `inventory_levels`. This store's actual checkout logic (raffle drops, FCFS, waitlists, shared inventory pools) has no full relational representation in the `00009` schema yet — flipping a literal read cutover today would silently drop that business model the moment a route ran on it. What the flag *does* today, gated by `lib/feature-flags.ts`'s `isPostgresPrimaryEnabled()`:

- `lib/postgres-read-fallback.ts` — reads a signed-in customer's cart from Postgres (falls back to Redis on any miss/error). Cart reads only.
- `lib/postgres-shadow-write.ts` — mirrors confirmed orders into Postgres, as described in §4. Never inventory.

A full read cutover for inventory/checkout is real, reviewed surgery on the money path, not a flag flip — see the Known Gaps section below for what already exists to build on.

## 6. Verification commands

```
npx tsc --noEmit                                  # 0 errors
node --test tests/*.test.ts                       # all tests pass
npx tsx scripts/production-readiness-check.ts     # 0 error-level checks → "Production-ready"
npx tsx scripts/simulate-concurrency.ts --confirm  # chaos-tests the Postgres inventory/raffle locking directly (requires live Supabase + Redis creds; see its header)
```

## Known Gaps / Roadmap

These were scoped out of this pass deliberately (money-path risk / architecture-level decisions that deserve their own reviewed plan), not silently dropped:

- **Multi-domain edge router** (`site.com` / `app.site.com` / `sales.site.com` / `admin.site.com` / `{tenant}.mysite.com`). Today there is no subdomain routing at all — `middleware.ts` (~560 lines) only handles CSRF, admin auth, license enforcement, and maintenance mode; tenant resolution (`lib/tenant-context.ts`) is DB-driven for admin/B2B writes, not edge/hostname-driven. Custom-domain infrastructure to build on: `lib/cloudflare-saas.ts`'s hostname API (§3) and the `tenants` table's `domain_status` column (migration `00010`).
- **Full checkout/webhook Postgres cutover.** The locking logic already exists and is unit-tested — `lib/inventory.ts` (`decrementInventory`, Redis-lock + optimistic-concurrency CAS), `lib/orders.ts` (`createOrder`, multi-line reservation with rollback), `lib/raffle.ts` (entries/draws/shared pools) — but per each file's own header, none of it is wired into a live route yet. `scripts/simulate-concurrency.ts` (§6) proves the guarantees hold under load ahead of that wiring.
- **4-portal UI overhaul** (Sales Hub deal-desk, Admin Panel modernization, storefront micro-interactions). The existing `app/admin` panel is the only one of the four portals that exists today; a Sales Hub (`sales.site.com`) doesn't exist yet in any form.
