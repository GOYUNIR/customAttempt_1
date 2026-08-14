<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# PRIVATE ALLOCATION STOREFRONT — COMPLETE AGENT INSTRUCTIONS

> **⚠️ MANDATORY MAINTENANCE RULE — READ THIS FIRST**
> This file is the single source of truth for AI agents working on this
> codebase. **Whenever you make ANY change** (new feature, new Redis key, new
> admin setting, bug fix, API change), **you MUST update this file in the same
> change set** so it stays relevant. Never leave this file stale. If you are
> unsure whether a change affects operations, update the relevant section
> anyway — a slightly verbose AGENTS.md is always better than a misleading one.
> When you finish a task, append your work to the **Change Log** at the bottom.

## Project Overview

This is a **drop-allocation / raffle storefront** built on Next.js 16 (App
Router) with **Redis as the primary data store** and **Stripe** for payments.
It is sold as a **white-label template**: the buyer renames the brand entirely
through the **admin portal at `/admin`** — no code changes are ever needed for
normal operation.

**Everything that displays to customers is editable in `/admin`:**

- Products, sizes, prices, inventory, winner tiers, Stripe price IDs, publish state
- Site colors, fonts, border radius, glow orbs, design presets
- Brand name, logo, favicon, social share card, footer links, copyright line
- Hero copy, entry-form copy, storefront copy overrides
- Drop schedule, social proof counters
- Rewards/points rates, gifting toggle, gift-discount %, redemption message
- Promo codes (customer + promoter), waitlist/announcement emails
- **Legal & Policies** — Terms, Privacy, and Shipping page content, company name, support email

The brand name "GOYUNIR" only exists as the **starter seed value** in
`goyunir.config.ts` / seed defaults. Nothing customer-facing is hardcoded —
emails, Stripe descriptions, the footer, the OG card, the favicon, the policy
pages and the site URL all read from admin config or environment variables.

## Architecture

### Data Storage — Redis is the source of truth

**Every Redis key is defined ONCE in `lib/redis-keys.ts`.** That file is the
mandatory single source of truth for key names, helpers, and the namespace map.
Routes import keys/helpers from `@/lib/server-config` (which re-exports the
registry). **NEVER hardcode a Redis key string anywhere else** — a schema
change must be a one-line edit plus the migration row in `/api/admin/organize-redis`.

The key space uses one tidy `domain:subdomain:…` convention so the Upstash /
Redis data browser stays filterable and organised at any scale:

| Namespace | Contents | Keys |
| --- | --- | --- |
| `store:` | Canonical, admin-edited data (the ONLY data a buyer configures) | `store:products` (hash), `store:config` (string), `store:users` (hash) |
| `archive:` | Permanent entry/charge history (append-only) | `archive:ledger` (list) |
| `promo:` | Promo code records + operational state | `promo:codes` (hash), `promo:used:<code>` (set), `promo:pending:<code>:<email>` (ttl string), `promo:credit:<orderRef>` (string) |
| `entries:` | LIVE entry/intent/waitlist pools, fraud blocks, dedupe | `entries:pool:<variant>:<size>`, `entries:intent:<variant>:<size>`, `entries:waitlist:<variant>:<size>` (lists), `entries:stats` (hash), `entries:block:email:<variant>:<size>` / `entries:block:card:…` (sets), `entries:processed` + `entries:email_sent` (sets), `entries:last_auto:<variant>:<size>` (string) |
| `draws:` | Draw summaries + history | `draws:last` (string), `draws:history` (list) |
| `ops:` | Operational state + admin live-apply overrides | `ops:live_state` (hash), `ops:catalog_archive` (hash), `ops:recovery_config` (string), `ops:recovery_sent` (hash), `ops:override:schedule` / `ops:override:social_proof` / `ops:override:product:<id>` (strings) |
| `auth:` | Auth tokens | `auth:session:<token>` (ttl string), `auth:reset:<token>` (ttl string) |
| `admin:` | Admin-only data | `admin:audit_log` (list) |
| `analytics:` | Social-proof counters + online visitors | `analytics:online` (zset), `analytics:social_boost`, `analytics:ticks:last` / `ticks:today` / `ticks:day` (strings) |
| `customer:` | Customer-submitted data | `customer:waitlist` (hash), `customer:addresses` (hash) |
| `cache:` | Ephemeral caches (safe to delete anytime) | `cache:stripe_portal_config` (string) |

Highlights of what changed in the tidy schema (and why it matters at scale):

- **Pools** live under `entries:pool:` / `entries:intent:` / `entries:waitlist:`
  (was `drop_pool:` / `intent_pool:` / `waitlist:`), fraud blocks under
  `entries:block:email:` / `entries:block:card:` (was `drop_fraud_block:*:emails|cards`).
- **Sessions** live under `auth:session:` (was `session:`); password resets under
  `auth:reset:` (was `reset:`). Sessions expire on their own TTL and are grouped
  under one prefix so the browser stays tidy with thousands of customers.
- **Live states / catalog archive** moved under `ops:` (`ops:live_state`,
  `ops:catalog_archive`); promos consolidated under `promo:` (`promo:codes`,
  `promo:used:`, `promo:pending:`, `promo:credit:`).
- **Overrides** (admin live-apply) moved under `ops:override:*`.
- **Analytics/social-proof counters** moved under `analytics:*`.

**Live states** are seeded lazily by `getLiveProductState()`, eagerly by
`/api/admin/seed` (Seed Defaults), and repaired by the admin **Site Self-Test**.
The storefront falls back to `totalInventory` when a live state is missing.

**Migrating older data**: `/admin → Developer → Tidy Redis Schema` losslessly
renames any legacy-prefix keys (drop_pool:*, intent_pool:*, session:*, live_state,
stats:*, config:promos, …) to the tidy schema via RENAMENX (atomic, TTL-preserving,
never overwrites). It is safe to re-run. The admin **Site Self-Test** includes a
"Redis schema tidy" check that flags any legacy prefixes that are still present.

**Legacy keys that no longer exist** (removed via `/admin → Developer → Tidy
Redis Schema`): `store:active_products`, `store:archived_products`,
`store:upcoming_products`, `store:product_images:*`, `store:catalog_config`.
Never rebuild them.

### Critical operational invariants

1. **Never assume Redis has data.** An unseeded store deliberately shows
   **0 items**. Products only appear after `/admin` → Seed Defaults or Add
   Product. There is **no fallback catalog served** from `goyunir.config.ts`.
2. **Products must exist in Redis to appear on the site.** A product slug only
   resolves when that product is in `store:products`; otherwise the product
   page shows "Product not found".
3. **Never hardcode brand, prices, or business logic.** All business
   configuration is portal-driven. If you find a hardcoded brand name, social
   URL, policy text, Stripe description, or `https://goyunir.com` in a
   customer-facing path, that is a BUG — replace it with the admin-config
   value or a neutral fallback.
4. **The admin portal is the product.** `/admin` is protected by
   `ADMIN_BASIC_AUTH_USERNAME`/`ADMIN_BASIC_AUTH_PASSWORD`.
5. **Every Redis key comes from `lib/redis-keys.ts`.** Never hardcode a Redis
   key string in a route/component. When you add or rename a key: (a) edit the
   registry, (b) add a migration row in `/api/admin/organize-redis/route.ts`,
   (c) update this file + README in the same change.
6. **Brand/URL/support values come from `lib/env.ts`** (`getSiteUrl()`,
   `getBrandName()`, `getSupportEmail()`, `neutralBrandName()`,
   `fallbackSiteUrl()`). Read env vars through these helpers, never
   `process.env.*` directly, so buyer aliases (`NEXT_PUBLIC_URL` etc.) keep
   working.

### Caching (read before touching storefront perf)

- `lib/ttl-cache.ts` — server-side in-memory TTL cache (`withTtlCache`).
  `/api/store` (10s), `/api/catalog/status` (15s), `/api/config/public` (30s),
  heartbeat social-proof tally (15s), `loadStoreConfigCached` (30s).
- `lib/client-store-cache.ts` — client-side `fetchStoreJson(url)` dedupes
  in-flight requests and reuses results for 10s.
- `app/layout.tsx` uses `export const dynamic = 'force-dynamic'` so the live
  `/admin` theme is baked into server HTML every request (no FOUC). It also
  renders a `<script type="application/json">` theme blob
  (`window.__GOYUNIR_THEME__`) + a synchronous inline script, and wraps the app
  in `ThemeProvider` (`components/ThemeProvider.tsx` + `useLiveTheme()`).
- Admin writes bypass caches; **storefront display data can lag a few seconds**
  (up to 30s for branding/metadata).

### Performance rules

- Glow orbs are **pre-blurred radial gradients** animated via direct DOM writes
  (refs) in `SiteChrome.tsx`. Never add `filter: blur()` or `backdrop-filter`
  to animated/large elements (forces per-frame paints → Chrome lag).
- Home/catalog countdowns only tick while a live countdown is visible.
- If you add a new public read endpoint, wrap Redis reads in `withTtlCache`.

## Admin Portal (`/admin`)

Full CRUD for products, images, settings, draws, entries, promos, users, and
the ledger. Settings tabs include:

- **Products** — add/edit/duplicate/publish/archive, price categories, Stripe
  IDs, inventory, winner tiers, images, sort order.
- **Settings → Theme Colors / Design Presets** — colors, fonts, radius,
  transparency, one-click presets (`lib/theme-presets.ts`).
- **Settings → Orb Glow** — enable/disable, per-orb color/opacity/size, motion.
- **Settings → Hero Content / Entry Form / Footer / Storefront copy** — copy overrides.
- **Settings → Branding & Share** — brand name, logo (upload or URL), header
  mode, logo size, share title/description/tagline/url, share card colors,
  favicon colors.
- **Settings → Rewards & Points** — earn rate, redeem rate, min/max points,
  gifting toggle, gift discount %, **custom redeem info message** (`{giftPercent}` token).
- **Settings → Legal & Policies** — Terms / Privacy / Shipping content
  (`## ` heading, `- ` bullet, blank-line paragraphs, `{companyName}` /
  `{supportEmail}` tokens).
- **Catalog** — upcoming/archive preview groupings.
- **Promos** — customer + promoter codes, discounts, caps, per-product/size eligibility.
- **Draws / Ledger** — trigger draws, draw history, permanent entry search.
- **Users** — adjust points, view accounts.
- **Developer** — Seed Defaults, Site Self-Test, Tidy Redis Schema,
  **Wipe & Rebuild Redis** (full key-space wipe with TWO-step confirmation:
  admin password + typing `WIPE`; optionally re-seeds defaults. Backed by
  `/api/admin/wipe`, which reuses `runSeedDefaults` from the seed route).
- **SetUp** — environment-variable status dashboard (✓/✗, never values; backed
  by `/api/admin/env-status`) + production launch checklist.
- **Streamer Mode** — default ON on load. Masks every customer email, shipping
  address and card number and disables the password field so the portal is safe
  to share on a livestream. Everything destructive still requires turning it
  OFF first, then entering the admin password.


## Core Feature Reference (for agents)

### Cart & raffle entries (anti-double-entry)

- **Server-side duplicate protection is the real gate.** `/api/checkout`
  (single product), `/api/checkout/cart` (bag), and
  `/api/checkout/confirm-setup` all block a second active raffle entry for the
  same email+product+size before a Stripe session is created (`DUPLICATE_BLOCKED`).
- **Client-side "entered" ledger** (`goyunir-entered-items` localStorage):
  when an entry is confirmed, the product+size is recorded so "Add to bag"
  blocks re-adding for the session. It is UX, not security.
- **Pruning the bag**: entering a raffle or buying a direct item through the
  product page (`handleRaffleSubmit` / `handleDirectCheckout` /
  `handleWaitlistSubmit` in `components/Storefront.tsx`) removes the matching
  product+size line from the bag immediately. A cart-drawer checkout sets
  `sessionStorage 'goyunir-cart-checkout'` so the confirm-setup success handler
  clears the WHOLE bag (and marks every secured raffle line in the ledger).
- **Ghost-cart pruning on load**: both `Storefront` and `SiteChrome` re-check
  the saved bag against the live `/api/store` snapshot on mount and drop any
  line whose product/size no longer exists (e.g. after a Redis wipe/rebuild or
  archive). The bag never shows items that don't exist on the backend.
- A direct entry tracks `sessionStorage 'goyunir-pending-entry'` so Stripe
  setup success can mark it entered and setup cancel can forget it.

### Mapbox address autofill (lib/mapbox-autofill.ts)

- Token resolution: `window.ENV_MAPBOX_TOKEN` → `#search-js[data-mapbox-token]`
  (injected at build by `scripts/inject-mapbox-token.mjs`) →
  `NEXT_PUBLIC_MAPBOX_TOKEN` → `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` →
  localhost-only dev overrides. **No token → no dropdown** (by design).
- ⚠️ **Do NOT "restore" `collection.observe()`** — Mapbox search-js v1.6.0's
  `observe()` deep-compares React DOM nodes (circular `__reactFiber$…`) and
  crashes with `RangeError: Maximum call stack size exceeded`. This module uses
  its own identity-based MutationObserver + `collection.update()` retry loop.
- ⚠️ **Pass `browserAutofillEnabled: true`** — otherwise the SDK renames the
  input's `autocomplete` to `new-password` and the dropdown never stays attached.
- **Full-address fill**: the SDK only writes street components into a single
  `street-address` box. `handleRetrieve` composes the FULL address and writes it
  via `writeReactInputValue()` (native setter + bubbling `input` event so React
  state stays in sync — a plain `el.value =` gets wiped by the next re-render),
  then re-applies on a guarded ~7s schedule to beat the SDK's async street-only
  fill. Do not remove that event dispatch.
- Address inputs must live **inside a `<form>`** with
  `autocomplete="shipping street-address"`.
- "Active" ≠ attached: `isMapboxAutofillActive()` is true only when the SDK
  actually attached (verified via `<mapbox-search-listbox>` listbox `.input`
  pointers) AND no token was rejected.
- `getAutofillAddressValue()` reads the DOM (truth), not React state, because
  programmatic fills don't fire React `onChange`.

### Shipping address validation (lib/address-validation.ts)

**STRICT.** This is a fulfilment-quality gate, not a UX nicety. Every entry,
cart checkout, waitlist, standalone address form and account address update
must be a COMPLETE address: street number + street name, city, state/region,
ZIP/postal code and country. `parseShippingAddress()` returns a specific
`missing_*` reason; `validateShippingAddress()` maps it to a helpful message.
US addresses require a state + 5-digit ZIP; common international formats
(UK/CA postals, 4-6 digit postals, ~40 countries) are recognised. Anything
unrecognised is rejected — `123 realstreet` can never be saved. When Mapbox
autofill is live and validation fails, the submit handlers append a hint to
pick a suggestion (the dropdown fills the full address).

### Promo codes

- Codes stored in `promo:codes` (hash). Customer discount %, promoter payout
  %, per-email/per-total use caps, per-product/size eligibility, min order,
  giftable (transferable) flag, `issuedForEmail` reservation.
- `?ref=` / `?promo=` links lock a promoter code for the session
  (`goyunir-promo-code` localStorage) and are preserved through checkout
  metadata. Promoters can't use their own code.
- The promo UI is **collapsed by default** everywhere (Storefront + cart
  drawer): a compact "Add promo or promoter credit" button (or "✓ CODE applied"
  chip with Change/Remove) that expands on tap. Never auto-expand it.
- `fixedDiscountCents` codes (store credit) vs `customerDiscountPercent` codes.
- **On load, a stored promo is re-validated against the live `promo:codes`
  table** (`/api/promo/validate?code=…&quiet=1` — the `quiet` param skips the
  click tracker). If the code no longer exists (e.g. after a Redis wipe/rebuild)
  it is removed from localStorage so the UI never claims a promo is applied
  that isn't. Only an explicit "Apply" tap tracks a click.

### Rewards & points

- Signup awards 250 points + a one-time 10% welcome promo bound to the email.
  Earn rate / redeem rate / min/max / gifting are admin-configurable.
- `/account` shows the balance, redeem box (creates a unique one-time promo in
  `promo:codes`), the credits list, and a **custom redemption message** set in
  `/admin` → Rewards (falls back to built-in copy that includes the gift %).

### Legal & policies pages (/terms, /privacy, /shipping)

- Fully generated from `store:config.legal` (`/admin` → Settings → Legal &
  Policies) by `components/LegalPage.tsx` (server component). The admin content
  uses a tiny markup: `## ` headings, `- ` bullets, blank-line paragraphs, and
  `{companyName}` / `{supportEmail}` tokens.
- The **footer** renders social links + copyright from `brandFooterData`
  (admin → Settings → Footer). Never hardcode social URLs or a brand name.

### Emails (lib/email.ts)

- Brand name from `BRAND_NAME` → `NEXT_PUBLIC_SITE_NAME` → neutral "Store".
  Support address from `SUPPORT_EMAIL` → `REPLY_TO_EMAIL` → neutral placeholder.
  Buyers set these in the platform (Vercel). **Do not hardcode a brand inbox.**
- Site URLs in emails/metadata come from **`lib/env.ts`** (`getSiteUrl()`), which
  resolves `NEXT_PUBLIC_URL` → `NEXT_PUBLIC_SITE_URL` → `SITE_URL` with a neutral
  fallback. `getBrandName()` / `getSupportEmail()` / `neutralBrandName()` /
  `fallbackSiteUrl()` are the other brand-safe helpers — **use them instead of
  reading `process.env.*` directly** in customer-facing code.

## Environment Variables (set in Vercel)

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis (source of truth) |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PRODUCT_ID` (optional) | Global default Stripe price ID when a product/size has none set in admin. Per-product IDs always win. No hardcoded Stripe ID anywhere — if unset, checkout fails loudly with `price_placeholder_not_configured`. |
| `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD` | `/admin` protection |
| `CRON_SECRET` | Cron endpoint auth |
| `RESEND_API_KEY` / `RESEND_FROM` (optional) | Transactional email |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox address autofill (must be set in the SAME env as the deploy + redeploy) |
| `NEXT_PUBLIC_URL` / `NEXT_PUBLIC_SITE_URL` / `SITE_URL` | Canonical/OG/email URLs (no hardcoded domain). All three aliases resolve via `lib/env.ts`. |
| `BRAND_NAME` / `NEXT_PUBLIC_SITE_NAME` (optional) | Email send-from brand |
| `SUPPORT_EMAIL` / `REPLY_TO_EMAIL` (optional) | Support address in emails |

The admin **SetUp tab** (`/admin → SetUp`) shows live ✓/✗ status for every
variable (never the values) plus a production launch checklist. `/api/admin/env-status`
is the backing endpoint.


## Testing Checklist (run before every change ships)

1. **Empty Redis** — storefront shows 0 items, catalog shows empty states,
   no crashes, no fallback products.
2. **Seeded Redis** — run Seed Defaults; products appear, product pages load,
   admin self-test passes.
3. **Draft flows** — a seeded store with zero traffic legitimately has zero
   live states; the storefront falls back to `totalInventory`.
4. **Duplicates** — the same email cannot enter the same raffle+size twice
   (server returns `DUPLICATE_BLOCKED`), and adding to the bag after entering
   is blocked client-side.
5. **Promo UI** — collapsed by default; expands only on tap; applies and
   persists; promoter codes locked by `?ref=` survive checkout.
6. **Address autofill** — with a token: suggestion fills the FULL address
   (street + city + state + zip) into the single box and survives re-renders.
7. **Legal pages** — /terms, /privacy, /shipping render admin content + live
   theme; leaving a field empty uses the built-in default.
8. **Branding** — change brand name/logo/footer/support email in admin and
   confirm the header, footer, OG card, favicon, emails metadata and Stripe
   descriptions reflect the change (no brand-name leakage).
9. **Build** — `npm run build` passes type-check and production compile.
10. **Lint** — `npm run lint` is 100% clean (0 errors, 0 warnings).
11. **Tests** — `npm test` passes (`node --test` on `tests/*.test.ts`:
    address validation, env helpers, order-ref).
12. **Stale-state after wipe** — after a Redis wipe/rebuild, a reloaded
    storefront shows an empty bag and NO "promo applied" chip (stored promo
    was re-validated and dropped).

## Files to NEVER Modify

- `components/Storefront.tsx` — modify carefully (cart/checkout/product-page flow).
- `app/[slug]/page.tsx` — product routing.
- `goyunir.config.ts` — only add a hardcoded DEFAULT if needed; prefer the admin portal.
- `lib/mapbox-autofill.ts` — read the Mapbox notes above before touching it.

## Change Log (append every change)

- **2026-08-14 — Template finalization pass:**
  - Catalog page: "Currently Available" section now renders BELOW the archives
    (order: Upcoming → Past Archives → Currently Available).
  - Home page orbs: hero/product surfaces let the glow bleed through when
    surface transparency is fully opaque (capped at 93%).
  - Mapbox full-address fill: writes via the native value setter + dispatches a
    bubbling `input` event so React state stays in sync (fixes the street-only
    box being wiped by re-renders) and re-applies over a ~7s guarded schedule.
  - Cart/raffle integration: product-page entry/buy prunes the matching bag
    line; cart-drawer checkout marks `goyunir-cart-checkout` and clears the
    whole bag + ledger on confirm; an entered-items ledger blocks re-adding to
    the bag after a confirmed entry; promo UI is collapsed by default in both
    the product form and the cart drawer.
  - Account page redesign: cleaner header, Rewards balance card, consistent
    cards, "My Entries" section header with refresh.
  - Admin config: added **Legal & Policies** (Terms/Privacy/Shipping content +
    company name + support email), **shareTagline/shareUrl**, and the
    **custom redeem info message** (`rewards.redemptionInfoMessage` with
    `{giftPercent}` token).
  - Removed hardcoded brand leakage: footer social links/copyright read from
    admin, policy pages are admin-driven, layout/OG/icon URLs use
    `NEXT_PUBLIC_SITE_URL`/`SITE_URL`, Stripe descriptions are brand-neutral,
    email fallbacks are neutral placeholders.
  - Docs: AGENTS.md and README.md rewritten for template buyers + AI agents.

- **2026-08-14 — Finalization follow-up (bug + lint fixes):**
  - Fixed `NotFoundView` server/client boundary: added `'use client'` so the
    `useLiveTheme()` hook works when `app/not-found.tsx` (a server component)
    renders it. Previously this threw `Attempted to call useLiveTheme() from
    the server` on every SSR of a 404/product-not-found page.
  - Zero new ESLint errors from the finalization pass: the new config fields
    are typed without `any` — `LiveThemeValue.footer`/`.legal` are
    `Record<string, string>`, `StorefrontConfig.legal` is `StoreLegalConfig`,
    SiteChrome's footer state is `Record<string, string> | null`, and the cart
    ledger loop in Storefront relies on inferred types instead of an explicit
    `any` annotation. The changed files now lint one error CLEANER than the
    previous commit (the story page also dropped a stale error).

- **2026-08-14 — Production-readiness pass (env aliases, address enforcement,
  wipe/rebuild, streamer mode, SetUp tab, lint + tests):**
  - **Env vars**: new `lib/env.ts` resolves `NEXT_PUBLIC_URL` →
    `NEXT_PUBLIC_SITE_URL` → `SITE_URL` for the canonical site URL (so buyers
    whose platform provides `NEXT_PUBLIC_URL` no longer see broken links),
    plus `getBrandName()` / `getSupportEmail()` / `neutralBrandName()` /
    `fallbackSiteUrl()`. Every `process.env.NEXT_PUBLIC_SITE_URL` read was
    replaced with these helpers.
  - **Brand leakage removed**: the top bar / home page / layout metadata no
    longer fall back to a hardcoded `'GOYUNIR'`; neutral defaults (env brand →
    "Store", "Your Brand", "support@example.com") are used. The
    `https://goyunir.com` email fallback is gone. Seed/footer defaults are
    neutral so a freshly seeded template never shows GOYUNIR. The seed route
    now exposes `runSeedDefaults(redis)` for reuse.
  - **Shipping address is now STRICTLY validated** (`lib/address-validation.ts`):
    every entry / cart / waitlist / address update must be a complete address
    (street # + name, city, state, ZIP/postal, country). Partial input like
    `123 realstreet` is rejected with a targeted message on both client
    (Storefront + cart drawer, with a Mapbox "pick a suggestion" hint when
    autofill is live) and server (all checkout/address routes share the same
    validator). Mapbox autofill still fills the full composed address.
  - **Stale state after a Redis wipe fixed**: stored promo codes are
    re-validated on load (`/api/promo/validate?quiet=1` — new `quiet` param
    skips the click tracker) and dropped when invalid; the saved bag is pruned
    against the live `/api/store` snapshot so ghost items (products/sizes that
    no longer exist) never appear.
  - **Admin → System → Wipe & Rebuild Redis** (`/api/admin/wipe`): full
    key-space wipe with TWO-step confirmation (admin password + typing `WIPE`),
    optional rebuild via the shared `runSeedDefaults`. Streamer mode must be
    off first.
  - **Admin Streamer Mode** (default ON): masks customer emails, addresses and
    card numbers and disables the password field so the portal is safe on a
    livestream; a toggle turns it off for real work.
  - **Admin → SetUp tab** (`/api/admin/env-status`): ✓/✗ status for every
    environment variable (values never returned), build-time vs secret badges,
    and a production launch checklist.
  - **Tests**: `npm test` runs `node --test` on `tests/*.test.ts`
    (address-validation, env helpers, order-ref). `tsconfig.json` gained
    `allowImportingTsExtensions` for the test runner.
  - **Lint is 100% clean** (0 errors, 0 warnings): fixed `prefer-const`,
    `Date.now()` during render (countdown clocks now read state, tick
    immediately in the effect), a TDZ bug (`lookup` before declaration),
    dead `window.location.href` assignments (`assign()`), ~30 unescaped
    entities, and ~45 unused imports/vars/dead admin functions. Two React
    Compiler rules are deliberately OFF with documented rationale
    (`no-explicit-any`, `set-state-in-effect`, and the `no-img-element` perf
    advisory) — see `eslint.config.mjs`.


- **2026-08-14 — Redis schema finalization (TIDY + MIGRATE):**
  - Created **`lib/redis-keys.ts`** — the single source of truth for every Redis
    key. All keys now follow one `domain:subdomain:…` convention
    (`store:`, `archive:`, `promo:`, `entries:`, `draws:`, `ops:`, `auth:`,
    `admin:`, `analytics:`, `customer:`, `cache:`). The Redis data browser is
    filterable by namespace at any scale.
  - Renamed legacy key families: `drop_pool:*`→`entries:pool:*`,
    `intent_pool:*`→`entries:intent:*`, `waitlist:*`→`entries:waitlist:*`,
    `drop_fraud_block:*`→`entries:block:*`, `drop_processed_sessions`→`entries:processed`,
    `email:entry_confirmed`→`entries:email_sent`, `draw:last_auto:*`→`entries:last_auto:*`,
    `live_state`→`ops:live_state`, `catalog:archive_state`→`ops:catalog_archive`,
    `config:recovery`→`ops:recovery_config`, `recovery:sent`→`ops:recovery_sent`,
    `config:drop_schedule`/`config:social_proof`/`config:product:*`→`ops:override:*`,
    `session:*`→`auth:session:*`, `reset:*`→`auth:reset:*`,
    `config:promos`→`promo:codes`, `promo:used_emails:*`→`promo:used:*`,
    `promo:delivery_credit_issued:*`→`promo:credit:*`,
    `stats:pools`→`entries:stats`, `stats:social_proof_*`→`analytics:*`,
    `analytics:active_users_online`→`analytics:online`,
    `admin:draw_history`→`draws:history`, `drop_last_draw_summary`→`draws:last`,
    `alerts:waitlist`→`customer:waitlist`, `address:submissions`→`customer:addresses`,
    `stripe:portal_config_id`→`cache:stripe_portal_config`.
  - **Removed every duplicated local key constant/helper** across ~25 API routes
    (local `PROMOS_KEY`, `usedEmailsKey`, `pendingPromoKey`, `issueKey`, etc.) —
    everything imports from `@/lib/server-config` → `lib/redis-keys.ts`.
  - **Upgraded `/api/admin/organize-redis`** into **"Tidy & Migrate Redis
    Schema"** (admin → Developer): losslessly renames legacy-prefix keys to the
    tidy schema via `RENAMENX` (atomic, TTL-preserving, never overwrites) with a
    type-aware copy+delete fallback, then removes the true legacy duplicate keys.
  - **Self-Test** now includes a "Redis schema tidy" check that scans for legacy
    prefixes and reports them, and the promos check now uses `HGETALL` on
    `promo:codes` (was a broken `GET` on the hash).
  - **Fixed a brand-name leak**: the Stripe billing-portal headline now reads the
    admin brand name (`branding.brandName` → `shareTitle`) with a neutral fallback
    instead of the hardcoded "GOYUNIR".
  - Admin "Draws" pool selector + trigger-drop use the new `entries:pool:*` keys;
    pool-key parsing (product name / size extraction) was updated for the 2-segment
    namespace and centralised in `sizeFromPoolKey()`.
  - Docs: AGENTS.md + README rewritten with the new key map, the migration path,
    and the mandatory rule that every future key change must update
    `lib/redis-keys.ts`, the migration table, and both docs in the same change set.


