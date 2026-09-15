# Deployment Runbook

This is the step-by-step production rollout sequence for this store, covering the environment schema, the Supabase migration sequence, Cloudflare Worker + edge-router/portal DNS setup, Stripe webhook registration, and the safe order to bring each piece online. It documents what is actually built and wired today — including exactly what still needs your own staging validation — rather than the aspirational end state.

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
| Postgres cutover | `USE_POSTGRES_PRIMARY` — must be exactly `true`/`false` (case-insensitive); see §5 for exactly what this flag gates today |

`PLATFORM_ROOT_DOMAIN` (edge router / portal DNS, §3.1) is **not** in this schema — it's a plain hostname (e.g. `site.com`), not a secret, and every consumer (`lib/edge-router.ts`, `lib/portal-cookies.ts`, `middleware.ts`) already treats it as optional/unset-safe.

Run `npx tsc --noEmit && node --test tests/*.test.ts` after touching this file — `tests/env-schema.test.ts` exercises every field's accept/reject boundary.

## 2. Supabase migration sequence

Apply `supabase/migrations/00001` → `00013` in order (Supabase CLI: `supabase db push`, or paste each file into the SQL editor in order). One-line purpose of each:

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
| `00011` | Opaque variant/order metadata (raffle/FCFS/tier fields, jsonb) |
| `00012` | Native raffle/FCFS/waitlist/shared-pool schema: `raffle_entries`, `drop_draws`, `waitlist_entries`, `shared_inventory_pools`, `product_variants.checkout_mode` |
| `00013` | A real `orders.checkout_mode` column (`fcfs`/`raffle`/`waitlist`/`rfq_quote`), backfilled from `00011`'s jsonb — the one gap `00012` left in `orders` itself |

**RLS validation**: after applying migrations, run `npx tsx scripts/production-readiness-check.ts` (§6) — its `checkRlsCoverage` check (`lib/system-diagnostics.ts`) probes every sensitive table (`audit_logs`, `orders`, `customers`, `companies`, `quotes`, `raffle_entries`) with the **anon** key and fails loud if RLS doesn't block it. This is a real network probe, not a static "RLS is enabled" check.

## 3. Cloudflare Worker, KV, custom-hostname, and edge-router/portal DNS setup

This app deploys as a **single Cloudflare Worker** (`storefront-app`, `wrangler.jsonc`) built by `@opennextjs/cloudflare` — the whole Next.js app (routes, middleware, `/og`, `/icon`, `/media`) compiles to one `.open-next/worker.js`, with static assets served through the `ASSETS` binding. There is no separate per-subdomain Worker and no KV namespace in this config — the edge router (§3.1) works by Host-header classification inside the one Worker, not by routing to different Workers.

1. `npm run build:cloudflare` (runs `scripts/inject-mapbox-token.mjs` then `opennextjs-cloudflare build`) — `NEXT_PUBLIC_*` build-time vars must be in your shell *before* this step; they cannot be set in the Cloudflare dashboard afterward.
2. Set runtime secrets via the dashboard (**Workers & Pages → [project] → Settings → Variables and Secrets**) or `npx wrangler secret put NAME` — never commit a real secret into `wrangler.jsonc`. The full annotated list (required/recommended/optional, example values) is in that file's header comment.
3. `npx wrangler deploy` (or `npm run deploy:cf`, which chains the build first).
4. **Custom hostnames** (merchant custom domains) go through `lib/cloudflare-saas.ts`'s `/zones/:zone_id/custom_hostnames` wrapper — requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`. It fails clean (`{ ok: false, notConfigured: true }`) rather than throwing when unset, so local dev and the test suite never need real Cloudflare credentials. Status (`domain_status`/`ssl_status`) persists onto the owning tenant's row (migration `00010`) via pure mapping logic in `lib/cloudflare-status.ts` (independently unit-tested) and already renders as colored status badges in the admin panel's **Enterprise → Custom Domains** sub-tab (`components/admin/EnterprisePanel.tsx`'s `DomainsPanel`) — no new UI work was needed there.

### 3.1 Edge router / portal DNS setup (opt-in)

`lib/edge-router.ts` (pure, `node --test`-covered — see `tests/edge-router.test.ts`) classifies the request `Host` header into a portal: `marketing` (bare root domain), `admin` (`admin.` or `app.` — see below for why they're the same), `sales` (`sales.`), or `storefront` (anything else, including a merchant's own custom domain and local dev). **It is fully opt-in**: leave `PLATFORM_ROOT_DOMAIN` unset and every classification collapses to `storefront`, `middleware.ts`'s portal-isolation checks no-op, and session cookies stay host-only — byte-for-byte today's behavior. Nothing about this section is required to deploy.

To activate it:

1. Pick a root domain (e.g. `site.com`) and set `PLATFORM_ROOT_DOMAIN=site.com` in the Worker's environment.
2. Create DNS records (in Cloudflare, proxied) pointing each of these at the same Worker: the bare root `site.com`, `admin.site.com`, `app.site.com`, `sales.site.com`. (Tenant storefronts continue to be handled by the existing Cloudflare for SaaS custom-hostname flow above — they are not part of this list.)
3. Redeploy. `middleware.ts` will now 404 a request to `/admin*` or `/sales*` whose Host doesn't classify to the right portal (e.g. a tenant's custom storefront domain can never accidentally serve the admin panel), and the admin/sales session cookies (`app/api/admin/{login,super-login,impersonate,verify-confirm,setup}/route.ts`, via `lib/portal-cookies.ts`) become scoped to `admin.site.com` / `sales.site.com` instead of being host-only.

**What this does NOT do**: `admin.site.com` and `app.site.com` both serve the existing single `app/admin` tree — this template runs single-tenant (`lib/tenant-context.ts`'s fixed `DEFAULT_TENANT_ID`), so there is no separate merchant-control-center app to route `app.` to yet. The only genuinely new, separately-routed portal this phase adds is `app/sales` (the Sales Hub, §4.1). Building a real multi-merchant `app.site.com` is future work, tracked in Known Gaps below.

## 4. Stripe webhook registration, idempotency, and the Postgres cutover

1. Register a webhook endpoint at `https://<your-domain>/api/stripe/webhook` in the Stripe dashboard (or via CLI for a staging environment), subscribed to at least `checkout.session.completed` and whatever charge/payment events your raffle-charging flow needs. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Idempotency**: `lib/redis-maintenance.ts` dedupes processed Stripe session ids via `PROCESSED_SESSIONS_KEY`, a sorted set scored by timestamp (self-migrates from a legacy plain SET on first write after upgrade — no manual migration step). Verify it after a deploy via `checkWebhookIdempotency` in the readiness check (§6) — it reports the tracked-session count and retention window (72h, matching Stripe's own webhook retry window) without assuming the ZSET shape already exists.
3. **Postgres wiring, gated by `USE_POSTGRES_PRIMARY`** — off by default; every behavior below is a no-op until you set it:
   - **`app/api/checkout/direct/route.ts`** (the one checkout path that charges before any webhook fires): calls `decrementInventory()` (`lib/inventory.ts`) **before** charging Stripe — a real pre-charge Postgres gate. `insufficient_stock`/lock contention refuses the sale with a clean error; a variant with no matching `inventory_levels` row (not yet backfilled, §5) also fails closed with a 503 telling the operator to run the backfill. If the Stripe charge itself then fails or throws, the Postgres reservation is rolled back (`restockInventory`).
   - **`app/api/stripe/webhook/route.ts`** (`checkout.session.completed`, payment-mode): Stripe has *already* charged the customer by the time this fires, so a Postgres decrement here cannot gate the sale — it mirrors the authoritative count and, on `insufficient_stock`, writes a loud console error **and** an immutable `platform_audit` entry (`lib/platform-audit.ts`, action `postgres_inventory_oversold`) for manual reconciliation. It never fails the webhook response — the charge already happened, so a 5xx here would only cause a pointless Stripe retry (same "never blocks the real transaction" contract `lib/postgres-shadow-write.ts` already used).
   - **`app/api/stripe/webhook/route.ts`** (setup-mode, raffle entries): dual-writes into `raffle_entries` (`lib/raffle.ts`'s `createRaffleEntry`) alongside the existing Redis `rpush` — Redis stays the live system of record (the actual draw engine, `lib/auto-draw.ts`, still reads from it); this only keeps the relational table populated in real time. **The live draw engine itself was not cut over** — see Known Gaps.
   - **`lib/postgres-shadow-write.ts`**: every confirmed sale is still mirrored into `orders`/`order_line_items`, now also setting the real `orders.checkout_mode` column (§2's `00013`) alongside the existing `metadata` jsonb.
4. **Resolving a Redis product+size to its Postgres `variant_id`**: `lib/inventory.ts`'s new `resolveVariantId(tenantId, externalProductId, size)` looks it up via `products.external_id` → `product_variants.option_label`, the exact mapping `scripts/migrate-redis-to-supabase.ts` writes on backfill. **This is why the backfill must run before the flag is ever set in production** — a variant with no matching row fails closed rather than risk an unprotected oversell (see §5).

## 5. Zero-downtime rollout sequence

```
npx tsx scripts/production-readiness-check.ts   # confirm every check is OK/NOT_CONFIGURED, zero ERROR
npx tsx scripts/migrate-redis-to-supabase.ts --dry-run   # preview the backfill, no Supabase creds required
npx tsx scripts/migrate-redis-to-supabase.ts             # idempotent upsert backfill (safe to re-run)
# set USE_POSTGRES_PRIMARY=true in the deploy environment, then redeploy
npx tsx scripts/simulate-concurrency.ts --confirm         # chaos-test the locking against real Supabase+Redis before trusting the flag in production
```

**Read this before setting the flag**: `USE_POSTGRES_PRIMARY=true` now gates real behavior on the checkout/webhook path (§4), not just shadow-writes — but it still does **not** make Postgres the primary source for the storefront's *catalog reads*. `app/api/store/route.ts` (the live storefront's product/inventory feed) is a separate, more elaborate Redis-merge reader than anything rebuilt this phase — display-layer inventory counts can lag the authoritative Postgres count briefly under the new gating, which is a display-staleness issue, not an oversell risk (the sale itself is what's gated). See Known Gaps for the full storefront-read cutover this doesn't attempt.

**Ordering matters**: the backfill (`migrate-redis-to-supabase.ts`) must run — and every catalog edit made after cutover must keep Postgres in sync — *before* the flag is set, or `decrementInventory`'s fail-closed behavior will block sales for any un-migrated variant.

**Not integration-tested against live infrastructure**: everything in §4 was built and unit-tested with mocked fetch (this dev environment has no live Stripe/Supabase credentials) — validate in a staging environment with real Stripe test-mode keys and a real Supabase project before setting the flag in production.

## 6. Verification commands

```
npx tsc --noEmit                                  # 0 errors
node --test tests/*.test.ts                       # all tests pass
npx tsx scripts/production-readiness-check.ts     # 0 error-level checks → "Production-ready"
npx tsx scripts/simulate-concurrency.ts --confirm  # chaos-tests the Postgres inventory/raffle locking directly (requires live Supabase + Redis creds; see its header)
```

## Known Gaps / Roadmap

Scoped out of this pass deliberately — each is either a money-path decision (the live draw engine) or large, separate work (a from-scratch relational catalog reader, real multi-tenant support) that deserves its own reviewed plan:

- **Live draw-engine cutover.** `lib/raffle.ts`'s `executeDraw` (Postgres-native winner selection) exists and is independently tested, but the actual scheduled draw that selects real winners and triggers real charges is still `lib/auto-draw.ts`/`lib/draw.ts` (Redis). §4's dual-write keeps `raffle_entries` populated in real time so this cutover is ready to attempt, but swapping the engine that decides who gets charged real money needs its own dedicated, carefully-tested pass.
- **Storefront catalog-read cutover.** `app/api/store/route.ts` (live inventory + overrides + store config merge) has no Postgres equivalent — rebuilding it is large, separate work. Today's cutover only affects the *write*/decrement side (§4), not what the storefront displays.
- **Real DNS/Cloudflare zone provisioning for the edge router.** §3.1 documents the exact records; actually creating them in your Cloudflare account is your own domain's setup step, not something this repo can do for you.
- **A real multi-tenant workspace switcher.** `components/admin/PortalShell.tsx`'s workspace label is honestly static (`lib/tenant-context.ts` runs one fixed tenant) — a functional switcher needs real multi-merchant onboarding first.
- **Role-scoped `/sales` access.** `app/sales` and `/api/admin/b2b/quotes` currently require any valid admin session (`adminAuthorized`), the same as every other `/api/admin` route — not yet narrowed to the `sales`/`owner`/`super_admin` roles `lib/admin-actor.ts` already models. Middleware-level session validity is wired (`isSalesPath` in `middleware.ts`); the finer role check is a small follow-up in the route handler(s), consistent with how role gating already works elsewhere in this codebase (route-level via `actorHasFullAdminAccess`, not middleware-level).
- **Direct `node --test` coverage for the new checkout-path wiring.** `lib/inventory.ts`/`lib/orders.ts`/`lib/raffle.ts` import `@/`-aliased modules (`lib/server-config`, `services/config/supabase-client` via the `@/` form), which only resolve through Next.js's bundler — the same limitation noted in `lib/system-diagnostics.ts`'s header. The new wiring in `app/api/checkout/direct/route.ts` and `app/api/stripe/webhook/route.ts` was verified by typecheck + the full existing suite staying green, not by new isolated unit tests; a future "-pure" split (mirroring `lib/system-diagnostics-pure.ts`) would make direct coverage possible.
