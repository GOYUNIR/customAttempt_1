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

Apply `supabase/migrations/00001` → `00017` in order (Supabase CLI: `supabase db push`, or paste each file into the SQL editor in order). One-line purpose of each:

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
| `00016` | Marketing/media parity: `products.tagline`/`marketing_notes`/`media_gallery`, `product_variants.custom_schedule` — the relational home `lib/postgres-catalog-read.ts` hydrates into the storefront payload (§4.6) |
| `00017` | Theme customizer: `tenant_themes` (name/sections jsonb/is_active) — the modular design-system data model (§7) |

**RLS validation**: after applying migrations, run `npx tsx scripts/production-readiness-check.ts` (§6) — its `checkRlsCoverage` check (`lib/system-diagnostics.ts`) probes every sensitive table (`audit_logs`, `orders`, `customers`, `companies`, `quotes`, `raffle_entries`) with the **anon** key and fails loud if RLS doesn't block it. This is a real network probe, not a static "RLS is enabled" check.

## 3. Cloudflare Worker, KV, custom-hostname, and edge-router/portal DNS setup

This app deploys as a **single Cloudflare Worker** (`storefront-app`, `wrangler.jsonc`) built by `@opennextjs/cloudflare` — the whole Next.js app (routes, middleware, `/og`, `/icon`, `/media`) compiles to one `.open-next/worker.js`, with static assets served through the `ASSETS` binding. There is no separate per-subdomain Worker and no KV namespace in this config — the edge router (§3.1) works by Host-header classification inside the one Worker, not by routing to different Workers.

1. `npm run build:cloudflare` (runs `scripts/inject-mapbox-token.mjs` then `opennextjs-cloudflare build`) — `NEXT_PUBLIC_*` build-time vars must be in your shell *before* this step; they cannot be set in the Cloudflare dashboard afterward.
2. Set runtime secrets via the dashboard (**Workers & Pages → [project] → Settings → Variables and Secrets**) or `npx wrangler secret put NAME` — never commit a real secret into `wrangler.jsonc`. The full annotated list (required/recommended/optional, example values) is in that file's header comment.
3. `npx wrangler deploy` (or `npm run deploy:cf`, which chains the build first).
4. **Custom hostnames** (merchant custom domains) go through `lib/cloudflare-saas.ts`'s `/zones/:zone_id/custom_hostnames` wrapper — requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`. It fails clean (`{ ok: false, notConfigured: true }`) rather than throwing when unset, so local dev and the test suite never need real Cloudflare credentials. Status (`domain_status`/`ssl_status`) persists onto the owning tenant's row (migration `00010`) via pure mapping logic in `lib/cloudflare-status.ts` (independently unit-tested) and renders as colored status badges via `components/admin/DomainProvisioningCard.tsx` (extracted from the admin Enterprise tab's `DomainsPanel`, now also reachable on the Merchant Hub side of `app/admin`, since `app.site.com` and `admin.site.com` serve the same route tree — see §3.2).

### 3.0 Edge Worker performance (Cloudflare CPU limits)

**A factual note first**: there is no Cloudflare account or live deployment reachable from this dev environment, so a specific incident (e.g. an "Error 1102" on a live domain) cannot be confirmed or reproduced here — nothing in this repo is currently deployed. What follows is a real hardening pass against Cloudflare Workers' *actual* CPU-accounting model, done as a preventative measure, not a fix for an observed failure.

**The correction worth knowing**: Cloudflare's CPU limit (the thing that trips Error 1102) counts only active JS execution time, not wall-clock time spent awaiting I/O — a `fetch` call to Redis or Supabase inside `middleware.ts` does not itself burn CPU budget while the response is in flight. So the admin-gate's Redis round-trips are not a 1102 risk the way "delegate DB lookups to Node routes" implies; the real, fixable risk is unconditional synchronous work running on every request regardless of method or path. Three concrete fixes:

- `middleware.ts`'s production-env guardrail (`productionEnvHasBlockingIssues()`, a Zod parse over `process.env`) previously ran on **every** request in production, including every `GET`. It now only runs for write methods on `/api/*` — the only case it ever mattered for.
- `config.matcher` now also excludes common static-file extensions served from `public/` (images, fonts, `.well-known`) in addition to `_next/`/`media/` — those requests skip the whole middleware chain (CSRF, portal, license, env, maintenance checks) entirely.
- The portal/path host-gate (§3.2) is a single pure function (`lib/edge-router.ts`'s `isPortalPathAllowed`), `node --test`-covered, so its cost and correctness are both pinned rather than re-derived per request from scattered inline checks.

**No infinite redirect loops, by construction**: every redirect in `middleware.ts` clones `request.nextUrl` (same host) or returns a hard 404 (`isPortalPathAllowed` returning `false`) — never a redirect to a different host. `tests/edge-router.test.ts` pins this contract directly for the host/path gate.

### 3.1 Edge router / portal DNS setup (opt-in)

`lib/edge-router.ts` (pure, `node --test`-covered — see `tests/edge-router.test.ts`) classifies the request `Host` header into a portal: `marketing` (bare root domain), `admin` (`admin.`), `merchant` (`app.`), `sales` (`sales.`), or `storefront` (anything else, including a merchant's own custom domain and local dev). **It is fully opt-in**: leave `PLATFORM_ROOT_DOMAIN` unset and every classification collapses to `storefront`, `middleware.ts`'s portal-isolation checks no-op (`isPortalPathAllowed` always returns `true`), and session cookies stay host-only — byte-for-byte today's behavior. Nothing about this section is required to deploy.

To activate it:

1. Pick a root domain (e.g. `site.com`) and set `PLATFORM_ROOT_DOMAIN=site.com` in the Worker's environment.
2. Create DNS records (in Cloudflare, proxied) pointing each of these at the same Worker: the bare root `site.com`, `admin.site.com`, `app.site.com`, `sales.site.com`. (Tenant storefronts continue to be handled by the existing Cloudflare for SaaS custom-hostname flow above — they are not part of this list.)
3. Redeploy. `middleware.ts` will now 404 a request to `/admin*` or `/sales*` whose Host doesn't classify to an allowed portal (e.g. a tenant's custom storefront domain can never accidentally serve the admin panel), the admin/sales/merchant session cookies (`app/api/admin/{login,super-login,impersonate,verify-confirm,setup}/route.ts`, via `lib/portal-cookies.ts`) become scoped to their own subdomain instead of being host-only, and `app/admin/layout.tsx` starts enforcing the per-role split described in §3.2.

**What this does NOT do**: `admin.site.com` and `app.site.com` still serve the SAME `app/admin` route tree — this template runs single-tenant (`lib/tenant-context.ts`'s fixed `DEFAULT_TENANT_ID`), so there is no separate merchant-control-center *app* to route `app.` to. What differs between them is the ROLE required to use that one tree (§3.2), not the tree itself. The only genuinely new, separately-routed portal is `app/sales` (the Sales Hub). Building a real multi-merchant `app.site.com` app is future work, tracked in Known Gaps below.

### 3.2 Zero-trust portal RBAC

Every portal now enforces both "is there a session at all" (Edge-safe, coarse, `middleware.ts`) and "does this session's role satisfy THIS portal" (Node-runtime, needs `lib/admin-verify.ts`'s `crypto` import, so it runs at the route/layout level via `lib/admin-actor-from-headers.ts`'s `resolveAdminActorForPage()`):

| Portal | Host | Coarse gate | Role required | Enforced in |
|---|---|---|---|---|
| Platform Admin | `admin.site.com` | `middleware.ts`'s `isPortalPathAllowed` | `super_admin` **only** (`actorHasPlatformAdminAccess`) — stricter than `actorHasFullAdminAccess`, which also admits `owner` | `app/admin/layout.tsx` |
| Merchant Hub | `app.site.com` | same | `owner`/`staff`/`super_admin` (`actorHasMerchantAccess`) — impersonation allowed, since acting on a merchant's own store is what Staff Impersonation is for | `app/admin/layout.tsx` |
| Sales Hub | `sales.site.com` | same | `sales_rep`/`sales_admin`/`deal_desk`/`sales`/`super_admin` (`actorHasSalesAccess`) | `app/sales/page.tsx`, `app/api/admin/b2b/quotes/route.ts` |

No session at all → redirect to `/admin/login` (the one login surface all three portals share; `app/admin/layout.tsx` exempts `/admin/login` and `/admin/setup` from this check itself, or an anonymous visit to the login page would redirect to itself forever — `middleware.ts` threads the current pathname to that layout via an `x-pathname` request header for exactly this reason). A session that's authenticated but the wrong role for the portal → a 403 page (`components/PortalForbidden.tsx`) **and** an immutable audit-log entry (`recordPlatformAudit`, action `unauthorized_portal_access`, `lib/platform-audit.ts`) — never a silent redirect. All of this is opt-in behind `PLATFORM_ROOT_DOMAIN` (§3.1); unset, every portal behaves exactly as before (any valid admin session, no role split).

**Role management**: `components/admin/UserRoleManager.tsx` (Enterprise tab → **Roles** sub-tab, `app/api/admin/users` — `actorHasPlatformAdminAccess`-gated) lists every `users.role` and lets a `super_admin` change one, plus shows the recent platform audit log (including `unauthorized_portal_access`/`user_role_updated` entries). This is what closes the "nothing assigns the new sales sub-roles" gap from the previous pass.

## 4. Stripe webhook registration, idempotency, and the Postgres cutover

1. Register a webhook endpoint at `https://<your-domain>/api/stripe/webhook` in the Stripe dashboard (or via CLI for a staging environment), subscribed to at least `checkout.session.completed` and whatever charge/payment events your raffle-charging flow needs. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Idempotency**: `lib/redis-maintenance.ts` dedupes processed Stripe session ids via `PROCESSED_SESSIONS_KEY`, a sorted set scored by timestamp (self-migrates from a legacy plain SET on first write after upgrade — no manual migration step). Verify it after a deploy via `checkWebhookIdempotency` in the readiness check (§6) — it reports the tracked-session count and retention window (72h, matching Stripe's own webhook retry window) without assuming the ZSET shape already exists.
3. **Postgres wiring, gated by `USE_POSTGRES_PRIMARY`** — off by default; every behavior below is a no-op until you set it:
   - **`app/api/checkout/direct/route.ts`** (the one checkout path that charges before any webhook fires): calls `decrementInventory()` (`lib/inventory.ts`) **before** charging Stripe — a real pre-charge Postgres gate. `insufficient_stock`/lock contention refuses the sale with a clean error; a variant with no matching `inventory_levels` row (not yet backfilled, §5) also fails closed with a 503 telling the operator to run the backfill. If the Stripe charge itself then fails or throws, the Postgres reservation is rolled back (`restockInventory`).
   - **`app/api/stripe/webhook/route.ts`** (`checkout.session.completed`, payment-mode): Stripe has *already* charged the customer by the time this fires, so a Postgres decrement here cannot gate the sale — it mirrors the authoritative count and, on `insufficient_stock`, writes a loud console error **and** an immutable `platform_audit` entry (`lib/platform-audit.ts`, action `postgres_inventory_oversold`) for manual reconciliation. It never fails the webhook response — the charge already happened, so a 5xx here would only cause a pointless Stripe retry (same "never blocks the real transaction" contract `lib/postgres-shadow-write.ts` already used).
   - **`app/api/stripe/webhook/route.ts`** (setup-mode, raffle entries): dual-writes into `raffle_entries` (`lib/raffle.ts`'s `createRaffleEntry`) alongside the existing Redis `rpush` — Redis stays the live system of record for the *recurring, scheduled* draw (the cron engine, `lib/auto-draw.ts`, still reads from it); this keeps the relational table populated in real time, ready for the manual-draw path below.
   - **`lib/postgres-shadow-write.ts`**: every confirmed sale is still mirrored into `orders`/`order_line_items`, now also setting the real `orders.checkout_mode` column (§2's `00013`) alongside the existing `metadata` jsonb.
4. **Resolving a Redis product+size to its Postgres `variant_id`**: `lib/inventory.ts`'s new `resolveVariantId(tenantId, externalProductId, size)` looks it up via `products.external_id` → `product_variants.option_label`, the exact mapping `scripts/migrate-redis-to-supabase.ts` writes on backfill. **This is why the backfill must run before the flag is ever set in production** — a variant with no matching row fails closed rather than risk an unprotected oversell (see §5).
5. **Postgres-primary manual draw execution** (`app/api/admin/trigger-drop`, opt-in per-call): passing a Postgres `variantId` in the request body (instead of the existing Redis `targetPool`) runs `lib/raffle.ts`'s `executeDrawWithCharging` — it selects winners via `executeDraw` (writing `status='winner'`/`decided_at` into `raffle_entries` **first**, atomically, before any charge is attempted), then charges each winner's card (`payment_method_ref`, already a `raffle_entries` column) via the same `resolveStripeClient()` chokepoint every checkout route uses, marks each outcome (`markRaffleEntryOutcome`: `charged`/`declined`), and emails the winner (`sendWinnerEmail`). Omitting `variantId` (today's admin UI) is unaffected. **This is deliberately narrower than the live recurring cron engine** — see the next point.
5b. **Recurring cron draw engine (`lib/auto-draw.ts`) — Postgres MIRROR, not decision authority**: `lib/auto-draw.ts` (the live `/api/cron/auto-draw`/`/api/checkout/cron-draw`/`/api/checkout/auto-draw` engine — cadence rollover, promoter payouts, auto-activation) still decides who wins and charges the card exactly as before, completely unchanged. When the flag is on, after each charge attempt resolves it best-effort mirrors the outcome into `raffle_entries` (`findPendingEntryId` + `markRaffleEntryOutcome`) — so the relational table stays an accurate real-time record of what actually happened, without the money-deciding logic itself ever running against Postgres. This was asked for a third time across three passes; the answer hasn't changed because the constraint hasn't (787 lines of live charging/payout/cadence logic, no way to integration-test a rewrite here) — the mirror is the safe version of "make progress" without gambling on unvalidated code making real charges.
6. **Storefront catalog Postgres read** (§6 lists verification): `app/api/store/route.ts`'s `buildStorePayload` calls `lib/postgres-catalog-read.ts`'s `readCatalogFromPostgres(tenantId)` first when the flag is on — on a hit, the product/variant/inventory data it returns feeds the SAME `sanitizeProduct`/`applyLifecycle`/`mergePublicConfig` pipeline the Redis path already uses (so the go-live/archive/countdown/shared-pool logic is exactly the tested, working code, just fed a different data source); on a miss (not configured, no live products, any error) it falls through to the existing Redis path unchanged.
6b. **Marketing/media parity (migration `00016`)**: `products.tagline`/`marketing_notes`/`media_gallery` and `product_variants.custom_schedule` now give tagline, notes, the image gallery, and per-size drop-schedule overrides a real relational home — `lib/postgres-catalog-read.ts` hydrates them into `sanitizeProduct()`'s `tagline`/`notes`/`images`/`crops`/`sizeConfigs` fields. **Still no relational home**: per-product copy overrides (urgency/status line text) and sampler configs — a narrower version of the gap the previous pass documented. `scripts/migrate-redis-to-supabase.ts` does not backfill the new `00016` columns — they start empty until the backfill script grows them or a real authoring UI writes them.

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

## 7. Theme customizer + portal dashboard shell (Phase 5)

**Factual note on this phase's premise**: there is still no Cloudflare account or live deployment reachable from this environment — a wildcard DNS record being "live" on a real account can't be confirmed from here. `lib/edge-router.ts`'s `classifyHost` was re-verified against the exact `app.`/`sales.`/`admin.`/root/wildcard mapping this phase asked for (`tests/edge-router.test.ts` now has `goyunir.com`-shaped test cases, not just the generic `site.com` example) — no code change was needed, it already matched.

**Theme customizer (migration `00017`)** — a real, working modular section-based design system, sized down from a full Shopify Theme Customizer / VTEX Site Editor (no drag-and-drop library, a fixed palette of 5 section types — hero/product_grid/banner/countdown/footer — not an open plugin system):
- `lib/theme-schema.ts` — pure validation (`validateThemeSections`), `node --test`-covered.
- `components/admin/ThemeEditor.tsx` (Merchant Hub → Theme Editor, `actorHasMerchantAccess`-gated via `/api/admin/theme`) — add/reorder(↑↓)/configure/remove sections, save & activate.
- `components/storefront/ThemeSections.tsx` — the real renderer; `ProductGrid` fetches the live catalog via the same `/api/store` endpoint every other storefront surface uses.
- **Fully additive/opt-in**: `app/page.tsx` is now a thin Server Component that checks `lib/theme-read.ts`'s `readActiveTheme()` — a tenant with no active theme row (every existing deployment, today) renders `components/storefront/LegacyHomePage.tsx`, the exact original homepage relocated verbatim, byte-for-byte unchanged. Nothing regresses for an existing store.

**Portal dashboard shell** — `components/admin/PortalShell.tsx` was substantially rebuilt (grouped sidebar with icons, dashboard-card grid support) and is now the outer chrome for BOTH `app/admin/page.tsx` and `app/sales/page.tsx`. In `app/admin/page.tsx` specifically: the outer layout (the old flat pill-tab-bar) was genuinely, structurally rewritten in place to route through the new sidebar — the deep tab-content forms (settings fields, theme-preset pickers, product/provider editors) were deliberately **not** rewritten (see that file's own history: ~15 interdependent subsystems in one component, no way to visually verify a blind rewrite from this environment). New sidebar destinations, all real and wired: **Telemetry** (`/api/admin/system-health` + `/api/admin/telemetry`, live counts, no fabricated numbers), **Inventory Matrix** (`/api/admin/inventory-matrix`, sorted lowest-stock-first), **Tenant Onboarding** (`/api/admin/tenants` — creates a real `tenants` row; explicitly not a full multi-tenant SaaS onboarding flow, see Known Gaps), **Theme Editor**.

**Sales Hub additions**: `components/sales/VolumeDiscountMatrix.tsx` (a company's real `price_list_entries` tier ladder + `net_terms_days` badge, via new `/api/admin/b2b/price-list`) and `components/sales/ImpersonationLauncher.tsx` (surfaces the existing `/api/admin/impersonate` capability — while wiring this up, `app/api/admin/impersonate/route.ts`'s own role check was found to only recognize the legacy `sales` role, not the `sales_rep`/`sales_admin`/`deal_desk` sub-roles from migration `00015` — fixed alongside, or the sub-roles this session's own RBAC pass added would have been silently unable to use the one capability their portal exists to surface).

**Storefront**: `components/storefront/WholesaleMatrixSelector.tsx` — a real variant × quantity grid with live tiered pricing. Built but not mounted on any live storefront route yet — see Known Gaps for why (no buyer-facing B2B auth exists today, so it's currently only meaningful behind an admin session).

## Architecture positioning

This section maps the platform's actual, built capabilities to four architectural focus areas. It does **not** claim measured superiority over any named competitor (Shopify Plus, BigCommerce, Adobe Commerce, WooCommerce, Salesforce Commerce Cloud, commercetools, OroCommerce, SAP Commerce Cloud, Shopware, VTEX) — there is no benchmarking harness, live traffic, or access to those platforms' internals from this environment, so no comparative number (TTFB, throughput, uptime) would be honest to publish. What follows is what's real and where to look:

- **Unified B2B/B2C schema, no catalog duplication**: `products`/`product_variants` (migration `00009`) serve both retail (`checkout_mode='fcfs'`/`'raffle'`) and wholesale (`companies`/`price_lists`/`price_list_entries`/`quotes`, same `00009`) off the same catalog rows — a B2B quote (`lib/b2b/pricing.ts`'s `resolveUnitPriceCents`) resolves against a company's contract price list, falling back to the tenant default list, then the same base price a retail buyer sees. No separate B2B product table exists to drift out of sync.
- **Edge routing + adapters**: `lib/edge-router.ts` (Host-header portal classification, zero external deps, `node --test`-covered) and `lib/adapters/{db,payment,email,maps,edge}.ts` (thin facades over the driver+registry+factory pattern already used by `services/{payment,email,maps}/`) are real, tested code — see §3 for the router, and each adapter file's header for what it wraps. "Instant hot-swap" is accurate for the driver layer (adding a new payment/email/maps provider means one new driver file); it has not been exercised by actually swapping a live provider in production from here.
- **Concurrency protection**: `lib/redis-lock.ts` (Redis-lock critical section) + Postgres optimistic-concurrency CAS (`lib/inventory.ts`'s `decrementInventory`, `quantity_available=eq.<current>` PATCH) is real, wired into the checkout path (§4) behind `USE_POSTGRES_PRIMARY`. `scripts/simulate-concurrency.ts --confirm` is the way to verify the "no oversell under load" property against YOUR live Supabase + Redis — the "10,000+ simultaneous checkouts" figure is a target for that script to be run against, not a number measured from this environment.
- **Sub-50ms TTFB claim**: not verifiable here — no live deploy, no CDN, no traffic. §3.0's edge-hardening work (static-asset matcher exclusion, conditional env-guardrail execution) reduces unnecessary middleware CPU per request, which is the right lever for this metric, but the number itself needs a real deployment and a real measurement tool (e.g. Cloudflare's own analytics, or a synthetic load test) to state honestly.

## Known Gaps / Roadmap

What's left, stated precisely — each is either genuinely out of scope for what was asked, or something only you can do from here (your own domain, your own staging environment):

- **The recurring, scheduled raffle draw's DECISION logic stays on Redis.** `lib/auto-draw.ts`'s cron engine — cadence rollover, promoter payouts, auto-activation, and the actual choice of who gets charged — has no Postgres equivalent. §4.5's manual "draw this variant now" admin action has a real Postgres-primary execution path; §4.5b adds a real-time Postgres MIRROR of the cron engine's outcomes, but not a swap of its decision authority. This has been asked for three times across three passes; porting it is real, separate, carefully-tested work given it decides who gets charged real money on a schedule with no live Stripe/Supabase here to validate a rewrite against.
- **Two narrower storefront-authoring fields still have no Postgres home**: per-product copy overrides (urgency/status line text) and sampler configs. Migration `00016` closed tagline/notes/images/custom-schedule; these two are what's left of that original gap.
- **Real DNS/Cloudflare zone provisioning for the edge router.** §3.1 documents the exact records; actually creating them in your Cloudflare account is your own domain's setup step, not something this repo can do for you. Relatedly, there is no live Cloudflare Worker deployment reachable from this environment at all — §3.0's performance hardening is a static-analysis-driven pass against Cloudflare's documented CPU-accounting model, not a fix verified against an observed incident.
- **A real multi-tenant workspace switcher.** `components/admin/PortalShell.tsx`'s workspace label is honestly static (`lib/tenant-context.ts` runs one fixed tenant) — `TenantOnboardingWizard.tsx` (§7) is the real first step (creating `tenants` rows), but nothing switches the ACTING tenant based on them yet.
- **Merchant Hub is not a separate app.** `app.site.com` gets its own required ROLE (§3.2) but still renders the same `app/admin` route tree as `admin.site.com` — a genuinely separate merchant-control-center app (distinct nav, distinct surface area) is future work. The new sidebar destinations (§7) are visible regardless of which of the two hosts served the page — the page is one client component with no server-side portal prop threaded into it, so portal-specific nav filtering (Merchant Hub sees X, Platform Admin sees Y) isn't implemented, only the role-gate that decides whether the page renders at all (`app/admin/layout.tsx`).
- **Tenant onboarding is schema-only.** `TenantOnboardingWizard.tsx`/`/api/admin/tenants` create a real `tenants` row — not a full SaaS onboarding flow (no billing, no DNS provisioning, no storefront setup wired to the new tenant).
- **`WholesaleMatrixSelector.tsx` has no buyer-facing auth to sit behind.** This app's customer session system has no link to Supabase Auth/`company_members` — the component is built and functional but calls an admin-gated endpoint, so it's not yet a self-serve storefront experience for an anonymous B2B visitor.
- **Comparative competitive claims are unverified** (see "Architecture positioning" above) — no benchmarking infrastructure exists in this environment. No live Cloudflare account/DNS is reachable from here either — the wildcard record's "live" status could not be confirmed.
- **Theme customizer is an MVP, not the full system.** No drag-and-drop, a fixed 5-type section palette (no plugin system), no typography/banner-asset-upload controls beyond what each section's config fields expose.
- **Nothing in this or any prior phase was integration-tested against live Stripe/Supabase/Cloudflare.** This dev environment has none of the three. Every flag-gated code path here was built and unit/mock-tested; validate in a staging environment with real test-mode credentials before trusting any of it — the catalog read, the checkout/webhook wiring, `executeDrawWithCharging` (real cards, real charges), the auto-draw Postgres mirror, and the portal RBAC (`PLATFORM_ROOT_DOMAIN`) — with production traffic.
