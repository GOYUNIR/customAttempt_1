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

> **⚠️ MANDATORY COMMIT WORKFLOW — DO THIS AT THE END OF EVERY TASK**
> When you complete ANY change (fix, feature, docs, config), you MUST commit
> and push the work before you call the task done. Always run exactly:
>
> ```
> git add .
> git commit -m 'whats new'
> git push origin main
> ```
>
> Use `'whats new'` as the commit message verbatim (it's the house convention;
> it keeps the template repo's history short and predictable). Before
> committing, verify the build/checks pass (`npm run lint`, `npm run typecheck`,
> `npm test`, and `npm run build` when a build is feasible). If the commit or
> push fails for a real reason (auth, upstream divergence), say so in your final
> summary and leave the working tree in a committed state if possible. Never
> end a task with uncommitted work in the tree.

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
| `store:` | Canonical, admin-edited data (the ONLY data a buyer configures) | `store:products` (hash), `store:config` (string), `store:users` (hash), `store:cart:<userId>` (string — signed-in cart mirror) |
| `archive:` | Permanent entry/charge history (append-only) | `archive:ledger` (list) |
| `promo:` | Promo code records + operational state | `promo:codes` (hash), `promo:used:<code>` (set), `promo:pending:<code>:<email>` (ttl string), `promo:credit:<orderRef>` (string) |
| `entries:` | LIVE entry/intent/waitlist pools, fraud blocks, dedupe | `entries:pool:<variant>:<size>`, `entries:intent:<variant>:<size>`, `entries:waitlist:<variant>:<size>` (lists), `entries:stats` (hash), `entries:block:email:<variant>:<size>` / `entries:block:card:…` (sets), `entries:processed` + `entries:email_sent` (sets), `entries:last_auto:<variant>:<size>` (string) |
| `draws:` | Draw summaries + history | `draws:last` (string), `draws:history` (list) |
| `ops:` | Operational state + admin live-apply overrides | `ops:live_state` (hash), `ops:catalog_archive` (hash), `ops:recovery_config` (string), `ops:recovery_sent` (hash), `ops:override:schedule` / `ops:override:social_proof` / `ops:override:product:<id>` (strings) |
| `auth:` | Auth tokens + verification challenges | `auth:session:<token>` (ttl string), `auth:reset:<token>` (ttl string), `auth:verify:<email>` (ttl string) |
| `admin:` | Admin-only data + two-step verification state | `admin:audit_log` (list), `admin:verify:<email>` (ttl string), `admin:devices` (hash of verified device tokens — one key, not one per browser), `admin:verify_attempts:<email>` / `admin:send_attempts:<email>` (ttl strings) |
| `analytics:` | Social-proof counters + online visitors | `analytics:online` (zset), `analytics:social_boost`, `analytics:ticks:last` / `ticks:today` / `ticks:day` (strings) |
| `customer:` | Customer-submitted data | `customer:waitlist` (hash), `customer:addresses` (hash) |
| `cache:` | Ephemeral caches (safe to delete anytime) | `cache:stripe_portal_config` (string), `cache:rate:auto_draw:<ip>` (ttl string) |

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
  in-flight requests, reuses fresh results for 10s, and is hardened for slow
  connections: stale-while-revalidate (the last good payload is served
  instantly for up to 5 min while a background refresh repairs it), a 10s
  abort timeout per network attempt, and a single retry with backoff on flaky
  connections. If a retried fetch still fails and a stale payload exists, the
  stale payload is served instead of an error.
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
  to animated/large elements (forces per-frame paints → Chrome lag). The orb
  loop **idle-throttles** to ~7fps of writes after 1.5s without interaction.
- Below-the-fold sections on the home page and `/catalog` use
  `content-visibility: auto` + `contain-intrinsic-size` so offscreen sections
  skip render/paint entirely. Keep this pattern for any new long section.
- Home/catalog countdowns only tick while a live countdown is visible.
- If you add a new public read endpoint, wrap Redis reads in `withTtlCache`.
- Liquid Glass chrome (header/drawer/toasts) uses the shared
  `glassSurfaceStyle()` helper; card surfaces use the static `cardSheen`
  gradient (never backdrop-filter on cards — it repaints on every scroll).

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
- **Two-step admin verification** — after Basic Auth, `/admin` requires a
  one-time code emailed to `ADMIN_VERIFY_EMAIL` (falls back to
  `SUPPORT_EMAIL`). proxy.ts validates a device cookie on EVERY `/api/admin`
  request (30 days when "remember this device" is checked, else 24h), so a
  leaked password alone can't reach the portal or its APIs. Codes are 6 digits,
  expire in 10 min, lock after 5 wrong tries, and resends are throttled to 1/min.
- **Streamer Mode** — default ON on load. Masks every customer email, shipping
  address and card number and disables the password field (fixed bullet mask —
  the real password length is never visible) so the portal is safe to share on
  a livestream. Everything destructive still requires turning it OFF first,
  then entering the admin password.
- **Admin security hygiene** — all `/admin` + `/api/admin` requests require
  HTTP Basic Auth in `proxy.ts` (no more password-in-query bypasses), admin
  routes compare the password with `verifyAdminPassword()` (timing-safe), and
  the admin password never travels in URLs (CSV export uses a fetch + blob).


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
`missing_*` reason; `validateShippingAddress()` maps it to ONE short, friendly
message that tells the customer to select the full address from the dropdown —
picking a suggestion always fills a complete, shippable address, and partial
input like `123 realstreet` can never be saved.

### Auto-draw / drops (fires when the timer hits zero)

- **One engine, three triggers.** `lib/auto-draw.ts` → `runAutoDraws()` is the ONLY
  draw implementation. It reads products from Redis (`store:products` — NEVER the
  static `goyunir.config.ts` catalog, which is why drops used to silently never
  fire for admin-created products), decides per-pool due-ness from the product's
  own timings, and charges winners with the same logic the old cron used.
- **Due-ness rules** (`shouldRunPoolDraw`): force → draw; product `isArchived` →
  final draw. A product with an explicit `releaseEndsAt` uses that as its CYCLE
  boundary — the pool is NEVER drawn before the countdown ends (a cron run or
  unrelated ping must not charge winners early), then draws once the timer hits
  zero. Recurring raffles (a schedule can produce a next draw: hourly/daily/
  weekly/biweekly/monthly/yearly) draw now and the runner ROLLS the product's
  `releaseEndsAt` forward to the next scheduled moment; one-shot drops (fixed
  date passed, no next anchor) draw at most once after the cycle ends. Products
  with NO explicit `releaseEndsAt` fall back to the global cadence
  (`shouldRunDraw`). Upcoming products whose `goLiveAt` passed are auto-activated
  (the Redis record is flipped to live) so the raffle timer starts counting to
  `releaseEndsAt`.
- **Recurring raffles / the "new raffle" timer.** When a draw completes with
  inventory remaining (and the product is not archived), the engine computes the
  next scheduled draw moment (`getNextRecurringAnchorMs` in
  `lib/storefront-config.ts`, merging static config → `store:config.dropSchedule`
  → `ops:override:schedule` → per-product `customDropSchedule`) and PERSISTS it as
  the product's new `releaseEndsAt` (naive store-time wall clock via
  `formatStoreWallClock` in `lib/drop-timestamps.ts`). The storefront then shows a
  countdown to the NEW timer instead of "Raffle closed"/"Until sold out". Both
  `/api/store` and `/api/catalog/status` also compute a read-time
  `nextReleaseEndsAt` field per product so the UI shows the new timer even before
  the engine's roll-forward is observed. Unselected entries carry over into the
  next raffle round. The per-product cadence is configured from `/admin → Products
  → Edit → Raffle schedule (recurring)`; the global cadence lives in `/admin →
  Draws → Automation` (mode: fixed/hourly/daily/weekly/biweekly/monthly/yearly).
- **Triggers:** (1) the client countdown pings `/api/checkout/auto-draw`
  (`lib/client-auto-draw.ts` → `notifyDropDue()`) from the product page, catalog
  and home page the second a countdown hits zero — a drop happens immediately with
  NO cron; (2) the Vercel cron (`vercel.json`: `*/5 * * * *` →
  `/api/checkout/cron-draw`, auth via `x-vercel-cron` / `Authorization: Bearer
  $CRON_SECRET`) is the server-side safety net; (3) the admin → Draws → Trigger
  Drop path (unchanged). The product page splits the countdown into a DISPLAY
  anchor (the effective `nextReleaseEndsAt`) and a TRIGGER anchor (the raw cycle
  end) so a recurring raffle shows its new timer while still nudging the draw.
- **Anti-double-draw:** the runner checks `entries:last_auto:<product>:<size>`
  and skips a pool drawn within the last 90s unless the caller forced it (cron).
  `dryRun=1` simulates the draw without charging/archiving (used by the admin
  self-test and support).
- **Admin-created product lifecycle** is now persisted: go-live flips are written
  to `store:products`, sold-out pools are archived to `ops:catalog_archive`, and
  recurring-raffle roll-forwards write the new `releaseEndsAt` back to
  `store:products`. Winner counts come from the product's per-size
  `priceCategories[].winnerTiers` CSV (admin "Winners / draw", e.g. `3,2,2` →
  3 winners on draw 1), falling back to `winnerTiers`, then the live state.

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

- **Email verification unlocks rewards.** New signups are created unverified
  with 0 points; a 6-digit code is emailed and must be confirmed
  (`/api/auth/verify-email`, `auth:verify:<email>`) before the 250 welcome
  points + one-time 10% welcome promo are issued and a session is created.
  `/account` shows a verify card for unverified users and `/api/account/claim-welcome`
  refuses to issue a code until verified. Earn rate / redeem rate / min/max /
  gifting are admin-configurable.
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
  reading `process.env.*` directly** in customer-facing code. In request-scoped
  metadata (`app/layout.tsx` `generateMetadata`, `app/og/route.ts`) the
  site URL also falls back to the CURRENT REQUEST's host via `lib/request-url.ts`
  (`getRequestSiteUrl()`), so link previews never resolve against a stock
  `https://example.com` placeholder when env vars and the admin Share URL are
  both unset.

## Environment Variables (set in Vercel)

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis (source of truth) |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PRODUCT_ID` (optional) | Global default Stripe price ID when a product/size has none set in admin. Per-product IDs always win. No hardcoded Stripe ID anywhere — if unset, checkout fails loudly with `price_placeholder_not_configured`. |
| `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD` | `/admin` protection (Basic Auth + two-step verification) |
| `ADMIN_VERIFY_EMAIL` (recommended) | Inbox that receives the `/admin` two-step code. Falls back to `SUPPORT_EMAIL` / `REPLY_TO_EMAIL`. Without one, the admin portal locks behind the code step. |
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

- **2026-08-15 — Text-contrast pass (all presets) + new default hero copy + console-noise fixes (cart/sync 401, rgba color inputs, image 404s) + share-card revision bump + home-page label finalization:**
  - **🔤 “MOST OF THE PRESETS NEED MORE CONTRAST IN TEXT” — fixed across ALL 11 presets** (`lib/theme-presets.ts`): muted text is now dark enough on light themes / bright enough on dark themes to be comfortably readable, and hairlines are stronger. Examples: Apple/Minimal `textMuted`/`cardTextMuted` `#52525a → #3f3f46` (≈9:1 on white), Luxury `#4b5563 → #3c4450` (page) + `#b9c0ca → #ccd4de` (dark card), Golden Noir `#a79e8b → #cfc6b3` + `#d0c7b5 → #e5decc`, Cyber Neon `#93a3bc → #b1bfd6` + `#bdcbe0 → #cfdbec`, Warm Paper `#5f564a → #473f31`, Hype `#9CA3AF → #b8bec9`, Deep Navy / Editorial / Wellness / Monochrome all brightened/darkened the same way. `cardBorder` alpha raised to `0.18` (light) / `0.20` (dark) so card edges read. The same improved defaults were applied to `goyunir.config.ts`, `lib/store-config.ts`, `lib/storefront-config.ts`, `app/api/store/config/route.ts` and the seed route's `DEFAULT_CONFIG`.
  - **📝 New default hero copy (no brand hardcoded).** The home-page top box defaults are now: `{brand} / CALIFORNIA USA` (eyebrow `CALIFORNIA USA`), headline **“by our hands. to your hands.”**, body **“homemade & designed, with real ingredients, with real hands. for real people.”**, CTA **“Browse drops”**, story button **“Our Story”**, story line **“take control.”** — the brand name still comes from `BRAND_NAME`/admin branding with a neutral fallback, so no brand is hardcoded anywhere. Updated in `goyunir.config.ts`, `lib/storefront-config.ts` (`defaultHeroContent`), `lib/store-config.ts`, `app/api/store/config/route.ts`, `app/api/admin/seed/route.ts`, plus the `app/page.tsx` fallbacks. (The live Redis already held this copy.)
  - **🔇 `POST /api/cart/sync 401` spam gone (main page AND /admin).** `SiteChrome` renders on every page (including /admin) and its cart-storage effect called `scheduleCartPersist()` for anonymous visitors, so every mount + `goyunir-cart-updated` event hit `/api/cart/sync` and logged a 401 (20+ times on /admin). `lib/client-cart-sync.ts` now keeps a `signedIn` flag (`setCartSyncSignedIn()`) set by SiteChrome from `/api/auth/me`; `scheduleCartPersist()` and `syncCartWithServer()` **skip the network entirely when signed out**. The bag still syncs exactly as before for logged-in accounts.
  - **🎨 `The specified value 'rgba(0,0,0,0.14)' does not conform to the required format` (882×) gone.** The admin theme editor fed `cardBorder: rgba(…)` straight into `<input type="color">`, which the browser rejects once per render. New `toHexColor()` helper in `lib/share-card-config.ts` converts any CSS color (`rgba()`, `rgb()`, 8-digit hex, 3/4-digit hex) to a color-input-safe `#rrggbb`. Wired into the theme-color inputs, the orb color inputs and the branding share-color inputs in `app/admin/page.tsx`. Unit-tested in `tests/share-card-config.test.ts`.
  - **🖼 Product image 404s gone.** The seed products + static catalog preview reference `/images/{baseItem1,baseItem2,elysian-white,obsidian-void,tee-vol1,cargo,crimson-static}/1.jpeg`, but `public/images/` was empty — every seeded card logged `GET … 404`. Shipped real placeholder JPEGs (1200×900, brand-neutral gradients generated with `sharp`) at every referenced path, so a freshly seeded store never 404s its own images.
  - **🏷 Home page finalized for customers.** Sold-out cards no longer say “Social proof”, the first card no longer says “Primary release”, and sold-out CTA no longer says “Sold out — proof of demand” — every product card now reads **“Featured release”** and the sold-out section header reads **“Featured releases”** (`app/page.tsx`). No more internal-jargon labels on the customer-facing page.
  - **🃏 Share-card revision bumped `CARD_REVISION 3 → 4`** (`app/layout.tsx`) so WhatsApp/iMessage/Discord (which cache previews by URL) are forced to re-fetch the card after this deploy. `/og` re-verified locally: 200 `image/png` (85KB) with the live branding. The admin Branding & Share preview itself was working (it renders the real `ShareCard` from form state — the “GOYUNIR GOYUNIR” text is just `shareTitle` empty → falls back to the brand name; set a `shareTitle` in admin to show different title copy).
  - **🧹 Hardcoded-brand leak in admin UI removed:** the Hero Content hint literally said “the ‘GOYUNIR / HIGH-CADENCE RELEASES’ block” — now neutral (“the brand / location block”).
  - **Live-Redis note:** the buyer's live `store:config` was actively being edited during this pass (theme flipped Golden Noir → Luxury → Apple between reads), so I did NOT keep overwriting it — the code presets/defaults are the source of truth and apply on the next preset apply / settings save. No Redis keys were added or changed.
  - Docs: this changelog entry. Verified: `npm run lint` 0/0, `npm run typecheck` clean, `npm test` 26/26 (new `toHexColor` test), `npm run build` compiles every route + middleware, and the production server was smoke-tested (`/` 200 with the new hero copy, `/og` 200 `image/png`, `/images/baseItem1/1.jpeg` 200 `image/jpeg`).

- **2026-08-15 — FINALIZATION + LIVE-DEPLOYMENT FIX + contrast pass (the "why isn't the site updated" mystery solved):**
  - **🔍 The root cause of "nothing is being updated to Vercel".** `git add .`/`git commit`/`git push origin main` were working perfectly the whole time — the repo was up to date with `origin/main` (GOYUNIR/customAttempt_1). The real problems were on the Vercel side: (1) the **GitHub→Vercel auto-deploy was not wired up** — every production deployment in `vercel ls` was CLI-triggered by user `goyunir-1009`, so pushes to GitHub never deployed; (2) **`vercel.json`'s `*/5 * * * *` cron BLOCKED every deployment** — Vercel Hobby accounts only allow cron jobs that run at most once per day, so `vercel deploy --prod` (and any git-triggered build) failed validation and Vercel kept serving the OLD build; the cron is now `0 0 * * *` (once daily, still a draw safety net — the client countdown trigger + admin Trigger Drop remain the real-time path); (3) the last production deployment predated the two final commits (Apple design pass + catalog ordering), so the live site was running stale code; (4) the "deployment URL" shown on the GitHub repo page (`custom-attempt-1.vercel.app`) was **never aliased** — the real production URL is **`goyunir.com`** (the alias row `custom-attempt-1-1x9u6lvwb-goyunir.vercel.app → goyunir.com`). Fix: re-deployed the current HEAD to production via `vercel --prod` (upload + remote build), so the live site is now the latest code, and re-connected the git integration where possible.
  - **🎨 Live Redis was overriding the design with a broken saved theme.** `store:config.themeColors` held old Luxury-preset values with `borderRadius: 1`, `chromeTransparency: 96`, `surfaceTransparency: 100` — that's why the "Apple design" never showed even on a fresh deploy (the layout merges Redis theme over the build-time defaults). Reset `store:config.themeColors` to the **Apple preset** (`#f2f2f7`, squircle radius 26, SF stack, glass chrome) and set `store:config.catalog.sectionOrder = ['upcoming','archive','live']` (Currently Available at the BOTTOM). Branding (GOYUNIR), products, and every other config field were preserved.
  - **🔠 Contrast pass — "colors on presets are way too similar / can't read anything".** Found and fixed the whole class of token-on-wrong-surface bugs (the search bar was the exact case the user reported):
    - **`textMain`/`textMuted` on CARD surfaces** (unreadable on presets with dark cards + dark page text like Luxury/Monochrome/Editorial/Golden Noir/Deep Navy/Cyber Neon): catalog search input text + Clear button (now `cardTextMain`/`cardTextMuted` with a new theme-aware `.goyunir-ph::placeholder` CSS utility), catalog tile status/description/Raffle-FCFS tags, catalog live-drop subtitle (gold `#d6c29c` → theme `cardTextMuted`, sold-out gold darkened), Storefront checkout-mode label + "Why this drop matters" + "Cart" section headers, account "Order ref" + winner note.
    - **`cardTextMain`/`cardTextMuted` on PAGE background** (invisible on light-page presets): account "Your entries load automatically from <email>" (now `textMain`) and the account message line (now `textMuted`).
    - **Auth pages**: signup `<h2>` inherited the dark page `textMain` over the dark card → now `cardTextMain`; reset-password `<h1>`/`<p>` same fix.
    - **Preset tokens strengthened**: all 10 presets' `textMuted`/`cardTextMuted` darkened on light themes / lightened on dark themes (e.g. Apple `#6e6e73 → #52525a`, Luxury `#9CA3AF → #b9c0ca`) and `cardBorder` raised from `rgba(0,0,0,0.08)` → `0.14` / `rgba(255,255,255,0.10)` → `0.16` (monochrome `0.18`) so hairlines and muted copy are actually visible.
  - **Hydration 418 on /admin + upload 404 were already fixed in code** (deterministic "Checking admin verification…" SSR gate + `app/api/admin/upload/route.ts`) — the live site was just serving the stale build. No code change needed; the redeploy carries them.
  - Docs: this changelog entry. No Redis keys were added/changed. Verified: `npm run lint` 0/0, `npm run typecheck` clean, `npm test` 25/25, `npm run build` compiles every route + middleware, and the live deployment was verified after release.


- **2026-08-15 — DROP-ON-TIMER-ZERO fixed for real (recurring raffles + the new timer) + per-product raffle schedule settings:**
  - **💥 The drop now ACTUALLY fires on timer-zero and then starts a NEW raffle.** Verified end-to-end against live Redis: a product whose `releaseEndsAt` passed drew its pool, and because inventory remained the engine rolled the product's `releaseEndsAt` FORWARD to the next scheduled draw moment (today 21:00 store time for the seeded daily schedule). The pool is not due again until that new timer hits zero — the storefront shows the NEW countdown instead of "Raffle closed"/"Until sold out".
  - **The engine never drew before the timer ended — now fixed.** `shouldRunPoolDraw` treated a product with a future `releaseEndsAt` as due whenever `lastAuto` was 0 (the cadence fallback fired even though the product's own countdown hadn't ended), so a cron run could have charged winners EARLY. It now treats the product's `releaseEndsAt` as its CYCLE boundary: never due before it, due once it passes, and after the draw it rolls the boundary forward (recurring) or marks the pool done (one-shot).
  - **Recurring-raffle roll-forward** (`lib/auto-draw.ts`): after a draw with inventory remaining, the engine computes the next scheduled draw moment (`getNextRecurringAnchorMs`) and persists it as the product's new `releaseEndsAt` (store-time wall clock via new `formatStoreWallClock` in `lib/drop-timestamps.ts`). Per-product `customDropSchedule` overrides the global cadence; the global cadence now merges static config → `store:config.dropSchedule` → `ops:override:schedule` so the engine agrees with the storefront's config (drawHour 21 vs the old static drawHour 0 mismatch is gone).
  - **`nextReleaseEndsAt` on the storefront payloads.** `/api/store` and `/api/catalog/status` compute a read-time `nextReleaseEndsAt` per product (`resolveNextRaffleAnchorMs` in `lib/storefront-config.ts`), so the product page, home cards and catalog tiles show the new timer immediately — even before the engine's roll-forward is observed. The product page splits the countdown into a DISPLAY anchor (new timer) and a TRIGGER anchor (raw cycle end) so the draw still fires on load for an ended-but-un-drawn pool.
  - **Home page "Until sold out" is gone** for recurring raffles — `formatCountdown` and the countdown clock now use the effective anchor (`nextReleaseEndsAt || releaseEndsAt`).
  - **Winner counts honor the product's tiers.** The auto-draw now charges `priceCategories[].winnerTiers` (admin "Winners / draw", e.g. `3,2,2` → 3 winners on draw 1) instead of the seeded live state's stale `winnersPerDraw: 1`. The seed route now seeds live states with the first-tier count too.
  - **Admin → Products → Edit → "Raffle schedule (recurring)"** — a per-product toggle + cadence selector (hourly/daily/weekly/biweekly/monthly/yearly), timezone, and the mode-specific draw time/day fields, persisted as `customDropSchedule` by `/api/admin/products`. The global cadence selector already lives in `/admin → Draws → Automation`.
  - Docs: AGENTS.md updated (auto-draw section + this changelog). No new Redis keys. Verified: `tsc --noEmit` clean, full `eslint` clean (0/0), `npm test` 25/25 pass, `npm run build` compiles every route + middleware, and the live-draw dry-run + real roll-forward were tested against the live store.

- **2026-08-15 — Apple Liquid Glass design system + ALL presets rebuilt on Apple design language + new "Apple" preset + snappier-perf pass + production finalization:**
  - **🍎 New flagship `Apple` preset** (`lib/theme-presets.ts`, `id: 'apple'`) — the full iOS 26 Liquid Glass look: `#f2f2f7` system background, SF Pro stack, squircle radius 26, heavy `blur(36px) saturate(196%) brightness(110%)` chrome, 96% card translucency, soft layered shadows, spacious rhythm, and iOS-vibrant glow orbs (blue/purple/pink/cyan/orange). It is the FIRST card in `/admin → Settings → Design Presets`.
  - **🪟 EVERY preset rebuilt on Apple design language.** All 10 existing presets (Minimal, Luxury, Hype Culture, Wellness, Editorial, Monochrome, Deep Navy, Golden Noir, Cyber Neon, Warm Paper) were updated so every one now uses **continuous squircles** (`radiusStyle: 'squircle'`, radius 18–24 — no more `sharp`/`rounded`), **heavy Liquid Glass chrome** (`backdropBlur` 76–86, `chromeTransparency` 56–68), **soft layered card shadows** (`cardShadow` 14–18), and comfortable/spacious page rhythm — while keeping each persona's market identity (colors, type, mood). Taglines updated to match (no more "crisp edges").
  - **💧 Liquid Glass material system.** New shared helpers in `lib/storefront-config.ts`: `glassSurfaceStyle(themeColors, opts)` returns the full chrome recipe (chrome-tinted translucent bg + **specular top sheen** gradient + hairline border + inner rim highlight + soft outer float) and `glassBackdrop()` now adds a `brightness()` term so glass glows "vibrant" like iOS. Applied to the **header** (specular sheen + rim light), the **cart drawer** (dark-panel variant), the **promo banner** and **toasts** (glass pills). New `.liquid-glass` CSS utility in `app/globals.css` (sheen layered as background-image — no pseudo-element/z-index juggling). Card surfaces across home/catalog/product now wear a **static specular `cardSheen`** (painted-once gradient, NO backdrop-filter — perf-safe) so the whole storefront reads as one glass material.
  - **⚡ Snappier / less laggy.**
    - **Orb idle-throttle** (`components/SiteChrome.tsx`): while the visitor isn't interacting (1.5s+ idle) the glow only WRITES every 8th frame (~7fps ambient drift instead of 30fps) — physics stays cheap, and the instant the cursor/scroll/touch moves the orbs spring back to full-rate writes with zero visible jump. Reduced-motion users stay on the slow cadence permanently.
    - **`content-visibility: auto`** on below-the-fold sections (home priority drops / social proof / member perk + all `/catalog` sections) with `contain-intrinsic-size` reserving layout height — offscreen sections skip render/paint entirely and scroll can never jump.
    - Default theme tokens aligned across `lib/store-config.ts`, `lib/storefront-config.ts`, the seed route, `/api/store/config`, the layout inline theme script and `:root` (`#f2f2f7`, radius 24, chrome 62, surface 98, shadow 14, blur 80) so an unseeded store and a freshly seeded store both ship the Apple look.
  - **🗂 Catalog ordering confirmed & documented** — `store:config.catalog.sectionOrder` defaults to `['upcoming','archive','live']` with **Currently Available at the BOTTOM** in every path (store-config default, admin UI default, `/api/catalog/status` fallback, catalog-page sanitizer); operators can reorder from `/admin → Settings → Catalog` but the template default is live-last.
  - Docs: this changelog + README updated in the same change set. No Redis keys were added or changed. Verified: `tsc --noEmit` clean, full `eslint` clean (0/0), `npm test` 23/23 pass, `npm run build` compiles every route + middleware.


- **2026-08-15 — DROP-ON-TIMER-ZERO FIX (round 2 — the real one) + signed-in cart sync + console-noise cleanup + share-card cache-buster:**
  - **💥 Countdowns now ACTUALLY drop the raffle.** The previous fix made the server-side engine work (verified: a dry-run of the real Redis pools draws and charges the winners correctly), but the client countdown still didn't fire the trigger in the common case. Root cause: drop times are stored as NAIVE wall-clock strings (`2026-08-15T06:16` — no `Z`/offset), and every consumer parsed them in its OWN timezone — the product-page countdown in the browser's zone, the draw engine in the server's UTC zone, the catalog/home lifecycle in the browser again. On any machine whose timezone differed from the store's (America/Los_Angeles), a release that had already ended re-anchored to the NEXT GLOBAL drop (`dropSchedule.targetEndDateTime`, often a week away) and showed a bogus "Raffle ends in 6d…" countdown while the pool sat due and un-drawn; the trigger never fired and (without a configured cron) nothing dropped. Fixes:
    - **New `lib/drop-timestamps.ts`** (`dropTimestampToMs` / `dropTimestampToMsOrNaN`): naive timestamps are interpreted in the STORE timezone (`store:config.dropSchedule.timezone`), explicitly-zoned strings pass through natively. Self-contained (no `@/` imports) so the browser, the server and the node --test runner all agree.
    - **Wired into every consumer:** `components/Storefront.tsx` countdown anchor + trigger, `app/page.tsx` home trigger + countdown labels, `app/catalog/page.tsx` catalog trigger + countdowns, `lib/auto-draw.ts` due-check + go-live flip, `/api/store` lifecycle, `/api/catalog/status` (now also returns `storeTimezone` and `releaseEndsAt` on active drops).
    - **A live product whose `releaseEndsAt` already passed now counts down to THAT instant** (never re-anchors to the next global drop) — the countdown effect fires the draw trigger the instant it renders, so a page loaded after the drop was due triggers the draw immediately on load. Product/home/catalog pages all run this load-time due-check (the server's 90s per-pool cooldown + due-check make repeat pings harmless).
    - The product page re-fetches (cache-busted) ~1.5s after ANY draw trigger so the UI reflects the post-draw state.
    - `LiveThemeValue` gained `dropSchedule` (server-baked into the layout theme blob) so pages know the store timezone on first paint.
  - **🧺 Signed-in cart sync ("the bag follows the account").** New `store:cart:<userId>` key (`lib/redis-keys.ts`), new `/api/cart/sync` route (GET returns the saved cart, POST upserts sanitized items, 401 when signed out), and new `lib/client-cart-sync.ts` (`mergeCarts`, `scheduleCartPersist` — 900ms debounced, `syncCartWithServer`). `components/SiteChrome.tsx` merges the server cart with the local bag ONCE per page session after login (server first, local overrides same product+size) and persists every cart change back to the account. Same login → same bag on any device. No migration row needed (new key, no legacy equivalent).
  - **🔇 F12 console cleaned up.** Removed every `[mapbox-autofill]` success/info log (SDK loaded, attach verified, no-inputs, no-token) — the F12 console is now silent for successful flows. Only real failures log (`console.warn`/`console.error`). Also removed two `[webhook]` `console.log`s that echoed customer emails/variants into server logs (they weren't errors). The CSS-preload warning in Chrome is a Next.js/Chrome artifact on dynamic routes (all `<Link>`s already use `prefetch={false}`).
  - **🃏 Share-card cache-buster bumped to `CARD_REVISION = 3`** (app/layout.tsx) so WhatsApp/iMessage/Discord — which cache previews by URL for days — are forced to re-fetch the card URL after this deploy even without a branding re-save. Metadata now also emits `og:image:secure_url` and the legacy `og:image:url`/`og:image:secure_url` meta tags (some crawlers require the explicit https form), and the `/og` failure fallback card is branded with the admin brand name instead of the generic "STORE". The `/og` route itself was verified live: 200 `image/png`.
  - Docs: this changelog + README updated in the same change set. Verified: `tsc --noEmit` clean, full `eslint` clean (0/0), `npm test` 23/23 pass.

- **2026-08-15 — Orb physics overhaul (accelerate + overshoot, Apple-style springs) + cart-drawer orb fix + premium design-language pass + drop-reliability hardening + admin polish:**
  - **🎯 Cart-drawer orbs fixed for real.** The old drawer orbs were 46%-of-drawer circles whose radial gradient only faded to transparent at 72% of the radius — big, strong colour discs that read as broken smudges, and `drawerOrbOpacity` FORCED a minimum 18 alpha even when the admin set an orb to 0 (so "disable the glow" never worked in the drawer). Now: every drawer orb is compact (16–34%), painted with a **soft gradient** (fully transparent by 60% radius) so it reads as a seamless wash of light, explicit opacity 0 renders nothing, a top glass sheen was added, and the drawer itself is frosted glass (`backdrop-filter: blur(26px) saturate(160%)`).
  - **🎢 Orbs now accelerate and overshoot the finger/cursor.** The old single-state spring was heavily damped (friction 0.928–0.966) with a hard 0.024 velocity cap — the orbs crept behind the cursor and could never pass it. The motion engine is now **per-layer damped springs** (`ORB_LAYERS` in `components/SiteChrome.tsx`): big ambient orbs glide majestically (low stiffness + heavy damping), small accent orbs dart and OVERSHOOT the cursor then bounce back (high stiffness + light damping). Pointer/finger VELOCITY is injected as a momentum impulse, so when the cursor moves fast the orbs swing PAST the stopping point and settle like a playful Apple spring. The old 0.024 cap is replaced with a soft 0.085 cap (still no teleporting) and reduced-motion users get slower, non-overshooting motion.
  - **🍎 Premium Apple design language.** `app/globals.css`: SF-style system font stack on the body and Tailwind `--font-sans`/`--font-mono`, soft `::selection` tint, slim styled scrollbars, Apple-style focus ring (soft glow instead of a harsh outline) on buttons/links/inputs, springier button press, and a global `prefers-reduced-motion` reducer. The site header is now **frosted glass** (backdrop blur + saturate + inner top hairline highlight) and the cart drawer is glass too.
  - **🛟 Drop-reliability hardening ("drops never fail").**
    - `lib/client-auto-draw.ts`: the "timer hit zero" ping now **retries with backoff (2s → 8s → 25s)** on failure and **re-arms after 4 min** so a tab left open past the zero-moment nudges the server again if the pool is still open (server dedupe makes repeats harmless).
    - **Fixed a real bug in `lib/auto-draw.ts`:** the go-live auto-activation flip was SKIPPED whenever a product filter was passed — the exact case the client countdown uses — so a product whose `goLiveAt` passed stayed `isUpcoming` in Redis forever. The flip now also runs for the filtered product (idempotent).
    - `components/Storefront.tsx`: when an "opens in" countdown hits zero the page now **re-fetches the product (cache-busted)** ~1.2s later so the timer re-anchors to `releaseEndsAt` instead of freezing on "Raffle closed". `lib/client-store-cache.ts` gained a `force` option to bypass the 10s-fresh / 5min-stale windows for exactly this.
    - **Exploit hardening:** the PUBLIC `/api/checkout/auto-draw` endpoint (POST + GET) is now **rate-limited per IP** via a 60s TTL Redis counter (8 requests/min; new ephemeral key `cache:rate:auto_draw:<ip>` in `lib/redis-keys.ts`) so a script can't hammer the draw engine / Redis scan / dry-run.
  - **🛠 Admin portal polish ("easier, more mistake-proof").** Every remaining bare `alert()` is replaced with the in-app toast (`showToast`) — password prompts, product/user/promo errors, export failures, wipe guards. `saveProduct` gained real validation: name required, **slug auto-generated from the name**, duplicate sizes removed, "at least one size+price" guard — all with friendly inline messages. The product Name input **live-auto-fills the Slug field** (never overwrites a manually edited slug). All destructive flows still require `confirm()` / the two-step WIPE gate.
  - Docs: this changelog + README updated; one new ephemeral Redis key (`cache:rate:auto_draw:<ip>`, no migration row needed — it has no legacy equivalent). Verified: `tsc --noEmit` clean, full `eslint` clean, `npm test` 18/18 pass, `npm run build` compiles every route + middleware.

- **2026-08-15 — DROP-ON-TIMER-ZERO FIX (critical) + email URL / share card / catalog ordering / tap feedback final pass:**
  - **💥 Auto-draw now actually fires.** Root cause of "when the timer hit 0, no drop happened": the cron routes (`/api/cron/auto-draw`, `/api/checkout/cron-draw`) iterated the STATIC `GOYUNIR_STORE_SUITE.productCatalog` to resolve pool products, so products created in the admin portal (which live ONLY in `store:products`) never drew — and `vercel.json` had NO cron configured at all. Verified against the live store: product "Elysian White — Launch Draw" ended 04:45 with an entry in its pool and zero draws.
  - **New shared draw engine `lib/auto-draw.ts`** — `runAutoDraws()` reads products from Redis (never static config), decides per-pool due-ness from the PRODUCT's own `releaseEndsAt` (passed → draw), `isArchived` (final draw), or the global schedule cadence, auto-activates upcoming products whose `goLiveAt` passed (persists the Redis flip), and runs the same winner-charging logic the old cron used. All three triggers now call it: `/api/cron/auto-draw`, `/api/checkout/cron-draw` (rewritten to thin wrappers; auth unchanged), and the NEW **`/api/checkout/auto-draw`** (public, client-triggered, supports `productId`/`productName`/`slug` filters + `dryRun=1` that simulates without charging/archiving).
  - **Client-side "timer hit zero" triggers** (`lib/client-auto-draw.ts` → `notifyDropDue()`): the product-page raffle countdown (`components/Storefront.tsx`), the catalog tiles (`app/catalog/page.tsx`) and the home-page drop countdowns (`app/page.tsx`) ping the auto-draw endpoint the second a countdown hits zero — the drop happens immediately, no cron needed. The server dedupes (per-pool `entries:last_auto` + 90s cooldown) so a stampede of visitors can't double-draw.
  - **`vercel.json` cron re-added** — `*/5 * * * *` → `/api/checkout/cron-draw` as the server-side safety net (Vercel auto-attaches `Authorization: Bearer $CRON_SECRET` + `x-vercel-cron: 1`). Without SOME trigger the draws never ran; the client trigger + cron now guarantee a drop.
  - **Email "Create account to redeem" link fixed** — it rendered `https:///auth/signup` (broken) because a malformed site URL (`https:` / `https://`) survived `getSiteUrl()`. New `lib/url-utils.ts` → `normalizeSiteBase()` validates scheme+host and falls back safely; `lib/env.ts` `getSiteUrl()` now returns '' for scheme-only/domain-only values; `siteUrlFromRequest` in `/api/checkout/confirm-setup` uses the real request host instead of a stock `https://example.com` fallback. Tests added.
  - **Share card cache-buster fixed for real messengers.** `/og` returns 200/`image/png` (verified locally). The remaining real-world failure was messenger caching: WhatsApp/iMessage cache previews by URL for days, and the `?v=` hash only changed when branding changed. `app/layout.tsx` now folds a `CARD_REVISION` constant into the hash (bump it on any card-code change) so this deploy forces a re-fetch, and `app/og/route.ts` sends `Cache-Control: public, max-age=0, must-revalidate`. Metadata `base` is now built through `normalizeSiteBase` so a bare-domain admin `shareUrl` can never produce a relative `og:image`/broken `metadataBase`.
  - **Catalog category ordering is admin-configurable.** Default: **Currently Available at the BOTTOM** (`['upcoming','archive','live']`). New `store:config.catalog.sectionOrder` (Settings → **Catalog (section order on /catalog)** with up/down controls) flows through `/api/store` config, `/api/catalog/status` (`sectionOrder` field) and `useLiveTheme()`. `app/catalog/page.tsx` renders sections in that order.
  - **Catalog consistency:** `/api/catalog/status` now enriches static `catalogPreview` upcoming/archive entries with the REAL product's `checkoutMode`/`isRaffle`/`slug`/`goLiveAt` (matched by slug or name), so Raffle/FCFS tags and countdowns show consistently on configured cards — and product-derived lifecycle reconciliation keeps items from appearing in both Upcoming and Currently Available.
  - **Tap feedback:** links styled as buttons (catalog "View what's active", home "Create account", product pills) now get the same instant press-down animation as `<button>` (`app/globals.css`), so a tap on a slow connection is never visually unanswered.
  - Docs: this changelog + README updated; no NEW Redis keys were added (all keys already documented). Verified: `tsc --noEmit` clean, `eslint` clean, `npm test` 18/18 pass, `npm run build` compiles all routes; auto-draw dry-run validated against live Redis (ended pool detected + winner simulated, zero writes).

- **2026-08-15 — Unified border-radius system (one admin setting drives ALL pages) + /story uniformity:**
  - **New shared radius helpers** `themeRadius()` / `themeRadiusNumber()` in `lib/storefront-config.ts`
    — the SINGLE source of truth for the admin "Border Radius (px)" setting
    (`themeColors.borderRadius`). Before this change the token only reached the
    product page, site chrome, /story and legal pages (each via its OWN duplicated
    `uiRadius`/`radius` local helper), while home, catalog, account, auth, the
    waitlist and the 404 used hardcoded radii (14/16/18/20/22/24/28/30px). Now every
    storefront surface reads the same token: change `/admin → Settings → Theme
    Colors → Border Radius (px)` and the roundness of every main-page card, panel,
    tile, modal, input and banner changes together. Buttons/pills stay fully-rounded
    999px by design (that pill language is intentional and not tokenized).
  - **Duplicated helpers removed:** the local `uiRadius` in `components/Storefront.tsx`
    and `components/SiteChrome.tsx`, and the local `radius` in `app/story/page.tsx`
    and `components/LegalPage.tsx`, are gone — all four now import the shared
    `themeRadius`. No more drift between pages.
  - **Wired into every page** (replacing hardcoded values): `app/page.tsx` home hero
    + product cards + sold-out cards + member-perk section; `app/catalog/page.tsx`
    tiles, info/search/error surfaces, detail modal sheet + image + Close (now a
    999 pill); `app/account/page.tsx` all cards, verify/rewards/credits/password
    panels, entry cards, action buttons (Save/Cancel/Edit/Cancel entry/Update
    payment → pills); all four `/auth` pages (panel + inputs; submit buttons →
    pills); `components/ReleaseWaitlist.tsx` card; home "release opens" chip → pill.
  - **/story is now uniform with the rest of the site:** it uses the SAME shared
    `themeRadius` (so on light presets its card radius now matches every other card
    instead of being a different number), and its headline uses the same
    `'Georgia, Times New Roman, serif'` display typeface as the home hero, product
    page, account and legal pages.
  - Docs: this changelog entry. No Redis keys were added or changed. Verified:
    `tsc --noEmit` clean, full `eslint` clean (0/0), `npm test` 14/14 pass,
    `npm run build` compiles every route + middleware.

- **2026-08-15 — Theme-consistent contrast pass (story page + all content pages):**
  - **Story page is readable on EVERY design preset.** Root cause: `app/story/page.tsx`
    rendered `cardTextMain`/`cardTextMuted` (tokens designed for CARD surfaces)
    directly on `primaryBackground`. On the light-theme presets (Luxury, Wellness,
    Editorial, Monochrome) the page background is white/cream while `cardTextMain`
    is also near-white → the whole page was effectively invisible. The page now
    uses the same token discipline as every other page: `textMain`/`textMuted` on
    the page background, and the story body lives in the same themed card surface
    (`surfaceBackground(cardBackground, surfaceTransparency)` +
    `cardTextMain`/`cardTextMuted`) as the home/catalog/account cards, so it is
    guaranteed readable on light AND dark presets. Border radius now follows the
    admin `borderRadius` token via a `radius()` helper (matches Storefront/SiteChrome).
  - **Story buttons are now visible.** The "Back to store" pill previously used a
    hardcoded `rgba(255,255,255,0.06)` fill — literally white-on-white on light
    themes. It now uses the site-wide secondary-button style (`cardBackground`
    surface + `cardTextMain` + `cardBorder`). The CATALOG/STORY breadcrumb was
    tiny 12px plain text; both entries are now proper pills (CATALOG = outlined,
    STORY = filled current-page state).
  - **Same contrast bug fixed in the rest of the site** (`make everything more
    consistent`):
    - `components/LegalPage.tsx` (/terms, /privacy, /shipping): same
      `cardTextMain`-on-page-background + invisible back-button bugs — fixed to
      `textMain`/`textMuted` on the page bg, content wrapped in the themed card
      surface, back button in the visible secondary style, radius follows the token.
    - `app/account/page.tsx`: "My Account" H1 used `cardTextMain` on the page
      background (invisible on light presets) → `textMain`; "Back to store" pill
      now uses the visible surface style instead of the white 6% tint.
    - `components/NotFoundView.tsx`: 404 H1 used `cardTextMain` on the page
      background → `textMain`.
    - `app/page.tsx`: the home hero "Our Story" button border used a brittle
      `cardTextMain === '#0a0a0c'` equality check (wrong border color on several
      presets, e.g. Warm Paper's white-on-white card) → now a theme-derived
      `color-mix(in srgb, cardTextMain 32%, transparent)` border that adapts to
      any preset. The product status pill ("Release opens…" / countdown) swapped
      its hardcoded white tint + `#e7e7eb`/`#dbeafe` text for theme-aware
      `color-mix` backgrounds and `accentBlue`/`cardTextMain` text so it stays
      readable on light preset cards too.
  - Docs: this changelog entry. No Redis keys were added or changed. Verified:
    `tsc --noEmit` clean, full `eslint` clean (0/0), `npm test` 14/14 pass.

- **2026-08-14 — Tap feedback, slow-connection hardening + catalog consistency**

  (final "make it feel fast" pass):
  - **Universal tap feedback** (`app/globals.css`): every `button`/`[role=button]`
    now visibly depresses the instant it is pressed (`:active` scale + fade,
    120ms) and buttons use `touch-action: manipulation` (kills the ~350ms mobile
    double-tap-zoom delay). A tap is now ALWAYS visibly answered, even before any
    JS/network work starts; disabled (busy) buttons deliberately don't press,
    which is itself a clear "working…" signal.
  - **Every async button now shows a busy state.** `components/Storefront.tsx`:
    "Add to bag" (its server duplicate lookup previously ran with ZERO visual
    feedback — the exact "looks like nothing was pressed" bug), promo "Apply"
    (new `promoBusy`), and the Raffle/Direct/Waitlist submit buttons all show an
    inline spinner + dimmed/disabled state while in flight. The cart drawer
    checkout (`components/SiteChrome.tsx`) and the release-waitlist subscribe
    button (`components/ReleaseWaitlist.tsx`) got the same spinner treatment.
  - **Slow-connection hardening** (`lib/client-store-cache.ts`): `fetchStoreJson`
    now does stale-while-revalidate (serves the last good payload instantly for
    up to 5 min while a background refresh repairs it), aborts each network
    attempt after 10s, and retries once with a 700ms backoff — a flaky/congested
    connection shows content instead of blank sections or endless spinners. The
    catalog page now routes its `/api/catalog/status` fetch through this cache,
    keeps the last product visible during re-fetch, and shows an inline "Loading
    the catalog" spinner plus a Retry banner on failure instead of silently
    rendering empty sections.
  - **Catalog navigation feedback** (`app/catalog/page.tsx`): catalog tiles now
    use `router.push` (client-side nav) with a full-screen "Opening {name}…"
    overlay instead of `window.location.assign` (which was a full page reload —
    on a slow connection it looked like the tap did nothing).
  - **Catalog consistency** (upcoming vs live vs archived): `/api/catalog/status`
    now emits `checkoutMode`/`isRaffle` on every active/upcoming/archive row
    (same normalization as `/api/store`) and drops configured-upcoming entries
    that point at a product that is now live OR archived. The catalog page
    reconciles the status payload (15s TTL) against the live store payload (10s
    TTL) client-side so a product can NEVER appear in both "Currently
    Available" and "Upcoming Releases", and an item that went live (goLiveAt
    passed) is never still advertised as upcoming. Raffle/FCFS tags now show
    consistently on live, upcoming and archive cards. The catalog sections were
    reordered to match the page's own copy ("live now, what is next, and what
    already moved") and the rest of the site: **Currently Available → Upcoming
    Releases → Past Archives** (live drops were previously buried at the bottom
    below archives).
  - Docs: AGENTS.md updated (mandatory commit-workflow rule added, caching
    section + this changelog entry). No Redis keys were added or changed.

- **2026-08-14 — Link preview / share card reworked + exact as-shared admin preview:**
  - **Share card moved to a Route Handler at `/og`** (`app/og/route.ts`) and the
    `app/opengraph-image.tsx` file convention was REMOVED. Why: Next's file
    convention emits a content-hash `?v=…` og:image URL that NEVER changes when
    the buyer edits Branding → Share, so WhatsApp/iMessage/Discord (which cache
    previews aggressively by URL) showed a STALE card forever. `generateMetadata`
    (`app/layout.tsx`) now points `og:image` / `twitter:image` at
    `/og?v=<revisionHash(branding+theme)>` — the URL changes on every save, so
    crawlers are forced to re-fetch. Metadata also emits `og:image:type` and
    `twitter:image:alt/width/height`.
  - **The card can NEVER 500 again.** `lib/brand-image.ts` gained
    `fetchImageAsDataUrl()` / `resolveBrandImageForSatori()`: remote/relative
    logo + share images are fetched by US with a 4s timeout, content-type + 1MB
    size guard, cached 60s, and converted to data: URLs — because satori fetches
    `<img>` sources itself and throws (500) on a slow/down/hotlink-protected URL.
    Colors are sanitized via the new `lib/share-card-config.ts` helpers
    (`safeCssColor`, `hexToRgba`, `cardBackgroundStyle`, `cardSiteUrlDisplay`,
    `revisionHash`, …) so free-text admin values can never inject broken CSS.
    Both `/og` and `/icon` wrap the render in try/catch with a minimal branded
    fallback card/icon. Route Handlers are `route.js|ts` only (no `.tsx`), so
    `/og` builds the element with `React.createElement`.
  - **Exact as-shared admin preview** (`/admin → Settings → Branding & Share`):
    the old tiny fake card is replaced by `components/LinkPreviewGallery.tsx`,
    which renders the REAL card live from the CURRENT (unsaved) form state via
    the shared `components/ShareCard.tsx` (used by both `/og` and the preview so
    they can't drift), plus pixel-faithful messenger mockups for WhatsApp,
    iMessage, Discord, X/Twitter and Facebook, the copyable share link, the
    actual generated `/og` PNG (refreshes after Save), and a caching
    troubleshooting note.
  - Docs: this changelog entry; no Redis keys were added or changed. The old
    `app/opengraph-image.tsx` file no longer exists — the card now lives at `/og`.

- **2026-08-14 — OG share card fixed for real + social-proof contrast fix:**
- **2026-08-14 — OG share card fixed for real + social-proof contrast fix:**
  - **The share-link card was still broken because the OG image route CRASHED.**
    Root cause: `app/opengraph-image.tsx` fed the admin Branding → Logo URL and
    Share image values straight into `next/og`'s `ImageResponse`, which only
    accepts ABSOLUTE image sources. A leftover/free-text value in those admin
    fields (e.g. `"a image url"`) threw
    `Error: Image source must be an absolute URL` while the response was being
    piped — `/opengraph-image` returned 500 and the connection dropped, so
    WhatsApp/iMessage/Discord never got a card. Fixed with a new server-only
    helper **`lib/brand-image.ts` → `resolveBrandImageSource()`**: keeps valid
    `http(s)://` and `data:image/…` URLs, resolves root-relative paths
    (`/images/…`, `/uploads/…`) against the real site URL (env → request host),
    and drops anything invalid so the card/favicon ALWAYS renders (text-only
    fallback). Wired into both `app/opengraph-image.tsx` and `app/icon.tsx`.
    Verified live: `/opengraph-image` went from 500 → 200 (84KB PNG) with the
    exact same broken Redis config.
  - **Social-proof surfaces on the home page are readable again**
    (`app/page.tsx`): the "Total raffle entries" box and the "Social proof"
    sold-out release cards used hardcoded `rgba(255,255,255,0.02)` /
    `rgba(255,255,255,0.04)` white-tint backgrounds, which are nearly
    invisible ("totally clear") — especially on light themes — while their text
    uses light `cardTextMain`/`cardTextMuted`. Both now use the same
    `surfaceBackground(cardBackground, surfaceTransparency, …)` helper as every
    other card on the page, so they get the (dark, in every preset) card
    surface and readable text.
  - Note for template buyers: the admin `store:config` branding still holds the
    placeholder values you typed while testing (`logoUrl: "a image url"`,
    `shareDescription: "a description"`, brand "GOYUNIR"). The card no longer
    crashes on them, but re-save real values in `/admin → Settings → Branding &
    Share` (clear the Logo URL field or paste a real URL) to brand the card.
  - Docs: AGENTS.md change log updated; no Redis keys were added or changed.

- **2026-08-14 — Share-link fix (request-host URLs) + address UX copy cleanup:**
  - **Link previews no longer resolve to the stock `https://example.com`
    placeholder** when the buyer hasn't set `NEXT_PUBLIC_URL` /
    `NEXT_PUBLIC_SITE_URL` / `SITE_URL` or the admin Branding → Share URL.
    `generateMetadata` (`app/layout.tsx`) and the OG card (`app/og/route.ts`)
    now fall back to the CURRENT REQUEST's host via the new server-only
    `lib/request-url.ts` → `getRequestSiteUrl()` (env URL → request host →
    admin Share URL → neutral placeholder). `metadataBase`, `og:url`, canonical
    and `og:image` now always point at the real deployed domain, so
    WhatsApp/iMessage/Discord show the branded card instead of a broken stock
    link.
  - **Address autofill status line simplified** (Storefront + cart drawer in
    `components/Storefront.tsx` / `components/SiteChrome.tsx`): both
    "Address autofill on…" variants now just say **"Use address dropdown"**.
  - **Address validation message decluttered** (`lib/address-validation.ts`):
    the verbose per-reason paragraphs ("Add the country…", "Add the ZIP /
    postal code…", …) are replaced with ONE short, friendly message:
    **"Please select your full address from the dropdown so we can ship it to
    you."** The client-side "Tip: pick a complete address from the autofill
    suggestions…" suffix was removed from both Storefront and SiteChrome.
    `tests/address-validation.test.ts` updated to match.
  - **"preloaded but not used" CSS console spam gone.** Every `<Link>` now sets
    `prefetch={false}` (header/footer chrome, admin, home/catalog product cards,
    auth pages, story/legal/not-found links). The whole app is one single CSS
    chunk and every route is dynamic, so route prefetching re-preloaded the
    already-applied stylesheet and Chrome logged
    `The resource ...css was preloaded using link preload but not used...`
    repeatedly (9× on `/admin`). `prefetch={false}` stops the router from
    injecting those duplicate CSS preloads with no UX cost on dynamic routes.
  - Docs: AGENTS.md + README updated; no Redis keys were added or changed.

- **2026-08-14 — Orb visibility fixes (home page + cart drawer) + mobile header nav:**
  - **Home-page orbs now glow exactly like the catalog/product pages** (`app/page.tsx`).
    Root cause: every home section animated with `goyunirFadeUp … both`, and the
    keyframes ended at `transform: translateY(0)`. With `fill-mode: both` that
    non-`none` transform stays applied forever, so every hero/card section remained
    a stacking context painted ABOVE the fixed `zIndex: 0` background-orb layer —
    the orbs were literally rendered behind the section surfaces. Fixes: the
    `goyunirFadeUp` keyframes now end at `transform: none`, all home sections use
    `backwards` fill, and the product-card stagger inline transform
    (`translateY(0/2px)`, itself a stacking context) was replaced with a `marginTop`
    offset. Home surfaces now use the plain `surfaceBackground()` helper like every
    other page (the old `glowSurface` 86% cap is gone).
  - **Cart-drawer orbs fixed** (`components/SiteChrome.tsx`): the drawer glow divs
    were 84–86% of the drawer with hardcoded +6/+10/+12 opacity boosts and negative
    offsets (`right: '-16%'` etc.). The gradients don't fade to transparent until
    72% of radius, so the drawer's `overflow: hidden` boundary sliced through the
    still-strong part of the gradients — giant clipped colour blobs with hard edges
    ("glitched broken"). They are now compact edge glows fully inside the drawer (no
    clipping), and opacity comes from the configured orb values via the new
    `orbGlowOpacity()` helper (explicit `0` = no glow, no boosts).
  - **Mobile header nav** (`components/SiteChrome.tsx`): the `CATALOG` button label
    is now `MORE` (magnifier icon kept) so the fixed header fits narrow screens.
  - Docs: this changelog entry; no Redis keys were added or changed.

- **2026-08-14 — Finalization pass (repo hygiene + full verification):**
  - **Removed every tracked debug/scratch artifact** that had been committed
    during development: the `.admin-*` Playwright repro scripts, `.mapbox-*`
    analysis/repro scripts + logs, `.inspect-config.cjs`, `*.log` / `*.pid`
    files, and `files_list.txt`. These never belong in the shipped template.
  - **`e-commerce-store/.gitignore` hardened** — patterns for `.admin-*`,
    `.inspect-*`, `.mapbox-*`, `*.pid`, and `files_list.txt` were added so
    scratch artifacts can never be re-committed.
  - **Stale git-repo-root leftovers removed**: an old `node_modules` remnant,
    `package-lock.json`, and `vercel.json` that sat at the repo root
    (`customAttempt_1/`, outside this subdirectory) were untracked and
    deleted. The project is fully self-contained under `e-commerce-store/`;
    the root `.gitignore` is now committed. When deploying this repo to
    Vercel, point **Root Directory** at `e-commerce-store`.
  - **Full verification green on the cleaned tree**: `npm run lint` (0 errors,
    0 warnings), `npm run typecheck`, `npm test` (7/7), and `npm run build`
    (every route + the proxy middleware compile) all pass.

- **2026-08-14 — Storefront UX + settings pass (sticky save bar, editable home copy, swipeable gallery, cart orbs):**
  - **Admin sticky "Save All Settings" bar now sticks BELOW the fixed top bar** (`app/admin/page.tsx`): the sticky offset was `top: 12`, so as you scrolled the long settings form the bar slid under the 84px fixed storefront header. It now uses `top: 92` (matching the content padding) so it floats just under the top bar and stays fully visible.
  - **Home-page "Priority drops" subtitle default is now "Explore our creations"** (was "Curated by our team — refreshed as releases move") and BOTH the section title and subtitle are editable from `/admin → Settings → Storefront copy` via the new `settings.copy.priorityDropsTitle` / `priorityDropsSubtitle` keys (empty = built-in default).
  - **Storefront copy overrides are now actually wired up.** The `settings.copy` block (saved by /admin → Settings → Storefront copy) was persisted but never read by the storefront. It now overrides (non-empty wins): home hero headline/subtitle (`heroTitle`/`heroSubtitle`), the product-page entry CTA (`entryCta`), the cart drawer title (`cartTitle`), the footer tagline (`footerTagline`), and the footer support email link (`supportEmail`, falling back to the Footer tab value). Reads flow through `useLiveTheme()` (server-baked, no flash) and are refreshed from `/api/store → config.copy`.
  - **Product images are swipable** (`components/Storefront.tsx`): the gallery accepts pointer-drag swipes (touch + mouse) with a live drag preview, spring-back when the gesture is too short, and a photo flip past a 52px horizontal threshold. Vertical drags still scroll the page (`touch-action: pan-y`). Added desktop chevron arrows and a subtle "Swipe" pill (shown when auto-advance is off). Autoplay pauses during a drag and only resumes on touch release (mouse uses hover-pause).
  - **Orbs are more visible on the home page** (`app/page.tsx`): the home-page surface helper caps fully-opaque surfaces at 86% opacity (was 93%) so the glow bleeds through the hero + product cards more noticeably, matching the catalog/product pages.
  - **Orbs now glow inside the cart drawer** (`components/SiteChrome.tsx`): the drawer paints above the page-level orb layer, so it previously hid them entirely. The drawer now carries its own subtle orb glow layer (primary/secondary/tertiary orb colors at slightly boosted opacity) behind the content.
  - Docs: this changelog entry; no new Redis keys were added (copy fields live under the existing `settings.copy` / `store:config.copy` block).

- **2026-08-14 — Admin device tokens + 2FA gate UX (hash cleanup, no-flash gate, auto-send):**
  - **`admin:device:<token>` folder spam is gone.** Verified admin devices now live in a
    SINGLE Redis hash `admin:devices` (field = token, value = JSON with an explicit
    `expiresAt`), instead of one top-level key per browser (which made the Redis data
    browser fill with `admin:device:...` rows). `lib/redis-keys.ts` dropped
    `adminDeviceKey()` for `ADMIN_DEVICES_KEY`; `lib/admin-verify.ts` writes via
    `HSET` and validates via `HGET` with lazy expiry (an expired token is `HDEL`-ed
    the first time it's checked, so the hash self-cleans). Revoking a stolen device is
    now a one-field delete instead of hunting a random key. `/admin → Developer →
    Tidy Redis Schema` gained a migration step that folds any legacy `admin:device:*`
    string keys into the hash (expiry derived from each key's remaining TTL; safe to
    re-run). The cookie name (`goyunir_admin_device`) is unchanged, so existing
    browsers stay verified.
  - **The 6-digit 2FA screen now appears BEFORE any secret info.** `/admin` previously
    SSR'd the full portal while the device cookie check ran, so the portal flashed
    first and *then* the gate replaced it — and that portal hydration caused a React
    418 "server rendered text didn't match the client" error in F12. While
    `adminVerified === null` the page now renders a small deterministic "Checking
    admin verification…" screen; the portal only ever renders after verification
    succeeds. No flash, no hydration mismatch, no secret data before 2FA.
  - **A code is emailed automatically** the moment the 2FA gate appears (guarded by a
    ref so it fires once per gate open; the 60s server throttle prevents spam, and a
    mid-session re-lock auto-sends again). The gate's primary button flips to "Send a
    new code" after the auto-send. No more "nothing happens until I press Send".
  - Docs: AGENTS.md namespace map + this changelog + README key list updated in the
    same change set.

- **2026-08-14 — 2FA / verification code flow fixed (Upstash deserialization bug):**
  - **Root cause**: `@upstash/redis` enables `automaticDeserialization` by default, so
    `redis.get()` returns JSON stored via `setex` as an **already-parsed object**.
    `lib/admin-verify.ts` and `lib/customer-verify.ts` called `JSON.parse(String(raw))`
    on that value — `String(object)` is `"[object Object]"`, so the parse threw and
    the payload came back empty. Concretely:
    - `consumeAdminCode()` treated every submitted code (even the exact code the
      server generated) as wrong → `/api/admin/verify-confirm` always returned
      `400 {"error":"Incorrect code…"}`.
    - `isAdminDeviceValid()` (used by `proxy.ts` on EVERY `/api/admin` request)
      rejected every device token → even a successful confirm was followed by
      `401 ADMIN_2FA_REQUIRED`, so the portal never unlocked.
    - `lib/customer-verify.ts` had the same bug in `issueCustomerVerifyCode()`
      (resend throttle never worked) and `consumeCustomerVerifyCode()` (every
      signup code was rejected).
  - **Fix**: both files now parse Redis JSON via the existing shared
    `safeParseRedisItem()` helper (returns objects as-is, parses strings),
    matching the pattern every other route in the codebase already used.
  - **Dev-mode lockout fixed**: when the email provider fails to send the code
    (e.g. Resend's sandbox rejects the recipient), `issueAdminCode()` /
    `issueCustomerVerifyCode()` no longer hard-fail outside production — the
    challenge is already stored in Redis and `devCode` is echoed so a fresh
    clone stays usable. Production still fails loudly (the code is only
    deliverable by email there).
  - **Hydration hardening**: `app/layout.tsx` `<body>` now carries
    `suppressHydrationWarning` (matching `<html>`) because the layout's inline
    theme script also mutates `document.body.style` before React hydrates.
  - Verified end-to-end locally: verify-start → verify-confirm (200 + device
    cookie) → protected `/api/admin/*` (200 with cookie, 401 without). Lint +
    typecheck + `npm test` clean.

- **2026-08-14 — Multi-part storefront + admin hardening pass:**
  - **Mapbox full-address fill fixed** (`lib/mapbox-autofill.ts`): confirmed in
    the search-js v1.6.0 bundle that the SDK's `retrieve` handler dispatches the
    event and THEN writes ONLY `address_line1+2+3` into a `street-address` input
    (dispatching React-simulated input events that clobber state). `handleRetrieve`
    now composes the full address, marks the input with a `data-mapbox-full-fill`
    attribute, installs a **capture-phase document `input` guard** that rewrites
    the full address the instant the SDK truncates it (8s window), and re-resolves
    the input element on every retry so a React node replacement can't orphan it.
    `composeFullAddress` gained more property fallbacks (`place_formatted`,
    `neighborhood`, `state`, `zip`, `detail.feature.properties`).
  - **Admin two-step verification (2FA)** — after Basic Auth, `/admin` now
    requires a 6-digit code emailed to `ADMIN_VERIFY_EMAIL` (fallback
    `SUPPORT_EMAIL`). New keys `admin:verify:<email>`, `admin:device:<token>`,
    `admin:verify_attempts:<email>`, `admin:send_attempts:<email>`; new routes
    `/api/admin/verify-start|send|confirm|status`; `proxy.ts` validates the
    device cookie on every `/api/admin` request (30d remember / 24h browser-only),
    rate-limits resends (1/min) and locks after 5 wrong codes (15 min). The admin
    page shows a verification gate until confirmed and re-shows it whenever a
    401 `ADMIN_2FA_REQUIRED` arrives mid-session.
  - **Admin security hygiene** — `proxy.ts` now enforces Basic Auth on EVERY
    `/admin` + `/api/admin` path (the password-in-query bypass for audit /
    export / self-test is gone). All admin routes compare passwords via the new
    timing-safe `verifyAdminPassword()` / `adminRequestAuthorized()` helpers in
    `lib/server-config.ts`. The admin page no longer puts the password in URLs
    (CSV export now uses a fetch + blob download) and `/api/store/config`'s
    Bearer check is timing-safe too.
  - **Streamer-mode password mask** (`app/admin/page.tsx`): the password field
    shows a fixed `••••••••` mask (never the real length) while Streamer Mode is
    ON, the field is disabled, and toggling it ON clears any typed value.
  - **Customer email verification** (anti-exploitation) — new signups are
    created unverified with 0 rewards; a 6-digit code is emailed and confirmed
    via the new `/api/auth/verify-email` (code stored hashed under
    `auth:verify:<email>`, 30-min TTL, 6-attempt lock, 60s resend throttle via
    `/api/auth/resend-verification`). Welcome points + the one-time 10% promo +
    session are issued only after verification. The signup page gained an inline
    verify step, `/account` shows a verify card for unverified users, and
    `/api/account/claim-welcome` refuses to issue rewards until verified.
  - **Catalog archived chips** (`app/catalog/page.tsx`): archived cards now get
    the same attention chip as upcoming ones — green "STILL OPEN — ENTER NOW"
    when enterable, else a yellow chip with state-accurate wording
    ("DRAW COMPLETE — SOLD OUT" for raffles, "SOLD OUT — DROP COMPLETE" when a
    sold-out date exists, "PREVIOUSLY RELEASED" otherwise). The seeded-vs-manual
    messaging difference (countdown vs "ENTER BEFORE DROP") comes from whether
    the entry carries a `goLiveAt` date.
  - **Address-autofill hint decluttered** (Storefront + SiteChrome cart drawer):
    the verbose "✓ Address autofill is on — pick a suggestion and the full
    address…" banner is now a tiny dot + label like the "Encrypted payment
    setup" indicator, placed above it.
  - **Share/OG card follows design presets** (`app/og/route.ts`,
    `app/layout.tsx`, admin `applyThemePreset`): preset apply now also sets the
    share-background/accent/text colors, the OG generator falls back to the live
    theme colors, and `generateMetadata` emits an absolute OG image URL (env URL
    → admin shareUrl → example.com) so messengers (WhatsApp/iMessage/Discord)
    can fetch the card image.
  - Docs: AGENTS.md updated (key map, admin section, rewards section, env table)
    + README updated in the same change set.

- **2026-08-14 — Admin portal console-error + settings-save fixes:**
  - **Site-wide hydration mismatch fixed** (`app/layout.tsx`): the layout's
    synchronous inline theme script mutates `document.documentElement.style`
    (CSS vars `--ui-radius`, `--background`, `--foreground`,
    `--ui-chrome-alpha`, `--ui-surface-alpha`) *before* React hydrates, so the
    live DOM differed from the SSR HTML and every page threw
    `Minified React error #418` ("A tree hydrated but some attributes of the
    server rendered HTML didn't match the client properties"). The CSS vars are
    now baked into the server `<html style>` AND the element carries
    `suppressHydrationWarning`, so hydration always matches.
  - **"Winners / draw" number-input warnings fixed** (`app/admin/page.tsx`):
    the per-size field was `<input type="number">` but seeded products store
    multi-tier CSV values (`'3,2,2'`, `'2,2,1'`), which made the browser log
    `The specified value '3,2,2' cannot be parsed, or is out of range` dozens
    of times on every render. It is now a text input (placeholder
    `Winners / draw (e.g. 3,2,2)`) with a `normalizeWinnerTiersCsv()` helper
    that accepts comma-separated positive integers.
  - **Settings-save UX when Streamer Mode is ON** (`app/admin/page.tsx`): the
    default-on Streamer Mode disables the password field, so clicking
    "Save All Settings" just fired a bare `alert('Enter password')` (read as
    "saving is broken"). It now shows an inline message: "Turn OFF Streamer
    Mode first, then enter the admin password to save settings."

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


