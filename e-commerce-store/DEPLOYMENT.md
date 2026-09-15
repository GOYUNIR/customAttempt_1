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

Run `npm run typecheck && npm test` after touching this file — `tests/env-schema.test.ts` exercises every field's accept/reject boundary.

## 2. Supabase migration sequence

Apply `supabase/migrations/00001` → `00015` in order (Supabase CLI: `supabase db push`, or paste each file into the SQL editor in order). One-line purpose of each:

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
| `00014` | `tenant_store_config` — jsonb home for tenant config/schedule/social-proof, the relational source `lib/postgres-catalog-read.ts` reads (§3.2) |
| `00015` | Three real sales sub-roles (`sales_rep`/`sales_admin`/`deal_desk`) added to the `users.role`/`profiles.role` check constraint, alongside the existing 5 (legacy `sales` kept working) |

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

### 3.2 Sales Hub RBAC (`/sales`, `/api/admin/b2b/quotes`)

Access to the Sales Hub is gated in two layers: `middleware.ts`'s `isSalesPath` check confirms the request carries *some* valid admin session (readiness/Basic-Auth/device-cookie/2FA — Edge-safe, coarse); `app/sales/page.tsx` (a Server Component) and `app/api/admin/b2b/quotes/route.ts` then call `lib/admin-actor.ts`'s `actorHasSalesAccess()` — true for `sales_rep`/`sales_admin`/`deal_desk` (migration `00015`), the legacy `sales` role, and `super_admin`; **false for a plain `owner` or `staff` session**, which is the actual "generic admin access does not imply Sales Hub access" separation. The finer check can't run in `middleware.ts` itself — `resolveAdminActor` needs Node's `crypto`, unavailable on the Edge runtime — so it runs at the route/page level via `lib/admin-actor-from-headers.ts`'s `resolveAdminActorForPage()`, the same pattern `actorHasFullAdminAccess` already uses elsewhere in this codebase.

**The one real remaining gap here**: nothing in the admin UI assigns a user the new `sales_rep`/`sales_admin`/`deal_desk` roles yet — that's a `users.role` UPDATE an operator runs directly (Supabase SQL editor or a future admin screen) until one is built.

## 4. Stripe webhook registration, idempotency, and the Postgres cutover

1. Register a webhook endpoint at `https://<your-domain>/api/stripe/webhook` in the Stripe dashboard (or via CLI for a staging environment), subscribed to at least `checkout.session.completed` and whatever charge/payment events your raffle-charging flow needs. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Idempotency**: `lib/redis-maintenance.ts` dedupes processed Stripe session ids via `PROCESSED_SESSIONS_KEY`, a sorted set scored by timestamp (self-migrates from a legacy plain SET on first write after upgrade — no manual migration step). Verify it after a deploy via `checkWebhookIdempotency` in the readiness check (§6) — it reports the tracked-session count and retention window (72h, matching Stripe's own webhook retry window) without assuming the ZSET shape already exists.
3. **Postgres wiring, gated by `USE_POSTGRES_PRIMARY`** — off by default; every behavior below is a no-op until you set it:
   - **`app/api/checkout/direct/route.ts`** (the one checkout path that charges before any webhook fires): calls `decrementInventory()` (`lib/inventory.ts`) **before** charging Stripe — a real pre-charge Postgres gate. `insufficient_stock`/lock contention refuses the sale with a clean error; a variant with no matching `inventory_levels` row (not yet backfilled, §5) also fails closed with a 503 telling the operator to run the backfill. If the Stripe charge itself then fails or throws, the Postgres reservation is rolled back (`restockInventory`).
   - **`app/api/stripe/webhook/route.ts`** (`checkout.session.completed`, payment-mode): Stripe has *already* charged the customer by the time this fires, so a Postgres decrement here cannot gate the sale — it mirrors the authoritative count and, on `insufficient_stock`, writes a loud console error **and** an immutable `platform_audit` entry (`lib/platform-audit.ts`, action `postgres_inventory_oversold`) for manual reconciliation. It never fails the webhook response — the charge already happened, so a 5xx here would only cause a pointless Stripe retry (same "never blocks the real transaction" contract `lib/postgres-shadow-write.ts` already used).
   - **`app/api/stripe/webhook/route.ts`** (setup-mode, raffle entries): dual-writes into `raffle_entries` (`lib/raffle.ts`'s `createRaffleEntry`) alongside the existing Redis `rpush` — Redis stays the live system of record for the *recurring, scheduled* draw (the cron engine, `lib/auto-draw.ts`, still reads from it); this keeps the relational table populated in real time, ready for the manual-draw path below.
   - **`lib/postgres-shadow-write.ts`**: every confirmed sale is still mirrored into `orders`/`order_line_items`, now also setting the real `orders.checkout_mode` column (§2's `00013`) alongside the existing `metadata` jsonb.
4. **Resolving a Redis product+size to its Postgres `variant_id`**: `lib/inventory.ts`'s new `resolveVariantId(tenantId, externalProductId, size)` looks it up via `products.external_id` → `product_variants.option_label`, the exact mapping `scripts/migrate-redis-to-supabase.ts` writes on backfill. **This is why the backfill must run before the flag is ever set in production** — a variant with no matching row fails closed rather than risk an unprotected oversell (see §5).
5. **Postgres-primary manual draw execution** (`app/api/admin/trigger-drop`, opt-in per-call): passing a Postgres `variantId` in the request body (instead of the existing Redis `targetPool`) runs `lib/raffle.ts`'s `executeDrawWithCharging` — it selects winners via `executeDraw` (writing `status='winner'`/`decided_at` into `raffle_entries` **first**, atomically, before any charge is attempted), then charges each winner's card (`payment_method_ref`, already a `raffle_entries` column) via the same `resolveStripeClient()` chokepoint every checkout route uses, marks each outcome (`markRaffleEntryOutcome`: `charged`/`declined`), and emails the winner (`sendWinnerEmail`). Omitting `variantId` (today's admin UI) is unaffected. **This is deliberately narrower than the live recurring cron engine** — `lib/auto-draw.ts`'s cadence rollover, promoter payouts, and auto-activation stay Redis-only; see Known Gaps.
6. **Storefront catalog Postgres read** (§6 lists verification): `app/api/store/route.ts`'s `buildStorePayload` calls `lib/postgres-catalog-read.ts`'s `readCatalogFromPostgres(tenantId)` first when the flag is on — on a hit, the product/variant/inventory data it returns feeds the SAME `sanitizeProduct`/`applyLifecycle`/`mergePublicConfig` pipeline the Redis path already uses (so the go-live/archive/countdown/shared-pool logic is exactly the tested, working code, just fed a different data source); on a miss (not configured, no live products, any error) it falls through to the existing Redis path unchanged. **Read `lib/postgres-catalog-read.ts`'s file header before relying on this** — the Postgres schema doesn't model images/tagline/notes/custom schedules/sampler configs, so a Postgres-sourced product renders with real name/price/stock/checkout-mode but blank marketing fields until those get a relational home; this is a stated, deliberate tradeoff, not a bug.

## 5. Zero-downtime rollout sequence

```
npx tsx scripts/production-readiness-check.ts   # confirm every check is OK/NOT_CONFIGURED, zero ERROR
npx tsx scripts/migrate-redis-to-supabase.ts --dry-run   # preview the backfill, no Supabase creds required
npx tsx scripts/migrate-redis-to-supabase.ts             # idempotent upsert backfill (safe to re-run)
# set USE_POSTGRES_PRIMARY=true in the deploy environment, then redeploy
npx tsx scripts/simulate-concurrency.ts --confirm         # chaos-test the locking against real Supabase+Redis before trusting the flag in production
```

**Read this before setting the flag**: `USE_POSTGRES_PRIMARY=true` now gates real behavior across checkout, webhook, manual draw execution, AND the storefront catalog read (§4). It does **not** cut over the *recurring, scheduled* raffle draw — `lib/auto-draw.ts`'s cron engine (cadence rollover, promoter payouts, auto-activation) keeps running on Redis exactly as before; only the manual "draw this variant now" admin action gained a Postgres-primary option. It also doesn't retroactively backfill `tenant_store_config` (§2's `00014`) — until something populates it, the Postgres-sourced catalog payload's theme/schedule/social-proof sections are empty defaults, same as an unconfigured Redis store.

**Ordering matters**: the backfill (`migrate-redis-to-supabase.ts`) must run — and every catalog edit made after cutover must keep Postgres in sync — *before* the flag is set, or `decrementInventory`'s fail-closed behavior will block sales for any un-migrated variant.

**Not integration-tested against live infrastructure**: everything in §4 was built and unit-tested with mocked fetch (this dev environment has no live Stripe/Supabase credentials) — validate in a staging environment with real Stripe test-mode keys and a real Supabase project before setting the flag in production.

## 6. Verification commands

```
npx tsc --noEmit                                              # 0 errors
node --test tests/*.test.ts tests/integration/*.test.ts       # all tests pass (npm test runs this)
npx tsx scripts/production-readiness-check.ts                 # 0 error-level checks → "Production-ready"
npx tsx scripts/simulate-concurrency.ts --confirm              # chaos-tests the Postgres inventory/raffle locking directly (requires live Supabase + Redis creds; see its header)
```

`tests/integration/checkout-draw-flow.test.ts` chains catalog load → checkout decrement (optimistic-concurrency CAS) → raffle dual-write → draw selection → the Sales Hub notify-gate as one scenario. Its header explains a real constraint worth knowing before extending it: `lib/inventory.ts`/`lib/raffle.ts`/`lib/postgres-catalog-read.ts` all import `@/`-aliased modules that only resolve through Next.js's bundler, so `node --test` cannot load those files directly (confirmed by trying — a custom ESM resolve hook gets past the first hop, then hits `lib/server-config.ts`'s own large Stripe/Node-dependent import graph). The test instead runs the real, loadable pieces — `lib/adapters/db.ts` (mocked `fetch`, issuing the identical PostgREST request shapes those files build internally), `lib/raffle-draw.ts`'s real `selectWinners`, and `lib/admin-actor.ts`'s real `actorHasSalesAccess` — rather than faking a pass on code that didn't actually run. The checkout/webhook/draw route wiring itself is verified by typecheck + the full suite staying green, the same standard set in Phase 2.

## Known Gaps / Roadmap

What's left, stated precisely — each is either genuinely out of scope for what was asked, or something only you can do from here (your own domain, your own staging environment):

- **The recurring, scheduled raffle draw stays on Redis.** `lib/auto-draw.ts`'s cron engine — cadence rollover, promoter payouts, auto-activation — has no Postgres equivalent and was not touched. §4.5's Postgres-primary execution only covers the *manual* "draw this variant now" admin action (`app/api/admin/trigger-drop` with a `variantId`). Porting the cron engine's full feature set is real, separate, carefully-tested work given it decides who gets charged real money on a schedule.
- **Storefront marketing fields have no Postgres home.** §4.6 / `lib/postgres-catalog-read.ts`'s header: a Postgres-sourced product has real name/price/stock/checkout-mode but blank images/tagline/notes/custom-schedule/sampler-config until those fields get a relational model (or `tenant_store_config`/product `metadata` grows to carry them).
- **Real DNS/Cloudflare zone provisioning for the edge router.** §3.1 documents the exact records; actually creating them in your Cloudflare account is your own domain's setup step, not something this repo can do for you.
- **A real multi-tenant workspace switcher.** `components/admin/PortalShell.tsx`'s workspace label is honestly static (`lib/tenant-context.ts` runs one fixed tenant) — a functional switcher needs real multi-merchant onboarding first.
- **No admin UI assigns the new sales sub-roles.** §3.2: `sales_rep`/`sales_admin`/`deal_desk` (migration `00015`) exist in the schema and are enforced by `actorHasSalesAccess()`, but nothing in `/admin` lets an operator set a user's role to one of them yet — a direct `users.role` update is the only way today.
- **Nothing in this phase (or Phase 2) was integration-tested against live Stripe/Supabase.** This dev environment has neither. Every flag-gated code path here was built and unit/mock-tested; validate in a staging environment with real test-mode credentials before trusting any of it — the catalog read, the checkout/webhook wiring, and especially `executeDrawWithCharging` (real cards, real charges) — with production traffic.
