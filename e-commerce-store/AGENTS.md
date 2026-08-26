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

**Storage backend access goes through the storage abstraction (`lib/storage/`).**
Routes NEVER import `@upstash/redis` directly — they call `createRedisClient()`
from `@/lib/server-config`, which is a thin alias for `createStorageClient()`
(`lib/storage/index.ts`). The backend is selected once per process by
`STORAGE_PROVIDER` (default `upstash`): the **Upstash REST Redis** adapter
(`lib/storage/upstash.ts` — the battle-tested engine on every platform,
including Cloudflare via Upstash's Marketplace integration) or the **Workers-KV**
adapter (`lib/storage/cloudflare-kv.ts` — zero third-party storage; read its
concurrency caveats before routing payment/raffle writes at it; falls back to an
in-memory store for local dev/tests). The `StorageClient` contract
(`lib/storage/types.ts`) covers exactly the command surface the codebase uses;
new commands must be added there AND in both adapters.

**Every Redis key is defined ONCE in `lib/redis-keys.ts`.** That file is the
mandatory single source of truth for key names, helpers, and the namespace map.
Routes import keys/helpers from `@/lib/server-config` (which re-exports the
registry). **NEVER hardcode a Redis key string anywhere else** — a schema
change must be a one-line edit plus the migration row in `/api/admin/organize-redis`.

The key space uses one tidy `domain:subdomain:…` convention so the Upstash /
Redis data browser stays filterable and organised at any scale:

| Namespace | Contents | Keys |
| --- | --- | --- |
| `store:` | Canonical, admin-edited data (the ONLY data a buyer configures) | `store:products` (hash), `store:config` (string), `store:users` (hash), `store:carts` (hash — signed-in cart mirror, field = user id) |
| `archive:` | Permanent entry/charge history (append-only) | `archive:ledger` (list) |
| `promo:` | Promo code records + operational state | `promo:codes` (hash), `promo:used:<code>` (set), `promo:pending:<code>:<email>` (ttl string), `promo:credit:<orderRef>` (string) |
| `entries:` | LIVE entry/intent/waitlist pools, fraud blocks, dedupe | `entries:pool:<variant>:<size>`, `entries:intent:<variant>:<size>`, `entries:waitlist:<variant>:<size>` (lists), `entries:stats` (hash), `entries:block:email:<variant>:<size>` / `entries:block:card:…` (sets), `entries:processed` + `entries:email_sent` (**bounded zsets** — scored by timestamp, pruned on every write: 72h / 30d windows), `entries:last_auto` (hash, field = `variant:size`) |
| `draws:` | Draw summaries + history | `draws:last` (string), `draws:history` (list) |
| `ops:` | Operational state + admin live-apply overrides | `ops:live_state` (hash), `ops:catalog_archive` (hash), `ops:recovery_config` (string), `ops:recovery_sent` (hash), `ops:overrides` (hash — fields `schedule`, `social_proof`, `product:<id>`) |
| `auth:` | Auth tokens + verification challenges | `auth:session:<token>` (ttl string), `auth:reset:<token>` (ttl string), `auth:verify:<email>` (ttl string) |
| `admin:` | Admin-only data + two-step verification state | `admin:audit_log` (list), `admin:verify:<email>` (ttl string — payload also carries attempts + resend throttle + lockout), `admin:devices` (hash of verified device tokens — one key, not one per browser) |
| `analytics:` | Social-proof counters + online visitors | `analytics:online` (zset), `analytics:social_boost`, `analytics:ticks` (hash — fields `last` / `today` / `day`) |
| `customer:` | Customer-submitted data | `customer:waitlist` (hash), `customer:addresses` (hash) |
| `cache:` | Ephemeral caches (safe to delete anytime) | `cache:stripe_portal_config` (string), `cache:rate:<namespace>:<ip>` (ttl string — generic per-IP abuse limiter, e.g. `cache:rate:auto_draw:<ip>`, `cache:rate:checkout:<ip>`, `cache:rate:auth_login:<ip>`) |

Highlights of what changed in the tidy schema (and why it matters at scale):

- **ONE hash per high-churn namespace — the Redis browser never grows a key
  per product/per user/per size.** Per-user carts live in `store:carts` (field
  = user id), auto-draw timestamps in `entries:last_auto` (field =
  `variant:size`), admin overrides in `ops:overrides` (fields `schedule`,
  `social_proof`, `product:<id>`), the social-proof ticker in `analytics:ticks`
  (fields `last`/`today`/`day`), and the admin 2FA counters live INSIDE the
  `admin:verify:<email>` payload (no more `admin:verify_attempts:*` /
  `admin:send_attempts:*`). The key space stays at a FIXED, small size no
  matter how many customers sign up or products are added.
- **Pools** live under `entries:pool:` / `entries:intent:` / `entries:waitlist:`
  (was `drop_pool:` / `intent_pool:` / `waitlist:`), fraud blocks under
  `entries:block:email:` / `entries:block:card:` (was `drop_fraud_block:*:emails|cards`).
- **Sessions** live under `auth:session:` (was `session:`); password resets under
  `auth:reset:` (was `reset:`). Sessions expire on their own TTL and are grouped
  under one prefix so the browser stays tidy with thousands of customers.
- **Live states / catalog archive** moved under `ops:` (`ops:live_state`,
  `ops:catalog_archive`); promos consolidated under `promo:` (`promo:codes`,
  `promo:used:`, `promo:pending:`, `promo:credit:`).
- **Analytics/social-proof counters** moved under `analytics:*`.
- **Dedupe sets are BOUNDED, not permanent.** `entries:processed` (Stripe
  session ids) and `entries:email_sent` (`variant:size:email` rows) are ZSETs
  scored by timestamp. Every write prunes members older than the retention
  window (72h = Stripe's webhook retry window; 30 days for sent emails), so
  they can never grow unbounded no matter how busy the store gets. A legacy
  SET-shaped key is self-migrated on the first write (`ensureDedupeZset` in
  `lib/redis-maintenance.ts`), and `/admin → Developer → Tidy Redis Schema`
  converts + prunes them on demand.

**Live states** are seeded lazily by `getLiveProductState()`, eagerly by
`/api/admin/seed` (Seed Defaults), and repaired by the admin **Site Self-Test**.
The storefront falls back to `totalInventory` when a live state is missing.

**Migrating older data**: `/admin → Developer → Tidy Redis Schema` losslessly
renames any legacy-prefix keys (drop_pool:*, intent_pool:*, session:*, live_state,
stats:*, config:promos, …) to the tidy schema via RENAMENX (atomic, TTL-preserving,
never overwrites), then FOLDS the v2 high-churn string keys into their single
hashes (`ops:override:*` → `ops:overrides`, `store:cart:*` → `store:carts`,
`entries:last_auto:*` → `entries:last_auto`, `analytics:ticks:*` →
`analytics:ticks`, `admin:verify_attempts:*`/`admin:send_attempts:*` → the
`admin:verify:<email>` payload), then runs a **maintenance sweep**
(`lib/redis-maintenance.ts` → `maintainDedupeStructures()` +
`sweepOrphanedProductState()`): converts legacy SET-shaped dedupe keys to the
bounded zsets, prunes expired dedupe members, and removes per-product/per-user
state (`entries:stats`, `entries:last_auto`, `ops:overrides#product:<id>`,
`ops:live_state`, `store:carts`, empty/orphan pool keys) whose product or user
no longer exists. It is safe to re-run — run it a few times a year to keep a
busy store's key space small. The admin **Site Self-Test** includes a "Redis
schema tidy" check that flags any legacy prefixes that are still present, and a
"Dedupe sets bounded" check that reports the dedupe cardinalities + flags
legacy SET-shaped data.

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
- **Edge caching (the Fast Origin Transfer fix).** Public GET routes return an
  explicit `Cache-Control` (+ `CDN-Cache-Control` via the shared
  `lib/cache-headers.ts` → `edgeCacheHeaders()`, so **Vercel** honors
  `s-maxage`, **Netlify** honors `CDN-Cache-Control`, and **Cloudflare** honors
  both) so every platform's edge serves the body after ONE origin render
  instead of streaming it on every request: `/api/store`
  (`public, s-maxage=10, stale-while-revalidate=30`), `/api/catalog/status`
  (`s-maxage=15`), `/api/config/public` (`s-maxage=30`), `/og` (`max-age=3600,
  s-maxage=86400`), `/icon` (`max-age=86400, s-maxage=86400`). Never set
  `max-age` on the JSON routes — browsers should always revalidate (the
  `CDN-Cache-Control` copy only affects the CDN layer, never browsers).
- **Base64 data-URL media is NEVER shipped in public payloads anymore.** Product
  images/videos + the brand logo are stored in Redis as base64 data URLs;
  `lib/media.ts` (`publicMediaRef` / `brandLogoRef`) rewrites them into small
  immutable refs (`/media/<productId>/<index>.<ext>?v=<hash>` and
  `/media/logo?v=<hash>`) in `/api/store`, `/api/catalog/status` and the layout
  theme blob. The `app/media/[...parts]` route streams the bytes from Redis with
  `Cache-Control: public, max-age=31536000, immutable`; the `?v=` hash changes
  whenever the admin replaces an asset so stale edge copies are never served.
  This took `/api/store` from ~3MB to ~59KB and removed the 57KB logo base64
  from every SSR HTML page. `public/robots.txt` blocks all crawlers while the
  store is in private testing (remove it to be indexed).

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
  IDs, inventory, winner tiers, images **+ videos** (PNG/JPEG/JPG/SVG/WEBP/GIF/BMP +
  MP4/MOV/MKV/AVI/WEBM), per-photo **crop tool with live desktop/mobile previews**
  (crops stored per-media in the product's `crops` array, parallel to `images`),
  sort order. **Customer-facing copy** — every product can override the five
  customer-facing lines that appear on its page: the urgency/status lines
  (`urgencyInStock`, `urgencySoldOut`, `statusLive`, `statusArchived`) AND the
  **mixed-format ribbon** (`mixedFormatRibbon`, a template shown only when sizes
  mix raffle + instant-buy; `{raffle}`/`{fcfs}` tokens become the size counts).
  Blank = inherit the global Settings → Storefront copy → built-in default.
  **Per-size raffle settings**
  — when multiple sizes run a raffle each size card in Pricing & Sizes carries
  its OWN countdown end (`sizeConfigs[<size>].releaseEndsAt`) and its OWN
  recurring cadence (`sizeConfigs[<size>].customDropSchedule`), so "both raffle"
  sizes can draw on completely different cycles (see `lib/size-configs.ts`, the
  single resolver used by the draw engine, /api/store, /api/catalog/status and
  the product-page countdown). Every size in Pricing & Sizes can be marked as a
  **sampler (trial
  SKU)**; the **Trial sizes & sample credits** panel then configures each sampler
  individually (badge label, "credits toward" full-size target, credit $, min
  order, expiry, code prefix, eligibility, customer-facing note) with
  product-level defaults as fallback. **Every size can also carry its own
  checkout mode** (Auto / RAFFLE / FCFS), so one product can mix formats — e.g.
  a sampler sells instantly while the full size runs a raffle
  (`lib/checkout-mode.ts` is the single resolver used by the storefront,
  checkout routes and draw engine; FCFS sizes are never drawn). The editor
  surfaces this clearly: FCFS sizes show "sells instantly — never drawn" notes
  (no winners field, no raffle timer), each size card carries a live
  RAFFLE/instant-buy summary line, the at-a-glance strip shows a MIXED pill, and
  renaming a size re-keys its per-size stock, raffle config and sampler records.
- **Settings → Theme Colors / Design Presets** — colors, fonts, radius,
  transparency, one-click presets (`lib/theme-presets.ts`).
- **Settings → Orb Glow** — enable/disable, per-orb color/opacity/size, motion.
- **Settings → Hero Content / Entry Form / Footer / Storefront copy** — copy overrides
  (including the product-page urgency/status lines: `urgencyInStock`,
  `urgencySoldOut`, `statusLive`, `statusArchived`, and the mixed-format ribbon
  template `mixedFormatRibbon` with `{raffle}`/`{fcfs}` count tokens).
  Hero + prose fields are **textareas** (type Enter for a real line break; the
  storefront renders them with `white-space: pre-line`).
- **Settings → Behavior** — **Start at the top when the page opens** (default ON):
  the storefront forces `scrollTo(0,0)` + `history.scrollRestoration = 'manual'`
  on every load so the browser never reopens a long page mid-content. Saved under
  `store:config.behavior` (`lib/redis-keys.ts` key = `store:config`, field
  `behavior.scrollToTopOnLoad`).
- **Settings → Branding & Share** — brand name, logo (upload or URL), header
  mode, logo size, share title/description/tagline/url, share card colors,
  favicon colors.
- **Settings → Rewards & Points** — earn rate, redeem rate, min/max points,
  gifting toggle, gift discount %, **custom redeem info message** (`{giftPercent}` token).
- **Settings → Legal & Policies** — Terms / Privacy / Shipping content
  (`## ` heading, `- ` bullet, blank-line paragraphs, `{companyName}` /
  `{supportEmail}` tokens).
- **Catalog** — upcoming/archive preview groupings. **Product categories** live in `store:config.catalog.categories` and are **EMPTY until the store is seeded** — the seed (`/admin → Developer → Seed Defaults`) writes the starter list into Redis; buyers add/rename/delete freely after that.
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
  `SUPPORT_EMAIL`). middleware.ts (the Edge-runtime middleware — see the
  2026-08-20 changelog entry for the Cloudflare/OpenNext requirements)
  validates a device cookie on EVERY `/api/admin`
  request (30 days when "remember this device" is checked, else 24h), so a
  leaked password alone can't reach the portal or its APIs. Codes are 6 digits,
  expire in 10 min, lock after 5 wrong tries, and resends are throttled to 1/min.
  **The code is in the email SUBJECT line** (`… — Admin sign-in code: 482913`),
  so it shows right in the phone's push-notification preview without opening the
  email (same for customer verify emails). The gate's code field is an OTP
  field (`autocomplete="one-time-code"` + WebKit `textContentType` set via ref)
  so iOS/Android show a one-tap autofill suggestion above the keyboard, and the
  code **auto-verifies the instant all 6 digits are present** (typed, pasted, or
  autofilled) — no extra tap. A "Paste code from clipboard" button covers the
  desktop copy-paste path.
- **Streamer Mode** — default ON on load. Masks every customer email, shipping
  address, card number, tracking number, promo code, order ref, phone number and
  name (fixed-length bullet masks — the real value's character length is never
  visible on stream) and disables the password field (fixed bullet mask — the
  real password length is never visible) so the portal is safe to share on a
  livestream. Free-form audit-log lines are redacted with the same masks
  (`redactDetail`: emails, phone numbers, and any code-like 6+ char token mixing
  letters + digits). Everything destructive still requires turning it OFF first,
  then entering the admin password.
- **Admin security hygiene** — all `/admin` + `/api/admin` requests require
  HTTP Basic Auth in `middleware.ts` (no more password-in-query bypasses), admin
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
- **Due-ness rules** (`evaluatePoolDue`): force → draw; product `isArchived` →
  final draw; a size marked **FCFS** (per-size checkout mode, see
  `lib/checkout-mode.ts`) is NEVER drawn — the runner skips its pool entirely,
  so a mixed-format product's direct-sale sizes can never be raffle-charged. A product with an explicit `releaseEndsAt` uses that as its CYCLE
  boundary — the pool is NEVER drawn before the countdown ends (a cron run or
  unrelated ping must not charge winners early), then draws once the timer hits
  zero. Recurring raffles (a schedule can produce a next draw:
  hourly/daily/weekly/biweekly/monthly/yearly/**custom (every N hours)**) draw
  now and the runner ROLLS the product's `releaseEndsAt` forward to the next
  scheduled moment; one-shot drops (fixed date passed, no next anchor) draw at
  most once after the cycle ends. Products with NO explicit `releaseEndsAt` fall
  back to the global cadence (`shouldRunDraw`). Upcoming products whose
  `goLiveAt` passed are auto-activated (the Redis record is flipped to live) so
  the raffle timer starts counting to `releaseEndsAt`.
- **⚡ Cycle-aware draws — a new entrant can NEVER be charged early (the big
  one).** Entries carry `registeredAt`; the persisted `releaseEndsAt` is the
  cycle boundary. When a cycle ends the engine draws ONLY the entries that were
  registered BEFORE that boundary (`splitEntriesByCycleEnd` in
  `lib/drop-timestamps.ts`). Entries made AFTER the boundary (the storefront
  already shows the NEXT round's "new countdown") are carried over untouched —
  so "I entered after the countdown restarted" can never be charged before the
  timer they saw hits zero. If a stale recurring cycle ends with NO eligible
  entries (e.g. the pool was empty at the boundary, or every entry is from the
  next round), the engine rolls `releaseEndsAt` forward to the next anchor
  WITHOUT drawing. This also fixes the "empty pool at cycle end" case, where the
  product's persisted timer used to stay stale forever and the first entrant got
  instantly drawn.
- **Recurring raffles / the "new raffle" timer.** When a draw completes with
  inventory remaining (and the product is not archived), the engine computes the
  next scheduled draw moment (`getNextRecurringAnchorMs` in
  `lib/storefront-config.ts`, merging static config → `store:config.dropSchedule`
  → `ops:overrides#schedule` → per-product `customDropSchedule` → **per-size
  `sizeConfigs[<size>].customDropSchedule`**) and PERSISTS it as
  the product's new `releaseEndsAt` (or as `sizeConfigs[<size>].releaseEndsAt`
  for sizes with their own config — naive store-time wall clock via
  `formatStoreWallClock` in `lib/drop-timestamps.ts`). The roll-forward advances
  from the LATER of (cycle end, now) so the new timer is always in the future
  (no chasing missed anchors one-by-one). The storefront then shows a countdown
  to the NEW timer instead of "Raffle closed"/"Until sold out". Both
  `/api/store` and `/api/catalog/status` also compute a read-time
  `nextReleaseEndsAt` field per product so the UI shows the new timer even before
  the engine's roll-forward is observed. Unselected entries carry over into the
  next raffle round. The per-product cadence is configured from `/admin → Products
  → Edit → Raffle schedule (recurring)`; the global cadence lives in `/admin →
  Draws → Automation` (mode: fixed/hourly/daily/weekly/biweekly/monthly/yearly/
  custom-with-hours).
- **Triggers:** (1) the client countdown pings `/api/checkout/auto-draw`
  (`lib/client-auto-draw.ts` → `notifyDropDue()`) from the product page, catalog
  and home page the second a countdown hits zero — a drop happens immediately with
  NO cron; (2) the **platform-agnostic scheduled safety net** — Vercel's cron
  (`vercel.json`: `0 0 * * *` → once daily, the Hobby-plan ceiling), Netlify's
  scheduled function (`netlify/functions/cron-tasks.mjs`), Cloudflare's cron
  worker (`cron-worker/`), or ANY external scheduler (cron-job.org, GitHub
  Actions, QStash…) — all hit `/api/checkout/cron-draw` and authenticate via
  `lib/cron-auth.ts` (`x-vercel-cron` header trusted for Vercel;
  `Authorization: Bearer $CRON_SECRET` everywhere else); (3) the
  admin → Draws → Trigger Drop path (unchanged). The product page splits the
  countdown into a DISPLAY anchor (the effective `nextReleaseEndsAt`) and a
  TRIGGER anchor (the raw cycle end) so a recurring raffle shows its new timer
  while still nudging the draw. Because the client trigger fires on EVERY page
  load for an ended-but-un-drawn pool, a drop that happened while nobody watched
  settles the moment the first visitor opens any page.
- **Anti-double-draw:** the runner checks the `entries:last_auto` hash (field =
  `product:size`)
  and skips a pool drawn within the last 90s unless the caller forced it (cron).
  `dryRun=1` simulates the draw without charging/archiving (used by the admin
  self-test and support). The PUBLIC `/api/checkout/auto-draw` is rate-limited
  per IP (see `cache:rate:auto_draw:<ip>` in `lib/redis-keys.ts`); all other
  public write endpoints use the shared `lib/rate-limit.ts`.
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
- ⚠️ **Vercel dashboard placeholders are rejected everywhere.** The URL parser
  accepts `$` inside a hostname, so a `NEXT_PUBLIC_URL` value that contains the
  Vercel env-var placeholder text (`$vercel_project_production_url`, `https://$…`)
  used to silently produce `https://$vercel_project_production_url/og…` — a
  nonexistent domain, which is why link previews never loaded. `getSiteUrl()`,
  `normalizeSiteBase()`, `getRequestSiteUrl()`, `cardSiteUrlDisplay()` and
  `previewSiteUrl()` ALL treat any value containing `$` as unset and fall back
  through the chain (env → request host → example.com). If a shared link shows
  no card, check the Vercel env vars for a `$…` placeholder first.

## Environment Variables (set in your hosting platform — Vercel, Netlify, Cloudflare, anywhere)

> **📄 `/.env.example` is the COMPLETE, copy-paste template** — every variable
> below plus the feature-specific ones, each with a realistic example value and
> a `[REQUIRED]/[RECOMMENDED]/[OPTIONAL]` + `(NECESSARY HERE)/(USE SITE)` note.
> Cloudflare Workers uses `/.dev.vars.example` (local) + the `wrangler.jsonc`
> reference. This table is a summary; when in doubt, `.env.example` is the
> source of truth.

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis (source of truth). REST-protocol pair — any platform works. Aliases: `KV_REST_API_URL`/`KV_REST_API_TOKEN`, `REDIS_REST_URL`/`REDIS_REST_TOKEN`, `REDIS_URL`/`REDIS_TOKEN` (REST-only: `redis://` wire-protocol URLs are skipped in `lib/storage/upstash.ts`). |
| `STORAGE_PROVIDER` (optional) | Data backend selector — default (`upstash`) is Upstash REST Redis (recommended for payments/raffles). Set to `cloudflare-kv` to run on the Workers-KV adapter (`lib/storage/cloudflare-kv.ts`; read the concurrency caveats first). The active provider shows in `/admin → SetUp`. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (optional) | The Setup Wizard's source of truth for `global_platform_settings` (provider keys + the platform configuration gate). Aliases: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Without them the store runs on the legacy env-var providers (Stripe/Resend/Mapbox) exactly as before. |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PRODUCT_ID` (optional) | Global default Stripe price ID when a product/size has none set in admin. Per-product IDs always win. No hardcoded Stripe ID anywhere — if unset, checkout fails loudly with `price_placeholder_not_configured`. |
| `ADMIN_BASIC_AUTH_PASSWORD` | `/admin` protection (Basic Auth + two-step verification). The Basic Auth **username field is the admin email** (`ADMIN_VERIFY_EMAIL` → `SUPPORT_EMAIL` → `REPLY_TO_EMAIL`) — there is no separate `ADMIN_BASIC_AUTH_USERNAME` anymore. |
| `ADMIN_VERIFY_EMAIL` (recommended) | Inbox that receives the `/admin` two-step code — and the email used as the Basic Auth "username". Falls back to `SUPPORT_EMAIL` / `REPLY_TO_EMAIL`. Without one, the admin portal locks behind the code step. |
| `CRON_SECRET` | Safety-net scheduler auth. Every scheduler authenticates with `Authorization: Bearer $CRON_SECRET` (legacy `?key=` / `x-cron-secret` also accepted) — see `lib/cron-auth.ts`. |
| `RESEND_API_KEY` / `RESEND_FROM` (optional) | Transactional email |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox address autofill (must be set in the SAME env as the deploy + redeploy) |
| `NEXT_PUBLIC_URL` / `NEXT_PUBLIC_SITE_URL` / `SITE_URL` | Canonical/OG/email URLs (no hardcoded domain). All three aliases resolve via `lib/env.ts`. When none are set, the platform's system variables are used as a final fallback so a deployed store always tags its REAL domain: Vercel `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL`, Netlify `URL` → `DEPLOY_URL`, Cloudflare Pages `CF_PAGES_URL`. |
| `BRAND_NAME` / `NEXT_PUBLIC_SITE_NAME` (optional) | Email send-from brand |
| `SUPPORT_EMAIL` / `REPLY_TO_EMAIL` (optional) | Support address in emails |
| `LEMONSQUEEZY_API_KEY` / `LEMONSQUEEZY_STORE_ID` / `LEMONSQUEEZY_VARIANT_ID` (optional) | Lemon Squeezy alternative payment provider (API key + numeric store id + checkout variant id). |
| `PADDLE_API_KEY` (optional) | Paddle alternative payment provider. |
| `POSTMARK_API_KEY` / `SENDGRID_API_KEY` (optional) | Alternative email providers (Postmark / SendGrid). |
| `EMAIL_FROM` (optional) | "From" alias — takes priority over `RESEND_FROM` when both are set. |
| `GOOGLE_MAPS_API_KEY` (alias `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) (optional) | Google Maps Places alternative to Mapbox. |
| `DEEPSEEK_API_KEY` (recommended primary) + `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `REPLICATE_API_TOKEN` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `GEMINI_API_KEY` (optional) | Universal AI engine. **The Google Gemini key is `GEMINI_API_KEY`** (the provider enum is `google_gemini`, but there is NO `GOOGLE_GEMINI_API_KEY`). Cloudflare Workers AI needs no key. |
| `CLIENT_LICENSE_KEY` (alias `LICENSE_KEY`) / `LICENSE_SERVER_URL` / `LICENSE_ENFORCED` (optional) | Licensing gatekeeper (enforcement is OFF unless a key/server/`LICENSE_ENFORCED` is set). |
| `MAINTENANCE_MODE` (optional) | `true` shows the maintenance screen. |
| `DEV_WEBHOOK_BYPASS` (**DEV ONLY**) | `1` accepts unsigned webhooks in non-production (for `stripe listen`). Never set in production. |

## Multi-platform deployment (beyond Vercel)

The app is deliberately platform-agnostic: everything talks to Upstash Redis,
Stripe and Resend over plain HTTPS, no platform SDKs are used, and the Next.js
runtime (routes, proxy, `/og`, `/media`) is identical everywhere. Per platform:

- **Vercel** — `vercel.json` wires the daily cron (`0 0 * * *` →
  `/api/checkout/cron-draw`; Vercel signs the request with `x-vercel-cron`,
  trusted by `lib/cron-auth.ts`).
- **Netlify** — `netlify.toml` + `netlify/functions/cron-tasks.mjs` (a
  scheduled function that pings the same endpoints with the bearer
  `CRON_SECRET`). Netlify's Next runtime plugin handles the proxy/routing.
- **Cloudflare** — deploy with the official OpenNext adapter (`@opennextjs/cloudflare`); the repo ships the scaffolding (`open-next.config.ts` + root `wrangler.jsonc`), two convenience scripts — `npm run build:cloudflare` (Mapbox injection + OpenNext build) and `npm run deploy:cf` (build + deploy) — and a full walkthrough in `DEPLOY-CLOUDFLARE.md` (set `NEXT_PUBLIC_*` in the shell BEFORE building — they are build-time; `wrangler deploy` first, then `wrangler secret put` for every runtime secret; `wrangler domains add` for a custom domain; deploy `cron-worker/` last). The daily safety
  net is the separate `cron-worker/` Workers project (`wrangler.jsonc` cron +
  `src/index.mjs` scheduled handler, bearer-auth the same way).
- **Any other host / external scheduler** (cron-job.org, GitHub Actions,
  UptimeRobot, QStash, self-hosted crontab) — point a daily HTTP call at
  `/api/checkout/cron-draw` (+ optionally `/api/cron/recovery` and
  `/api/analytics/social-tick`) with `Authorization: Bearer $CRON_SECRET`.
  **The client-side countdown trigger still fires draws in real time with NO
  cron at all** — the scheduled job is only the server-side safety net.

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
- **2026-08-26 — Setup Wizard unblocked: only the Supabase connection is mandatory (`cloudflare-mandate-removed`):**
  - **🐛 Root cause.** The 2026-08-25 "Cloudflare env vars MANDATE" blocked the Setup Wizard from finalizing in production until 5 secrets (Supabase service-role key, Stripe secret + webhook, Resend, cron secret) were set as Cloudflare env vars — but Stripe/Resend/webhook are ALREADY collected by the wizard and persisted to Supabase `global_platform_settings` (read back by the driver factories at runtime). The mandate was contradictory and locked a normal (non-technical) operator out of setup — the panel said "set these in Cloudflare, not in this wizard" while the wizard had fields for the exact same keys.
  - **🔓 Fix.** Removed the hard `cloudflare_secrets` 422 mandate from `/api/admin/setup` POST, and replaced `cloudflareMandatedSecretChecks()` / `CLOUDFLARE_MANDATED_SECRET_IDS` in `lib/env-discovery.ts` with the honest model: the ONLY value that must live in the hosting platform is the **Supabase connection** (URL + anon + service-role key) — enforced by the existing storage probe — because the server needs it on every request to reach the database where every other key is stored. Everything else is typed into the wizard and saved to Supabase (Stripe/Resend/Map/AI) or is an optional fallback (admin Basic-Auth password, admin verify email, cron secret).
  - **🧭 The wizard panel is now stupid-proof.** `lib/env-discovery.ts` gained `CLOUDFLARE_REQUIRED_IDS` (`supabase-url`/`supabase-anon`/`supabase-service`) + `cloudflareRequiredChecks()`, and `CLOUDFLARE_WIZARD_SAVED_IDS` (`stripe-secret`/`stripe-webhook`/`resend`) + `cloudflareWizardSavedChecks()`. `/api/admin/setup` GET now returns `required`/`savedByWizard` per cloudflare item (was `mandated`), and the `/admin/setup` panel renders three clear buckets — **🔒 Required in Cloudflare** (the 3 Supabase values), **✓ Saved by this wizard** (Stripe + email), and **Optional** (admin password / verify email / cron secret) — each with plain-English copy. The security-step fields (admin Basic-Auth password, verify email, cron secret) are now marked `optional` with hints explaining they must ALSO be set in Cloudflare to take effect (the master admin account + live countdown trigger cover the store without them). The admin SetUp tab's "Cloudflare Environment Variables" card was retitled "Cloudflare Variables & Secrets" and its copy fixed to no longer claim every value must be in Cloudflare.
  - **🧪 Verified:** `npm test` **256/256** (rewrote the 2 mandate tests into 3 for `cloudflareRequiredChecks`/`cloudflareWizardSavedChecks`/id-subset), `tsc --noEmit` clean, `eslint` 0/0 on every touched file. No Redis keys added or changed.

- **2026-08-25 — Cloudflare env vars in the SetUp tab + Setup Wizard MANDATE (`cloudflare-env-vars-mandate`):**
  - **☁️ The admin → SetUp tab now has a dedicated "Cloudflare Environment Variables" card.** `lib/env-discovery.ts` gained a `cloudflareEnvVar` flag on `EnvCheck` and two new helpers — `cloudflareEnvVarChecks()` (the 9 necessary server-side runtime values: Supabase URL / anon / service-role, admin password / verify-email, Stripe secret + webhook, Resend, cron secret) and `cloudflareMandatedSecretChecks()` (the 5 server-only secrets that must NEVER be typed into the wizard: Supabase service-role key, Stripe secret, Stripe webhook secret, Resend API key, cron secret). `/api/admin/env-status` now returns a `cloudflare` array, and the SetUp tab renders it as a prominent card with ✓/✗ status, example values, the exact Cloudflare location, and copyable `npx wrangler secret put` commands.
  - **🔒 The Setup Wizard now MANDATES these secrets as environment variables.** `app/admin/setup/page.tsx` renders a "Cloudflare environment variables (mandatory)" panel (✓/✗ + copy commands + a `MANDATORY` badge per secret), and `/api/admin/setup` POST refuses to finalize in production until the 5 mandated secrets are present in `process.env` (returning `422` with `stage: 'cloudflare_secrets'` + the exact `wrangler secret put` commands). Development still allows an inline bootstrap (warns only). The Supabase anon key + admin Basic-Auth password are deliberately NOT mandated (anon is public; the master admin is the Basic-Auth alternative). No Redis keys added or changed.
  - **🧪 Tests:** `tests/env-discovery.test.ts` +3 cases (cloudflare env-var list, mandated-secret subset, mandated ⊆ secret subset). `npm test` **255/255**, `tsc --noEmit` clean, `eslint` 0/0 on touched files, `npm run build` compiles every route + the Proxy middleware.

- **2026-08-24 — SetUp env-status panel: example values + Cloudflare "where to set" + 4 missing env checks (`env-status-example-where`):**
  - **🧭 The admin → SetUp → Environment Variables panel now tells an operator EXACTLY how to wire up each variable.** `lib/env-discovery.ts`'s `EnvCheck` gained a `variable` field (primary name + aliases), an `example` field (a realistic placeholder value, NEVER a real key), and a `where` field (the exact Cloudflare location). A new `EXAMPLES` map holds realistic placeholders for all 46 checks, and a new `cloudflareLocation()` helper derives the location from the value's shape: Cloudflare bindings → "add the wrangler.jsonc block", build-time `NEXT_PUBLIC_*` → "set it in your build shell before `npm run build:cloudflare` (CANNOT be set in the dashboard)", secrets → "dashboard → Variables and Secrets → Secrets / `npx wrangler secret put`", plaintext vars → "dashboard → Variables / the `vars` block in wrangler.jsonc".
  - **➕ Four missing checks added to the registry.** `google-maps` (`GOOGLE_MAPS_API_KEY` / `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — the alternative maps provider), `license-enforced` (`LICENSE_ENFORCED`), `maintenance-mode` (`MAINTENANCE_MODE`), and `dev-webhook-bypass` (`DEV_WEBHOOK_BYPASS` — dev-only). A new **Operations** group (maintenance + local-dev-only toggles) was added to the group list.
  - **🔧 `app/api/admin/env-status/route.ts` simplified** to map the discovery registry directly (single source of truth — the SetUp tab can no longer drift from middleware.ts / the Setup Wizard). Each returned item now carries `variable` / `aliases` / `example` / `where` / `commands` alongside the existing presence + kind metadata. Values are STILL never returned — presence booleans + metadata only.
  - **🎨 `app/admin/page.tsx` renders the new fields** — every missing variable shows a yellow "NOT SET YET" block with its `Example:` value, `Where:` location, and a copyable `Run:` command; set variables show their primary variable name + aliases. Fixed an unescaped-apostrophe lint error in the intro copy.
  - **🧪 Verified:** `npm run typecheck` clean, `eslint` 0/0 on the three touched files, `npm test` **252/252**, `npm run build` compiles every route + the Proxy middleware. No Redis keys added or changed.

- **2026-08-23 — COMPLETE environment-variable reference with prefilled examples (`.env.example` + Cloudflare fixes) (`env-example-complete`):**
  - **📄 Created `/.env.example`** — a single, COMPLETE, copy-paste template for Vercel, Netlify, Node hosts and local dev. Every variable the app reads is present, organized into 11 sections, with a REALISTIC example value and a `[REQUIRED]/[RECOMMENDED]/[OPTIONAL]` + `(NECESSARY HERE)/(USE SITE)/(BUILD-TIME)` annotation per line. This was previously MISSING entirely (only the Cloudflare-specific `.dev.vars.example` existed), which is why buyers on Vercel/Netlify/Node had nothing to copy from.
  - **🐛 FIXED the Gemini env-var name.** The code reads `GEMINI_API_KEY` (`services/ai/factory.ts` → `process.env.GEMINI_API_KEY`), but `.dev.vars.example` and `wrangler.jsonc` both documented a nonexistent `GOOGLE_GEMINI_API_KEY` — so Gemini could never be wired up from the docs. Both now say `GEMINI_API_KEY` (with an explicit "NOT GOOGLE_GEMINI_API_KEY" note). The provider ENUM value `google_gemini` and the Supabase setting key `google_gemini_api_key` are separate and unchanged.
  - **➕ Added the missing vars to every doc** (`.env.example`, `.dev.vars.example`, `wrangler.jsonc`, README, this table): `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `PADDLE_API_KEY`, `POSTMARK_API_KEY`, `SENDGRID_API_KEY`, `EMAIL_FROM` (Resend `from` alias), `GOOGLE_MAPS_API_KEY`/`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, the full AI key list (`DEEPSEEK/OPENAI/ANTHROPIC/REPLICATE/OPENROUTER/GROQ/MISTRAL/GEMINI`), the licensing vars (`CLIENT_LICENSE_KEY`/`LICENSE_KEY`/`LICENSE_SERVER_URL`/`LICENSE_ENFORCED`), `MAINTENANCE_MODE`, and `DEV_WEBHOOK_BYPASS` (dev-only), plus the Redis/Supabase alias keys.
  - **🔓 `.gitignore` now allows `!.env.example`** (and `!.env.local.example`) so the template can actually be committed — previously the blanket `.env*` rule would have silently ignored it.
  - **🧪 Verified:** `wrangler.jsonc` re-parses as valid JSONC; `.env.example` has no leftover markers; `git check-ignore .env.example` reports not-ignored. No Redis keys or runtime code changed (docs/config only).
- **2026-08-22 — Setup wizard reconfigure "Sign in first" deadlock FIXED + `.dev.vars.example` examples (`setup-signin-first-fix`):**
  - **🐛 Root cause of the "Sign in first" failure at the end of the wizard.** Once the platform was `is_configured = true`, `middleware.ts` blocked `POST /api/admin/setup` with a plain-text `401` (Basic-Auth challenge) *before* the route ran — because `ADMIN_BASIC_AUTH_PASSWORD` was unset and there was no super-admin device cookie. The browser popped the native Basic-Auth dialog, the client got a 401 with NO JSON `error` (so it showed the generic "Sign in first" fallback), and the route's smarter reconfigure guard — which also accepts the **Supabase service-role key** as proof of ownership — never got a chance to run.
  - **🔧 Fixes.**
    - `middleware.ts`: added `isSetupApi` and exempted `/api/admin/setup` (GET **and** POST) from the Basic-Auth + 2FA gates, delegating auth entirely to the route's own guard (Basic Auth password, super-admin session, **or** the Supabase service-role key — see `verifyServiceRoleAccess()`). The route re-checks everything, so no write path is ever unauthenticated.
    - `app/api/admin/setup/route.ts`: `basicAuthOk` now accepts the `admin_basic_auth_password` form field OR the master admin password, and the 403 message is now actionable (sign in as master admin / set `ADMIN_BASIC_AUTH_PASSWORD` / set the Supabase env vars so the service-role key authorizes the save).
    - `app/admin/setup/page.tsx`: `submit()` now **auto-signs-in and retries once** when the save returns 401/403 — it calls the master-account sign-in with the credentials already typed, then re-posts the save, so "enter email + password + Save" just works without hunting for the separate "Sign in" button.
  - **📖 `.dev.vars.example` rewritten** — every variable now carries a **realistic example value** (e.g. `SUPABASE_URL=https://abcdefghijklm.supabase.co`, `STRIPE_SECRET_KEY=sk_live_51AbCdEf...`) plus a per-entry **`(NECESSARY HERE)` / `(USE SITE)`** annotation and a plain-English purpose note, with a "WHERE each value lives" legend at the top (mirrors `wrangler.jsonc`).
  - **🧪 Verified:** `tsc --noEmit` clean, `eslint` 0/0 on the touched files, `npm test` **252/252**, `npm run build` compiles every route + the Proxy middleware. No Redis keys added or changed.

  - **🧭 The "Data store connection failed" fix is now fully stupid-proof.** New shared module **`lib/setup-schema-guide.ts`** (pure, imported by both `/api/admin/setup` and `/admin/setup` so they can never drift) embeds the VERBATIM SQL of all four migrations and exposes `isSchemaError()` + `buildSchemaFixPlan()` + `schemaFixPlanToText()`. The wizard now renders a rich `SchemaFixCard` (yellow for the GET "schema not applied" banner, red for the POST failure) with an explicit 9-step click-path (dashboard → project → SQL Editor → New query → Copy SQL → paste → Run → verify → Continue), a per-file **"Copy SQL"** button (1-click copies the exact migration — no repo hunting), a scrollable `<pre>` of the raw SQL, a "what success looks like" note, and the `supabase db push` shortcut. The route returns a structured `schemaError` (replacing the old terse 4-line string), so the UI can detect the exact gap (`ai_provider_secondary` → run only `00004`; table missing → run all four in order).
  - **🔤 Every setup placeholder is now accurate and context-aware.** `supabase_url` → `https://abcdefghijklm.supabase.co`; anon + service-role keys → a JWT `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…`; Upstash URL → `https://eu1-brave-falcon-12345.upstash.io` + token `AX3rASFh…`; Stripe → `sk_live_51…` / `whsec_…` / `price_1ABC…`; Lemon Squeezy → `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.…`; Paddle → `pdl_live_AbCdEf…`; Resend → `re_AbCdEf123456…`; Postmark → a 36-char UUID; SendGrid → `SG.AbCdEf123456…`; Mapbox → `pk.eyJ1Ijoi…`; Google Maps/Gemini → `AIzaSy…`; OpenAI → `sk-proj-…`; Mistral → `AbCdEfGh…`; plus brand/site-url/support-email/admin-email/cron-secret examples. Hints now name the key prefix (e.g. "starts with `sk_live_`").
  - **🧪 Tests:** new `tests/setup-schema-guide.test.ts` (4 cases) — including a **byte-for-byte assertion** that the embedded SQL constants match `supabase/migrations/*.sql`, so a migration edit can never silently drift from what the wizard tells an operator to paste. `npm test` **252/252**, `tsc --noEmit` clean, `eslint` 0/0 on touched files, `npm run build` compiles (`/admin/setup` + `/api/admin/setup` included). No Redis keys added or changed.

- **2026-08-22 — "Stupid easy" setup: fixed broken `00003` migration, Supabase-first Cloudflare guide, plain-English schema-fix steps (`stupid-easy-setup`):**
  - **🐛 Fixed a broken SQL statement in `supabase/migrations/00003_tenant_routing.sql`.** The `system_locks` table's `create table` was split in half — its `created_at`/`updated_at` columns and closing `)` had drifted to the bottom of the file (after the SECURITY DEFINER functions + RLS policies), so running the migration failed with a syntax error and blocked any fresh install. The columns + `);` are now inline with the rest of the table; the orphaned trailing lines were removed.
  - **📖 `DEPLOY-CLOUDFLARE.md` is now Supabase-first.** The old guide listed Upstash Redis as "REQUIRED — without these nothing works", which contradicted the Supabase-default storage engine. Step 3 now leads with a **"Where each value lives"** table explaining the THREE places values live on Cloudflare (plaintext `vars` auto-created from `wrangler.jsonc`, secrets via `npx wrangler secret put`, and build-time `NEXT_PUBLIC_*` in the shell), then gives the full secrets list (Supabase first, Stripe, cron/email, optional Upstash/Stripe-product) and a new **"Apply the Supabase schema"** section. Prerequisites now point at a Supabase project instead of Upstash.
  - **☁️ `wrangler.jsonc` `[vars]` gained `RESEND_FROM` + `LICENSE_ENFORCED`** (both plaintext-safe), and the header now states plainly that only the plaintext `vars` appear in the dashboard automatically — secrets never appear until added via `wrangler secret put`.
  - **🧭 Schema errors are now plain-English, numbered steps.** `app/api/admin/setup/route.ts` replaces the raw-PostgREST `SCHEMA_HINT` append with `schemaFixSteps()` — it detects the specific gap (e.g. `ai_provider_secondary does not exist` → run only `00004_ai_secondary.sql`) and returns a 4-step click-path (Supabase dashboard → SQL Editor → New query → paste file → Run → Continue). `isSchemaError` now also matches Postgres codes `42703`/`42P01`/`42704`. The wizard's `STAGE_CONTEXT.storage_init` message is now a short summary, the **"Supabase schema not applied yet"** banner shows the same numbered steps, and the error block renders `white-space: pre-line` so the steps line up.
  - **🧪 Verified:** `tsc --noEmit` clean, `eslint` 0/0 on touched files, `npm test` passing, `npm run build` compiles. No Redis keys added or changed.


- **2026-08-22 — `wrangler.jsonc` env reference: realistic example values + `(NECESSARY HERE)`/`(USE SITE)` annotations (`wrangler-env-examples-annotations`):**
  - **🧭 Every entry in the "Runtime variables and secrets" reference now shows a REALISTIC EXAMPLE VALUE** (filled in the remaining bare `…` placeholders: `PADDLE_API_KEY` → `pdl_live_AbCdEf…`, `POSTMARK_API_KEY` → `9f4a2c1e…`, `MISTRAL_API_KEY` → `AbCdEfGh…`, `OPENAI_API_KEY` → `sk-proj-…`, `UPSTASH_REDIS_REST_TOKEN` → `AX3rASFh…`) so an operator can see exactly what to paste into the value field.
  - **📍 Each entry is now annotated `(NECESSARY HERE)` or `(USE SITE)`** so the operator knows WHERE to set it. `(NECESSARY HERE)` = set in THIS file / the Cloudflare dashboard / build shell — the server reads it from the environment directly (storage backend, admin email + password, cron, license, maintenance, build-time `NEXT_PUBLIC_*`). `(USE SITE)` = set on the site instead (admin portal or the `/admin/setup` wizard — brand name, support email, Stripe/Resend/Mapbox/AI provider keys). A new "WHERE to set each value" legend block at the top documents the two annotations.
  - **🧪 Verified:** `wrangler.jsonc` re-parsed as valid JSONC (comment-stripped `JSON.parse` passes). No code or Redis keys changed.

- **2026-08-22 — Admin-email login (no more username), full env-var reference in `wrangler.jsonc`, per-step API verification in the Setup Wizard, production finalization (`email-auth-wizard-probes-env-reference`):**
  - **📧 Admin now signs in by EMAIL — the `username` concept is gone.** `ADMIN_BASIC_AUTH_USERNAME` was removed everywhere (`middleware.ts`, `lib/server-config.ts` `adminRequestAuthorized`, `/api/admin/draw-history`, `services/config/types.ts` `OperationalSettings`/`OPERATIONAL_SETTING_KEYS`, `lib/env-discovery.ts` `admin-username` check, `lib/lockdown.ts`, `/api/admin/{env-status,self-test,status}`, `wrangler.jsonc`, `.dev.vars.example`, README, DEPLOY-CLOUDFLARE.md). The HTTP Basic Auth "username" field is now the **admin email** (`ADMIN_VERIFY_EMAIL` → `SUPPORT_EMAIL` → `REPLY_TO_EMAIL`), compared constant-time; when no email is configured the email check is skipped (the password is the secret). New `resolveAdminEmail()` in `middleware.ts` mirrors the existing `getAdminVerifyEmail()`.
  - **🔍 Setup Wizard now verifies EVERY provider against its real API and BLOCKS advancing on failure.** New `probe: 'core'` (payment/email/maps) and `probe: 'ai'` modes in `/api/admin/setup` with real `fetch` checks (Stripe `/v1/balance`, Resend `/domains`, Postmark `/server`, SendGrid `/scopes`, Mapbox/Google key format, DeepSeek/OpenAI/Anthropic/Replicate/OpenRouter/Groq/Mistral/Gemini models/balance endpoints, Lemon Squeezy/Paddle auth). The wizard's Continue on **Core services** (step 3) and **AI engine** (step 5) now probes before advancing and surfaces the exact error via new `STAGE_CONTEXT` entries (`core_services`, `ai`). The data-store step (Supabase schema + Upstash ping) already blocked — now every API-touching step does.
  - **☁️ `wrangler.jsonc` now lists EVERY env var** under "Runtime variables and secrets", each annotated `[REQUIRED]`/`[RECOMMENDED]`/`[OPTIONAL]` + `[SETUP WIZARD step N]` + a realistic example value — plaintext vars in `[vars]` (`STORAGE_PROVIDER`, `ADMIN_VERIFY_EMAIL`, `BRAND_NAME`, `SUPPORT_EMAIL`, `MAINTENANCE_MODE`) and the full SECRETS + BUILD-TIME reference as a comment block.
  - **🧪 Verified:** `tsc --noEmit` clean, `eslint` 0/0, `npm test` **248/248**, `npm run build` compiles every route + middleware (EXIT 0). No Redis keys added or changed.

- **2026-08-22 — Setup Wizard fixes: early data-store probe, schema hint covers AI-secondary migration, single DeepSeek key, drop username + "super-admin" copy (`setup-wizard-ux-fixes`):**
  - **🗄 Schema-missing error now points at the FULL migration set.** The `ai_api_key_secondary` PGRST204 failure was caused by `00004_ai_secondary.sql` never being applied, but the error only said to run `00001_init.sql` + `00002_setup_operational.sql`. `isSchemaError()` in `/api/admin/setup` now matches `PGRST204` / "could not find the '…' column … in the schema cache", and every schema hint (route catch, `STAGE_CONTEXT.storage_init`, the wizard banner) lists all four migrations (`00001`–`00004`).
  - **⚡ Data store is verified the moment you leave step 1.** New `probePlatformSettingsSchema()` (a read-only `select` of every column the wizard writes — throws PGRST204/PGRST205 when the table/columns are missing) + a `probe: 'storage'` POST mode. The wizard's Continue on the data-store step now probes Supabase (and pings Upstash when it is the storefront store) and persists the operational settings BEFORE advancing, so a broken data store is surfaced immediately with the contextual error instead of after every other step is filled in.
  - **🤖 AI step is "chill" by default + one DeepSeek key for Pro & Lite.** The secondary fallback now defaults to **"No fallback"** (with clear "leave this to use a single provider" copy) instead of demanding a second key. `isDeepSeekProvider()` treats `deepseek` / `deepseek_lite` as one keyed provider: `normalizePlatformSettingsInput`, `AiFactory` and the wizard validation all let a DeepSeek secondary reuse the primary DeepSeek key, so switching Pro ↔ Lite never requires re-entering the key.
  - **🧹 No username, just email; "admin" everywhere.** The `Admin Basic Auth username` field is gone from the wizard (Basic Auth username defaults to `admin`). All user-facing "super-admin" copy (wizard panel, route errors, env-discovery checklist) now reads "admin" / "master admin account". The internal `is_super_admin` Supabase flag is unchanged.
  - **🧪 Tests** — `isDeepSeekProvider` + secondary-key-reuse cases added; `npm test` **248/248**, `tsc --noEmit` clean, `eslint` 0/0 on touched files. No Redis keys added or changed.

- **2026-08-22 — Cloudflare env vars appear by default + storage-first setup wizard (`cloudflare-vars-defaults-storage-first`):**
  - **☁️ `wrangler.jsonc` now ships a `[vars]` block** listing the non-secret runtime variables (`STORAGE_PROVIDER`, `ADMIN_BASIC_AUTH_USERNAME`, `BRAND_NAME`, `SUPPORT_EMAIL`, `MAINTENANCE_MODE`), so the first `wrangler deploy` auto-creates them as editable "Variables" in the Cloudflare dashboard (Workers & Pages → [project] → Settings → Variables and Secrets → Production) — the operator just fills them in, no CLI needed. The file's header comment was expanded into a complete reference: the plaintext `[vars]` flow, the full **SECRETS** list with copy-paste `npx wrangler secret put …` commands (Supabase/Upstash/admin/Stripe/Resend/cron/license/AI), and the **BUILD-TIME** vars (`NEXT_PUBLIC_URL`, `NEXT_PUBLIC_SITE_NAME`, `NEXT_PUBLIC_MAPBOX_TOKEN`) that must be in the shell before `npm run build:cloudflare` (they can NOT be set in the dashboard).
  - **🔑 Setup wizard now tells operators where env vars actually live.** A persistent **"Credentials live as environment variables"** banner on `/admin/setup` explains that the wizard saves a copy of each key but the durable source of truth is the hosting platform, and points at the exact paths — Cloudflare (`status.cloudflareVarsPath`, already returned by `/api/admin/setup`), Vercel (Project → Settings → Environment Variables), and local dev (`.env.local` / `.dev.vars`) — for when a field cannot be persisted through the page.
  - **🗄 The wizard is now STORAGE-FIRST.** Steps were reordered so **1 · Primary data store** comes before **2 · Master admin account** (the master account is created *in* Supabase, so the data store must be configured first). `STEPS`, `validateStep`, the render blocks, the header copy and the doc comment were updated together; `STAGE_CONTEXT` remapped (`storage_init` → step 0, `create_admin` → step 1) so a connection failure or admin-creation failure jumps to the correct step.
  - **🧪 `.dev.vars.example`** gained the 4 additional AI provider keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_GEMINI_API_KEY`) so the local template matches the full AI provider catalog. Verified: `tsc --noEmit` clean, `eslint` 0/0 on the touched files, `npm test` **246/246**. No Redis keys added or changed.
- **2026-08-22 — Fix setup reconfiguration deadlock when Supabase credentials are inline-only (`setup-reconfigure-deadlock-fix`):**
  - **🐛 Root cause.** The Setup Wizard lets operators paste Supabase credentials INLINE (as a `globalThis` runtime override) when the env vars aren't set, but that override is **volatile — lost on every cold start / serverless instance**. `is_configured` is persisted durably in Supabase, so after a restart the platform is "configured" while `supabaseConfigured()` is false. Result: `/api/admin/super-login` returned **503 "Supabase is not configured"** (can't verify the super-admin without durable creds), while `/api/admin/setup` POST returned **403 "The platform is already configured"** (reconfigure guard required Basic Auth or a super-admin session — neither available). The operator was permanently locked out with no actionable path.
  - **🔑 Fix — the reconfigure guard now accepts proof of the service-role key.** New `verifyServiceRoleAccess()` in `services/config/supabase-client.ts` does an authenticated read of `global_platform_settings` with the CURRENT service-role key and returns true only on success. The Setup Wizard POST treats a valid service-role credential as equivalent to super-admin authorization (it IS the master write credential), so an operator can re-enter their Supabase credentials and save again instead of hitting an unresolvable 403. This is not a privilege escalation — anyone holding the service-role key can already write the settings row via PostgREST directly.
  - **🧭 Actionable errors + warning.** `super-login`'s 503 now tells the operator to set `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` as env vars (inline creds only last for the current session). The setup POST success response now returns a `warning` field when Supabase creds are inline-only, and the wizard renders a persistent **"⚠ Credentials not persisted"** banner telling the operator to persist them as environment variables (and redeploy) or they'll be locked out again on the next restart/deploy.
  - **🧪 Tests.** `tests/supabase-env.test.ts` +2 cases (`verifyServiceRoleAccess` returns false when unconfigured; true on an authenticated read / false on 401). `npm test` **246/246**, `tsc --noEmit` clean, `eslint` 0/0. No Redis keys added or changed.
- **2026-08-21 — Fix setup-wizard reconfigure lockout (403 "already configured" + 401 on `/api/admin/setup`) (`setup-reconfigure-fix`):**
  - **🐛 Root cause.** Once the Setup Wizard had run (`is_configured = true`), the reconfigure page (`/admin/setup?reconfigure=1`) could not detect its own state: `GET /api/admin/setup` was behind the middleware Basic-Auth gate (401), so the page's `load()` silently failed, `configured` stayed false, and the **"Reconfigure — sign in as super-admin"** panel never rendered. The operator then submitted the full form, and the POST route's reconfigure guard correctly rejected it with **403 "The platform is already configured…"** — but with no sign-in UI on screen, that was a dead end.
  - **🔧 Fixes.**
    - `middleware.ts`: added `isSetupRead` (a setup-path **GET**) and exempted it from the "admin not configured" 401, the Basic-Auth 401 and the 2FA device-cookie gate — so the wizard's **read-only status probe** stays reachable after configuration while **POST stays fully gated**.
    - `app/api/admin/setup/route.ts`: the GET now returns a **minimal `{ configured: true, ready: true, signedIn: false }`** for unauthenticated callers once configured (no provider names, env presence booleans, or schema-error text leak), and the full payload only for Basic-Auth / super-admin sessions.
    - `app/admin/setup/page.tsx`: the reconfigure sign-in panel now renders whenever `configured || reconfigure` (not just `configured`); `submit()` surfaces a clear "sign in first" message on 401/403 and forces the panel visible; `superLogin()` re-fetches status after a successful sign-in so `ready`/`configured` refresh.
  - **🧪 Verified:** `tsc --noEmit` clean, `eslint` 0/0, `npm test` **244/244**, `npm run build` compiles every route + the Proxy middleware. No Redis keys added or changed.
- **2026-08-21 — Supabase production hardening: storage adapter now honors wizard creds + requires service-role key (`supabase-storage-hardening`):**
  - **🔑 `lib/storage/supabase.ts` no longer reads `process.env` directly.** The adapter's `readSupabaseStorageEnv()` now resolves credentials through the shared **`readSupabaseEnv()`** (`services/config/supabase-client.ts`), so the SAME env aliases (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`) AND the Setup Wizard's inline runtime override (`setSupabaseRuntimeCredentials`, stored on `globalThis`) are honored by the actual data-store adapter. Previously a wizard save with INLINE Supabase credentials set the runtime override (which the config/driver layer read) but the STORAGE adapter still looked only at `process.env.SUPABASE_*` — so Supabase storage never activated after an inline bootstrap, and the factory silently fell back to Upstash (or "no store").
  - **🛡 Service-role key is now REQUIRED for storage (no more anon fallback).** `public.store_kv` has ROW LEVEL SECURITY enabled with no anon/authenticated policy, so the anon key can neither read nor write it — an anon-only project previously produced a **silently empty KV** (every `hgetall`/`lrange`/`smembers` returned nothing, every write 401'd). The adapter now resolves ONLY `SUPABASE_SERVICE_ROLE_KEY` (which bypasses RLS); a project without it is treated as "not configured" and the factory falls back to Upstash. This matches the admin readiness gate (`detectStorageDrivers` already requires all three keys).
  - **🐛 Write errors now surface instead of vanishing.** `SupabaseKvStore.put()` / `.delete()` previously ignored `res.ok`, so a failed PostgREST write (bad key, RLS, missing schema/table) silently "succeeded" from the caller's perspective (admin saves, seed, wipe). They now throw a descriptive error on non-2xx — read paths (`get`/`list`) stay fail-open, and `del()`/`mutate()` in `cloudflare-kv.ts` still swallow delete errors in the fail-open paths, so rate limiting and cleanup never break legit flows.
  - **🧹 Repo hygiene.** Removed the **tracked machine-specific `supabase/.temp/`** CLI state (project-ref, pooler-url, linked-project.json, version stamps) from git and added `supabase/.temp/` to `.gitignore`; deleted the **empty auto-generated draft migration** `20260821220055_new-migration.sql` (0 bytes) so the timeline contains only the four real migrations.
  - **🧪 Tests.** New `tests/supabase-env.test.ts` (4 cases): `readSupabaseEnv` honors the `NEXT_PUBLIC_*` aliases, the inline runtime override wins over `process.env`, `supabaseServiceConfigured` requires the service-role key, and `supabaseServiceConfiguredFromEnv` correctly ignores the override. `npm test` **244/244**, `tsc --noEmit` clean, `eslint` 0/0, `npm run build` compiles. No Redis keys added or changed.

- **2026-08-21 — Mandatory AI engine + primary/secondary providers + Supabase setup persistence fix (`ai-mandatory-primary-secondary`):**
  - **🤖 AI is now MANDATORY (primary) with an OPTIONAL secondary fallback.** `PlatformSettingsInput.ai_provider` became `AiProvider` (non-null) and `normalizePlatformSettingsInput` REJECTS a missing/blank/`'none'` primary instead of silently skipping (the wizard's "Skip AI for now" option is gone). A new **secondary** pair (`ai_provider_secondary` / `ai_api_key_secondary`) is optional: when set, its key is required (Workers AI excepted); blank/`'none'` = no fallback. `AiFactory.getDriver()` now resolves the primary (wizard → env → Workers AI binding), then the secondary, and returns a new **`FallbackAiDriver`** composite that tries the primary `complete()` first and transparently fails over to the secondary on error.
  - **➕ New AI providers.** `AiProvider` grew `deepseek_lite` (default SECONDARY), `openrouter`, `groq`, `mistral`, `google_gemini` (10 total). New `OpenAiCompatibleDriver` (shared OpenAI-compatible class for DeepSeek Lite / OpenRouter / Groq / Mistral) + `GoogleGeminiDriver` (key-as-query-param). `AI_DRIVER_CATALOG` + the wizard dropdowns + `lib/env-discovery.ts` AI checks + `OPERATIONAL_SETTING_KEYS` (`openrouter_api_key`/`groq_api_key`/`mistral_api_key`/`google_gemini_api_key`) all updated. Defaults: **primary = DeepSeek Pro (`deepseek`, model `deepseek-chat`), secondary = DeepSeek Lite (`deepseek_lite`)**.
  - **🗄 Schema.** `00001_init.sql` widens the `ai_provider` check constraint to the 10 providers and adds `ai_provider_secondary` / `ai_api_key_secondary` columns; new **`00004_ai_secondary.sql`** migration drops/re-adds the constraint + adds the secondary columns idempotently for already-migrated installs.
  - **🐛 Supabase "SUPABASE_SERVICE_ROLE_KEY is not configured — cannot persist platform settings" FIXED.** Two real bugs: (1) the wizard's inline-credential override was a module-level `let`, but `supabase-client` is imported with BOTH `./supabase-client` and `./supabase-client.ts` specifiers, so the bundler could split it into two instances — `setSupabaseRuntimeCredentials()` wrote one instance while `upsertPlatformSettingsRow()` read the other. The override now lives on **`globalThis`** (one shared namespace per process). (2) The route cleared the override via `if (supabaseServiceConfigured()) setSupabaseRuntimeCredentials(null)`, but that check read the *override itself*, so a warm-process re-save wiped the only copy of the service-role key. It now uses a new env-only `supabaseServiceConfiguredFromEnv()` so the override is only dropped when the environment can actually take over.
  - **🔑 Wizard auto-signs-in as super-admin after first setup.** The POST now issues an `admin:devices` cookie (`superAdmin: true`) after `markPlatformConfigured()` so "Open admin portal →" lands IN the portal instead of on the Basic-Auth + email-2FA gates (best-effort — falls back to `/admin/setup?reconfigure=1` super-login when no storage backend is reachable).
  - **🧪 Tests + docs** — `tests/ai-drivers.test.ts` (enum/catalog/sanitize updated + OpenRouter/Gemini/Fallback tests), `tests/setup-normalize.test.ts` (AI mandatory + secondary optional). `npm test` **240/240**, `tsc --noEmit` clean, `eslint` 0/0. No Redis keys added or changed.
- **2026-08-21 — Fix `00001_init.sql` migration order + remove empty draft migration (`fix-00001-migration-order`):**
  - **🗄 `store_kv` CREATE TABLE moved BEFORE the RLS section.** `00001_init.sql` previously created `public.store_kv` at the very END of the file, AFTER `alter table public.store_kv enable row level security;` — so applying the migration threw `SQLSTATE 42P01 (relation "public.store_kv" does not exist)`. The `create table` + `store_kv_expires_idx` index now sit with the other table definitions (before the `-- RLS --` block), and the duplicate at the bottom was removed.
  - **🧹 Deleted the empty auto-generated draft migration** `supabase/migrations/20260821215348_new-migration.sql` (0 bytes, untracked), so the timeline only contains the three real migrations (`00001_init`, `00002_setup_operational`, `00003_tenant_routing`).
  - **🧪 Verified order statically:** all 8 `create table` statements (`tenants`, `users`, `profiles`, `global_platform_settings`, `store_kv`, `analytics_events`, `audit_logs`, `outbound_webhooks`) now precede every `alter table … enable row level security` / `create policy` that references them; `00002_setup_operational.sql`'s `alter table public.global_platform_settings add column` runs after `00001` creates it. No `42P01` possible. No Redis keys changed.
- **2026-08-21 — Setup wizard: reliable scroll-to-top on Continue + actionable "schema not applied" error (`setup-scroll-and-schema-error`):**
  - **⬆️ Continue/Back/step-click now reliably scroll to the top.** The old `scrollToTop()` used `window.scrollTo({ top: 0, behavior: 'smooth' })`, which some browsers/embedders silently ignore (and which could race the React step re-render). It now defers one tick (`setTimeout 0`) so the new step's DOM is committed, then scrolls `window` + `document.documentElement` + `document.body` to `0` — every container, no options-object ambiguity. Wired through the existing `handleNext` / `handleBack` / `goToStep` call sites (no new calls needed).
  - **🧭 Supabase "table not found" (PGRST205 / `public.global_platform_settings` missing) is now diagnosed instead of a raw 422.** The `/api/admin/setup` **GET** no longer 500s when `getPlatformSettings`/`isPlatformConfigured` throw (a missing table makes `fetchPlatformSettingsRow` throw through the REST client) — it catches the failure and returns a `supabaseSchemaError` string. The wizard page surfaces it as a yellow **"Supabase schema not applied"** banner telling the operator to run `supabase db push` or paste `00001_init.sql` + `00002_setup_operational.sql` into the SQL editor. The **POST** catch now detects the table-missing error and appends the same migration hint to the error message, and the `storage_init` STAGE_CONTEXT message names the exact migration files. (Root cause of the reported 400/422s: the Supabase project never had the schema applied — PostgREST cannot run DDL from the wizard's service-role key, so the operator must apply the shipped migrations once.)
  - **🧪 Verified:** `tsc --noEmit` clean, `eslint` 0/0 on both touched files, `npm test` **233/233**. No Redis keys added or changed.
- **2026-08-21 — Setup wizard UX cleanup: minimal header, skippable payments, step validation + auto-scroll (`setup-wizard-ux-cleanup`):**
  - **🧹 Environment Health & Scan banner REMOVED.** The `HealthBanner` + `Badge` components, the per-category `badges` strip, the `envKind()` helper, the `Check`/`DiscoveryGroup`/`discovery` type shapes, and the `loadingStatus`/`statusError` states are all gone from `app/admin/setup/page.tsx`. The wizard is now clean/minimal and focused purely on the 5 steps. The `/api/admin/setup` GET still returns `discovery` (harmless, used only by the now-removed banner) — the page simply no longer renders it. `load()` is now a slim status fetch used only for the `ready`/`configured` gate (no error/loading UI).
  - **💳 Payments are now OPTIONAL / skippable.** `PAYMENT_OPTIONS` gains a **"Skip payments for now"** option (empty field set). `PlatformSettingsInput.payment_provider` → `PaymentProvider | null` and `payment_api_key` → `string | null`; `normalizePlatformSettingsInput` treats a missing/blank/`none` payment provider as "skip" and only requires a key when a real provider is chosen (the SQL `payment_provider` column already allowed NULL). The wizard POST maps `payment_provider: 'none'` → `''` so the server accepts it. Submission no longer fails when payment credentials are omitted.
  - **🛡 Step validation before advancing.** New `validateStep()` / `validateAllSteps()` / `handleNext()` in the wizard: clicking **Continue** validates the active step's required fields (step 0 admin email/password when not configured; step 1 the active data-store keys + Supabase keys for non-Supabase backends; step 2 payment/email/maps keys, with payments skippable and keyless maps allowed; steps 3/4 have no required fields). Invalid fields get a red border (`invalidInputStyle`) + inline error message via new `error`/`invalid` props on `Field`/`SecretInput`/`ProviderFields`, and advancement is blocked until corrected. Final submit runs `validateAllSteps()` and jumps to the first incomplete step.
  - **⬆️ Auto-scroll to top on step change.** `scrollToTop()` (smooth) fires on Continue, Back, and any step-indicator click (`goToStep`).
  - **🧪 Tests:** `tests/setup-normalize.test.ts` +2 cases (payments optional; payments still require a key for a real provider). `npm test` **233/233**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file. No new Redis keys; no SQL migration (the `payment_provider` column already permits NULL).
- **2026-08-21 — Setup wizard password toggles + defensive `/api/admin/setup` storage errors (`setup-password-toggle-defensive`):**
  - **👁 Show/Hide toggles on every secret field.** New `SecretInput` + `EyeIcon` components in `app/admin/setup/page.tsx` render a password input with an eye toggle (SVG eye / eye-off, `aria-pressed`, Show/Hide tooltip) so operators can inspect typed/pasted secrets instead of being locked to dot masks. Wired into `ProviderFields` (all `secret: true` fields — Supabase anon/service-role keys, Upstash REST token, Stripe secret + webhook signing secret, Lemon Squeezy/Paddle/Resend/Postmark/SendGrid/Google Maps API keys, AI keys, admin Basic-Auth password, CRON_SECRET) plus both master-admin password fields (step 1 "Password" and the reconfigure "Super-admin password").
  - **🛡 Defensive bootstrap + structured storage errors in `/api/admin/setup`.** The POST handler now tracks a `stage` variable (`storage_init` → `create_admin` → `finalize`) that advances through `savePlatformSettings` / `saveOperationalSettings` / `createSuperAdmin` / `markPlatformConfigured`. On ANY thrown error the catch returns `{ success: false, error: err.message, stage }` with HTTP **422** (was a generic 500 "Check the server logs") — so a Supabase network/auth error, missing table, or bad driver credential surfaces the exact PostgREST message instead of crashing opaquely.
  - **🧭 Contextual error display in the wizard.** The page captures the returned `stage`, maps it via a new `STAGE_CONTEXT` table to the failing step (storage → step 2, admin → step 1, finalize → step 5) with a plain-English "which service/key failed" hint and a "Go to step N" jump button, and renders the exact API error string in a monospace block below it (replacing the generic 'Setup could not be completed.' message).
  - **🧪 Verified:** `npm run typecheck` clean, `npm run lint` 0/0, `npm test` **231/231**. No Redis keys were added or changed.
- **2026-08-21 — Production setup-wizard polish + dynamic provider fields + pause multi-tenant (`setup-wizard-polish`):**
  - **⏸ Multi-tenant / B2B expansion PAUSED.** The Tier 1–4 portal hierarchy (`lib/rbac.ts`), the Lockdown Engine (`lib/lockdown.ts`), the Universal Item Engine (`lib/item-engine/`) and the tenant-routing migration (`supabase/migrations/00003_tenant_routing.sql`) are RETAINED in the repo + this changelog for post-launch phases — no further work on `/a`, `/s`, `/b` or custom-domain routing until production ships. Focus is 100% on the live storefront + setup wizard.
  - **🧭 `/admin/setup` rebuilt as a clean 5-step wizard** (rewrote `app/admin/setup/page.tsx`): **1 · Master admin account** → **2 · Primary data store** → **3 · Essential core services** (payments + webhooks, transactional email, maps) → **4 · System security & site identity** (Basic Auth, CRON_SECRET, brand name, site URL, support email) → **5 · Optional features (AI engine)**. A clickable stepper + Back/Continue navigation, a persistent "Environment Health & Scan" banner + per-category status badges, and plain-English helper text on every field (what it does + exactly where to copy the key).
  - **🔀 Dynamic provider fields.** Each provider now declares its OWN `FieldSpec[]` (env-var name, placeholder, hint, secret flag, optional flag, copy command). Switching Supabase ↔ Upstash ↔ Cloudflare KV (storage), Stripe ↔ Lemon Squeezy ↔ Paddle (payments), Resend ↔ Postmark ↔ SendGrid (email), Mapbox ↔ Google ↔ OpenStreetMap (maps), or the 5 AI providers swaps the rendered inputs, env-var names, placeholders and tooltips — never just a relabeled generic field. Keyless providers (OpenStreetMap, Workers AI, "Skip AI") render a "no key required" note instead of a dead field. Storage no longer shows all three backends at once; picking a non-Supabase primary surfaces a clearly-labeled "Supabase credentials (still required)" panel (the master admin + settings persist through Supabase).
  - **🤖 AI is now genuinely OPTIONAL.** `PlatformSettingsInput.ai_provider` became `AiProvider | null`; `normalizePlatformSettingsInput` treats a missing/blank/`'none'` provider as "skip" (storefront falls back to CSS/SVG presets) instead of erroring. The wizard ships a **"Skip AI for now"** default.
  - **♻️ Save updates the health check in place.** A successful save re-scans `/api/admin/setup` and shows a green "Saved — environment health check refreshed" banner with an "Open admin portal →" button instead of a hard redirect; the reconfigure sign-in shows its own "Signed in" notice.
  - **🐛 Reconfiguration no longer re-creates the master admin.** `/api/admin/setup` POST skips admin email/password validation + `createSuperAdmin` when the platform is already configured (re-creating would 422 on the duplicate email and silently fail the save).
  - **🧪 Tests** — new `tests/setup-normalize.test.ts` (2 cases: AI optional/skip, AI still requires a key for a real provider). `npm test` **231/231**, `tsc --noEmit` clean, `eslint` 0/0, `npm run build` compiles (`/admin/setup` included). No new Redis keys.
- **2026-08-21 — 4-tier RBAC routing core + Universal Item Engine + Lockdown Engine + tenant-isolation RLS (`enterprise-multi-tenant-foundation`):**
  - **🧭 `lib/rbac.ts`** — the 4-tier hierarchy as a pure, edge-safe, `node --test`-loadable module: `PortalRole` (`super_admin`/`sales`/`owner`/`staff`/`customer`), `PortalTier` 1–4, route-prefix classification (`/a` → Tier 1 super-admin, `/s` → Tier 2 sales, `/b` → Tier 3 business owner, everything else / custom domain → Tier 4 customer storefront), `roleTiers()`/`roleCanAccessTier()`/`roleCapabilities()`/`roleHasCapability()` (the RBAC matrix), `canAccessTenant()` (tenant-boundary guard — super-admin unrestricted, sales → assigned tenants only, owner/staff/customer → own tenant, unauthenticated fails closed) and `classifyRequest()` (custom-domain → Tier 4 vs platform-domain prefix routing; subdomains are tenant sites).
  - **🔒 `lib/lockdown.ts`** — the Lockdown Engine: `LOCKED_PARAMETER_KEYS` (storage/admin-auth/payment/cron/license params), the pure `evaluateLock()` decision engine (setup phase → allowed; non-locked key → allowed; a locked key requires `super_admin` + a fresh `stepUpVerified`, otherwise `forbidden`/`requires_step_up`), and a 5-min step-up TTL (`isStepUpFresh` / `lockStateStepUpActive`).
  - **🧩 `lib/item-engine/`** — the Universal Item Engine: schema-driven item types `fcfs` / `raffle` / `appointment` / `table_booking` / `ticketed_access` / `subscription` (`registry.ts`), a minimal dependency-free JSON-Schema validator (`json-schema.ts` — type/properties/required/additionalProperties/items/enum/const/min/max/pattern/anyOf), and `validateRules()`/`normalizeRules()` (`index.ts`). A new business vertical = ONE added JSON Schema, no DB rewrite (`rules` is JSONB).
  - **🗄 `supabase/migrations/00003_tenant_routing.sql`** — idempotent: `tenants.business_type`/`custom_domain` (+unique index), `users.role`/`profiles.role`, the `tenant_items` table (JSONB `rules`, tenant-scoped), the `system_locks` table, SECURITY DEFINER helpers (`current_user_role()`/`current_user_tenant()`/`current_user_is_super_admin()`), and strict RLS (tenant items: super-admin all + owner/staff own tenant; system locks: super-admin-only writes).
  - **🧪 Tests** — new `tests/rbac.test.ts`, `tests/lockdown.test.ts`, `tests/item-engine.test.ts` (28 cases). `npm test` **229/229**, `tsc --noEmit` clean, `eslint` 0/0. **No Redis keys added** (the item engine + locks live in Postgres JSONB, not Redis; no `organize-redis` migration rows needed).
- **2026-08-21 — Unified single-page Setup Dashboard + provider matrix + `/api/auth/me` 500 fix (`setup-dashboard-unified`):**
  - **🛣 Route consolidation.** `/admin/setup-status` (page + `/api/admin/setup-status`) is DEPRECATED — both are now thin redirects to `/admin/setup` / `/api/admin/setup`, and `middleware.ts` adds an edge-runtime redirect for any direct traffic to the old paths. Unconfigured/partially-configured installs now route to `/admin/setup` (the `SETUP_REQUIRED` 423 `redirect` field and the page redirect both point there). The `/admin` path remains intercepted by `computeAdminReady` until at least one storage engine is verified AND one admin method exists (Supabase super-admin or the Basic-Auth password) — unchanged readiness gate, new destination.
  - **🧭 Unified `/admin/setup` dashboard** (rewrote `app/admin/setup/page.tsx`): an "Environment Health & Scan" banner that auto-refreshes on save + a re-scan button; per-category status badges (Store / Auth / Payments / Email / Maps / AI / Security → ✅ Configured / ❌ Action Needed / ⚠️ Optional) derived from `discoverEnvironment()` + `platformProviders`; a **complete data-store matrix** (radio primary for Supabase / Upstash Redis / Cloudflare KV-D1 with simultaneous primary + fallback credential entry); super-admin account; email/payment/map/AI provider selects; and **every operational field** previously missing — security (`ADMIN_BASIC_AUTH_USERNAME/PASSWORD`, `ADMIN_VERIFY_EMAIL`, `CRON_SECRET`), site identity (`NEXT_PUBLIC_URL`, `BRAND_NAME`, `SUPPORT_EMAIL`), Stripe (`STRIPE_SECRET_KEY`/`WEBHOOK_SECRET`/`PRODUCT_ID`) and the AI suite (`DEEPSEEK/OPENAI/ANTHROPIC/REPLICATE` + Workers AI). Every field carries a copyable `npx wrangler secret put VAR_NAME` command + the Cloudflare dashboard path.
  - **💾 Setup backend expanded** (`app/api/admin/setup/route.ts`): GET now returns the full scan (discovery + storage drivers + readiness + providers + `operationalConfigured`) so the dashboard is self-contained; POST normalizes + persists operational settings alongside provider settings, then creates the super-admin, flips `is_configured`, clears the settings cache (runtime driver re-resolution) and redirects to `/admin`.
  - **🗄 Operational settings persistence.** New `services/config/types.ts` `OperationalSettings` + `OPERATIONAL_SETTING_KEYS` + `parseOperationalSettings`/`hasOperationalSettings`; `GlobalPlatformSettings` gains `operational_settings`; `services/config/platform-settings.ts` gains `normalizeOperationalSettingsInput` + `saveOperationalSettings`. New migration `supabase/migrations/00002_setup_operational.sql` adds `global_platform_settings.operational_settings jsonb not null default '{}'::jsonb`. The blob is NEVER returned by `toPublicSummary()`.
  - **🔐 `/api/auth/me` 500 FIXED.** The route previously returned `{ error: 'System error' }` 500 when the data store was unconfigured (and threw unhandled on any storage failure). It is now wrapped in a defensive try/catch and returns a stable `200 { authenticated: false, reason: 'unconfigured_environment', user: null }` when the client is missing/throws — so the React client sees a clean "signed out" state with no callback-stack thrashing.
  - **🧪 Tests + docs** — new `tests/operational-settings.test.ts` (5 cases). `npm test` **201/201**, `tsc --noEmit` clean, `eslint` 0/0, `npm run build` compiles every route + proxy. No Redis keys added (the operational blob lives on the existing `global_platform_settings` row).

- **2026-08-21 — Storage-flexible readiness: no hardcoded Redis, Cloudflare-first setup, inline Supabase bootstrap (`storage-driver-flex`):**
  - **🗄 Upstash Redis is no longer mandatory or the default blocking backend.** New `lib/env-discovery.ts` helpers `detectStorageDrivers(env)` (returns `{ supabase, cloudflare, redis }` — Supabase = URL+anon+service role all present; Cloudflare = `STORAGE_PROVIDER=cloudflare-kv`/`d1` OR an active KV/D1 `globalThis` binding; Redis = a REST-usable URL + token) and `detectStorageProvider(env)` (display name, defaults to `supabase`). `resolveStorageProvider()` in `lib/storage/types.ts` now defaults to `supabase` (its doc + `lib/storage/index.ts`/`upstash.ts`/`lib/server-config.ts` comments updated to drop "Upstash is the default").
  - **🚪 `computeAdminReady` unlocks on ANY driver + ANY admin method.** Signature changed to `{ storage: StorageDriverState, legacyAdminOk, platformConfigured }` — ready when (supabase OR cloudflare OR redis OR `platformConfigured === true`) AND (`platformConfigured === true` OR `legacyAdminOk`). `middleware.ts` + `/api/admin/setup-status` both use `detectStorageDrivers()` so they can't drift. `discoverEnvironment` now computes `blockingMissing` at the GROUP level (`['storage']` / `['admin']`, e.g. `['storage','admin']` on an empty env) instead of per-variable `redis-url`/`redis-token`/`admin-password`; the setup-status headline reads "❌ N blocking item(s) remaining" and flips to "✅ Ready".
  - **☁️ Vercel bias removed from the checklist.** Every `vercel env add …` command is gone from `lib/env-discovery.ts` — copy buttons are now `npx wrangler secret put VAR_NAME` (+ `wrangler.toml` blocks + `CLOUDFLARE_VARS_PATH`). `site-url` purpose reordered Cloudflare-first; the storage group gained `supabase-storage` + `cloudflare-storage` rollup checks and an "any ONE of these" subtitle; `/api/admin/env-status` (SetUp tab) now reports `detectStorageProvider()` and marks the Redis URL/token checks `required: false` (optional).
  - **🧙 Inline Supabase entry in the Setup Wizard.** `services/config/supabase-client.ts` gains `setSupabaseRuntimeCredentials()` (module-level override consulted by `readSupabaseEnv()` so every REST/Auth call uses wizard-entered creds). `/api/admin/setup` POST accepts `supabaseUrl`/`supabaseAnonKey`/`supabaseServiceRoleKey`; when the env is missing it sets the override, then saves `global_platform_settings` + creates the super-admin + flips `is_configured` — unlocking `/admin` immediately (same warm instance). The wizard page's "Saving now will fail" hard block is replaced with inline fields in **Step 2 · Data store** and the submit is never blocked by missing env.
  - **🧪 Tests + docs** — `tests/env-discovery.test.ts` rewritten for the group-level blocking model + `detectStorageDrivers`/`detectStorageProvider` cases; `tests/storage-provider.test.ts` updated (default now `supabase`). `npm test` **196/196**, `tsc --noEmit` clean, `eslint` 0/0, `npm run build` compiles (all routes + Proxy). No new Redis keys.
- **2026-08-21 — Multi-tenant B2B SaaS foundation (Supabase primary store, licensing gatekeeper, universal AI engine, analytics/webhooks/maintenance) (`saas-platform-foundation`):**
  - **🗄 Supabase is now the DEFAULT primary data store.** New `lib/storage/supabase.ts` implements the full `StorageClient` contract on a PostgREST `store_kv` table (reuses the envelope encoding from `CloudflareKvStorageClient`). `StorageProvider` gains `'supabase'`, and `resolveStorageProvider()` prefers Supabase when `SUPABASE_URL` + a key are present, then falls back to Upstash Redis (explicit `STORAGE_PROVIDER` still wins; `cloudflare-kv`/`d1` accepted for the D1/KV adapter). New `supabase/migrations/00001_init.sql` (storefront root) defines `tenants`, `users`, `profiles`, `global_platform_settings` (now with `ai_provider`/`ai_api_key` columns), `store_kv`, `analytics_events`, `audit_logs`, `outbound_webhooks`, RLS policies + the `is_platform_configured()` RPC + `updated_at` triggers.
  - **🔐 Licensing gatekeeper (`lib/license.ts`)** — `CLIENT_LICENSE_KEY` (alias `LICENSE_KEY`) + async `LICENSE_SERVER_URL` check (in-memory TTL cache, 4s timeout). Modes: `ACTIVE` (full access) / `GRACE` (1–3 days past due → full access + "License payment pending." banner) / `EXPIRED`/`MISSING` (Demo Mode → POST/PUT/DELETE write routes blocked). `licenseEnforced()` turns enforcement ON only when a key/server/`LICENSE_ENFORCED` is set, so a legacy storefront (nothing set) keeps full writes. `middleware.ts` now runs on ALL routes (matcher expanded from `/admin` to a negative-lookahead that skips `_next`/`media`/static) and enforces the sync MISSING-key write-block + `MAINTENANCE_MODE` redirect. New `/api/admin/license` (GET status + POST force-refresh).
  - **🤖 Universal AI engine (`services/ai/`)** — `AiProvider` (`deepseek`/`openai`/`anthropic`/`replicate`/`workers_ai`) added to `services/config/types.ts`; `AiDriver` contract + `maskApiKey` (`sk-ds-••••••••1234`); five drivers (DeepSeek/OpenAI OpenAI-compatible, Anthropic Messages, Replicate predictions-with-polling, Workers AI binding) with injectable `fetchImpl`/`runImpl`; `AiFactory.getDriver()` (platform settings → `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`REPLICATE_API_TOKEN` → Workers AI binding). `lib/ai-animation.ts` is the image-to-animation + dynamic-SVG pipeline (structured prompt → parse JSON → CSS/SVG fallback presets). New routes `/api/ai/animation` + `/api/ai/generate` (admin-gated + license-gated + rate-limited + usage-tracked). Setup wizard gained **6 · AI provider** + **2 · Data store** steps; the wizard's provider payload was FIXED to send snake_case keys (the route's `normalizePlatformSettingsInput` reads snake_case — the old camelCase body would have failed every save).
  - **📊 Analytics + outbound webhooks + maintenance.** `lib/analytics.ts` (`usageDayStamp`/`usageKey`/`trackUsage`/`readUsageTotals`, per-tenant daily hashes `analytics:usage:<tenant>:<day>`) + `/api/admin/analytics`. `lib/webhooks.ts` (`WEBHOOK_EVENTS` = user.registered/license.updated/settings.changed, `dispatchWebhookWithRetry` with exponential backoff ×3, queue enqueue/flush) + `/api/admin/webhooks` (GET config, POST save/flush). `lib/maintenance.ts` (`MAINTENANCE_MODE` parse + exempt paths) + `/maintenance` page + `/api/admin/maintenance`.
  - **🛰 env-discovery upgrades** — `CLIENT_LICENSE_KEY` is now the license check's primary var (alias `LICENSE_KEY`), a new **AI providers** group (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `REPLICATE_API_TOKEN`) and the exported `CLOUDFLARE_VARS_PATH` string ("Workers & Pages → [Project] → Settings → Variables and Secrets → Production"), surfaced on `/admin/setup-status`.
  - **🆕 Redis keys added** (in `lib/redis-keys.ts`): `ANALYTICS_USAGE_PREFIX` + `analyticsUsageKey(tenant, day)`, `WEBHOOK_CONFIG_KEY` (`ops:webhooks:config`), `WEBHOOK_QUEUE_KEY` (`ops:webhooks:queue`). No migration rows needed (new keys, no legacy equivalents).
  - **🧪 Tests + docs** — new `tests/license.test.ts`, `tests/webhooks.test.ts`, `tests/analytics.test.ts`, `tests/maintenance.test.ts`, `tests/ai-animation.test.ts`, `tests/ai-drivers.test.ts`, `tests/storage-provider.test.ts`; `tests/drivers.test.ts` updated for the AI provider field. `npm test` **193/193**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file. New `.dev.vars.example` + README "Multi-tenant B2B SaaS platform" section with all setup commands.


- **2026-08-21 — Environment auto-discovery + /admin setup-checklist interception (env-auto-discovery):**
  - **🔍 New `lib/env-discovery.ts`** — a self-contained (zero-import, edge-safe, `node --test`-loadable) auto-discovery registry that scans the runtime env object on every request and compiles a grouped checklist of every required variable, secret, and Cloudflare binding. Each check carries its exact variable name + aliases, purpose, a two-level severity (`required` for full production vs `blocking` for "admin portal cannot open"), copyable CLI commands (`npx wrangler secret put VAR_NAME` / `vercel env add …`), and the exact `wrangler.toml` block for bindings (D1, R2, KV, Workers AI). The three `blocking` checks are the data store (Redis REST URL + token) and the admin Basic-Auth password; everything else (Stripe secret/webhook, Resend, Mapbox, CRON_SECRET, site URL, Supabase, licensing `LICENSE_KEY`/`LICENSE_SERVER_URL`, bootstrap `INITIAL_ADMIN_EMAIL`) is a `required`/optional warning that never blocks the portal. Values are NEVER returned — only presence booleans, names and commands. `computeAdminReady({ storageOk, legacyAdminOk, platformConfigured })` is the single source of truth for "is the admin portal ready", shared by both the middleware and the status route so they can never drift.
  - **🛂 `/admin` interception** — `middleware.ts` now redirects every `/admin` request (and any admin sub-route) to the new **`/admin/setup-status`** checklist page whenever the install is NOT ready (no data store, no Basic-Auth password AND no Supabase super-admin). `/api/admin/*` returns `423 SETUP_REQUIRED` with a `redirect` field. The checklist, provider wizard (`/admin/setup`) and super-login endpoints stay OPEN pre-config so the operator can bootstrap with zero credentials; once ready, the standard portal unlocks automatically (seamless transition). The prior Supabase-only setup gate was subsumed by this broader readiness gate.
  - **🖥 New `/admin/setup-status` page + `/api/admin/setup-status` route** — an interactive checklist rendering the ✅/❌ breakdown with per-command and per-`wrangler.toml` copy buttons, summary chips (configured count, storage provider, admin-account status, environment), an "Open admin portal →" button when ready, and a link to the provider wizard. The route returns only presence data (never values) and is gated behind admin auth only once the store is ready.
  - **🧪 Tests** — new `tests/env-discovery.test.ts` (7 cases: empty-env blocking set, full-env ready, alias resolution, blocking-vs-required severity, non-blocking bindings/license/bootstrap, `computeAdminReady` truth table, command copy). `npm test` **158/158**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file, `npm run build` compiles the new routes + proxy middleware. **No new Redis keys** (the checklist reads only `process.env` + the existing storage/platform helpers).
- **2026-08-21 — Driver-engine services layer + Setup Wizard + super-admin login (services-driver-engine):**
  - **🧩 New `services/` driver engine** — the storefront's hardcoded Stripe/Resend/Mapbox calls now sit behind pluggable driver contracts. `services/config` (Supabase `global_platform_settings` store + `edge.ts` middleware gate), `services/email` (Resend/Postmark/SendGrid), `services/payment` (Stripe/LemonSqueezy/Paddle — Stripe keeps the raffle card-save + webhook path), `services/maps` (Mapbox/GoogleMaps/OpenStreetMap). Each category has a `types.ts` contract + a `registry.ts` (pure factory, `node --test`-loadable) + a `factory.ts` (resolves the active provider from wizard settings → legacy env fallback).
  - **🧙 First-run Setup Wizard (`/admin/setup` + `/api/admin/setup`)** — self-hosted buyers pick Email/Payment/Map providers, paste API keys, and create the master super-admin (Supabase Auth user flagged `is_super_admin`). Persisted to `public.global_platform_settings` via the new **`00003_global_platform_settings.sql`** migration (singleton row, RLS locked to super-admins, only public read is the `is_platform_configured()` RPC). `middleware.ts` forces `/admin` → `/admin/setup` while `is_configured = false`.
  - **🔑 Super-admin login (`POST /api/admin/super-login`)** — the master account signs back in via Supabase (`verifySuperAdminSignIn` verifies credentials + `profiles.is_super_admin`). Success issues an `admin:devices` cookie with `superAdmin: true`; `middleware.ts` treats that session as full authorization (skipping Basic Auth + 2FA), and the setup API accepts it for provider re-configuration. `/admin/setup?reconfigure=1` surfaces the sign-in form.
  - **🔁 Every payment/email/map call site re-wired through the factories** — checkout, cart, direct, confirm-setup, webhook, auto-draw, draw, `lib/email.ts`, `app/layout.tsx` (map token) all resolve their provider at runtime with legacy env fallbacks, so an existing store keeps working with zero config.
  - **📊 Status surfaced** — `/api/admin/env-status` + `/api/admin/self-test` now report Supabase env presence + the active providers (names only, never keys).
  - **🧪 Tests** — new `tests/super-admin.test.ts` (4 cases, mocked fetch) on top of the existing driver tests; **151/151 pass**, typecheck + lint clean. **No new Redis keys** (the super-admin marker lives on the existing `admin:devices` hash).



- **2026-08-21 — Cloudflare Worker Delivery & Caching Bridge (mtp-cf-worker-flush):**
  - **🧱 `multi-tenant-platform/worker` now deploys as `template-edge-renderer`.** `wrangler.toml` sets the worker name + `compatibility_date = "2024-01-01"` (with `nodejs_compat`). The `SITE_CACHE` KV binding keeps its placeholder `id` (paste the real one from `npx wrangler kv namespace create SITE_CACHE`); `SUPABASE_URL` / `SUPABASE_ANON_KEY` / new **`FLUSH_CACHE_SECRET`** are runtime secrets (`wrangler secret put`, never committed). New `.dev.vars.example` for local dev — the root `.gitignore` now un-ignores exactly that example file (`.dev.vars*` is still ignored otherwise).
  - **🗑 Worker-side cache-invalidation hook — `POST /api/flush-cache`** (`worker/src/flush.ts`, wired into `src/index.ts` beside `/__health`). The Admin Portal posts `{ "hostname": "demo.yourplatform.com" }` with `Authorization: Bearer $FLUSH_CACHE_SECRET` (constant-time compare, fails closed when the secret is unset) and the worker deletes **every cached version** of that tenant's KV key (`site_cache:v1..v<N>:<siteKey>` via the new `deleteCachedSite()` in `worker/src/cache.ts`), so the next visitor is served a freshly compiled payload. Hostname resolution mirrors the fast path exactly: `www.shop.acme.com` → `shop.acme.com`, `demo.yourplatform.com` → `demo`, bare keys (`demo`, `shop.acme.com`) pass through.
  - **🔌 Admin Portal client — `admin-portal/src/flush-client.ts`**: `flushSiteCache(workerBaseUrl, flushSecret, hostname)` POSTs to the Worker route as an alternative to the direct Cloudflare API bulk purge (`cloudflare-kv.ts`); documented env vars `WORKER_FLUSH_URL` / `WORKER_FLUSH_SECRET` (plus the existing direct-API path).
  - **🧪 Tests:** new `worker/test/flush.test.ts` (7 cases: 405/401/400 guards, fail-closed, platform-subdomain + custom-domain/`www` + bare-key deletion, unrelated-tenant isolation) and `admin-portal/test/flush-client.test.ts` (3 cases: success payload + request shape, error propagation, empty-hostname guard). Verified: `cd worker && npm run typecheck && npm test` (17/17), `cd admin-portal && npm run typecheck && npm test` (6/6). Platform README updated (deploy block with all three secrets, flush-hook docs, repo layout). **No storefront Redis keys were added or changed**; the platform remains excluded from the root `tsconfig`/`eslint`.

- **2026-08-21 — Default categories exist only after seeding + new multi-tenant platform scaffold (seed-only-categories + mtp-scaffold):**
  - **🏷 Default categories are GONE until seeded.** The starter list (`New Arrivals · Limited Edition · Best Sellers · Signature · Seasonal · Perfume · Fragrance · Candles & Home · Apparel · Accessories · Men · Women · Unisex`) now exists in exactly ONE place: the seed route's `DEFAULT_CONFIG.catalog.categories` (`/api/admin/seed` → `/admin → Developer → Seed Defaults`). Every other default path — `goyunir.config.ts`, `lib/store-config.ts`, `lib/storefront-config.ts` (`defaultCatalogSettings`), `/api/store/config`, and the admin portal's `DEFAULT_CATALOG_SETTINGS` — is now `categories: []`, so an unseeded store (empty Redis) shows NO categories anywhere (admin Catalog tab, product-form picker, /catalog filter bar, product chips). Running Seed Defaults writes the starter list into Redis as before. The "empty `[]` is a real state, never re-substituted with defaults" guard is unchanged and still covered by `tests/catalog-entries.test.ts`.
  - **🌐 NEW sibling workspace `multi-tenant-platform/` — a Supabase (Postgres + RLS) / Cloudflare Workers + KV multi-tenant template platform.** Self-contained monorepo: `shared/` (strict TS contracts — DB rows, `ThemeConfig`, the `LayoutBlock` discriminated union, `CompiledSite`, the supabase-js `Database` generic; `hostname.ts` resolves `*.yourplatform.com` subdomains + custom domains to KV keys `site_cache:v<N>:<siteKey>`), `supabase/migrations/` (schema + RLS: owners CRUD their rows, anon reads only PUBLISHED sites; optional demo-tenant seed), `worker/` (Cloudflare Worker: KV fast path → compiled JSON SSR'd into a boilerplate HTML layout; Supabase slow path via `@supabase/supabase-js`, 24h KV TTL, `/__health`), and `admin-portal/` (Save/Publish pipeline: service-role Supabase write → Cloudflare API bulk KV purge so the live site updates instantly; Next.js-compatible `route.example.ts`). Both workspaces typecheck (`strict`, zero `any`) and pass `node --test` (worker 10 tests, admin 3). The platform folder is EXCLUDED from the storefront's root `tsconfig`/`eslint` (it carries its own optional deps — `@supabase/supabase-js`, `@cloudflare/workers-types`, `wrangler`) and `.gitignore`'s `node_modules` pattern is now unanchored (`node_modules/`) so the platform's nested installs stay out of git. Verified: root `npm run typecheck` clean, `npm test` **129/129**, platform typechecks + tests green. No Redis keys were added or changed.

- **2026-08-20 — Deployment docs made "stupid-proof" (deploy-docs-overhaul):**
  - **📘 `DEPLOY-CLOUDFLARE.md` rewritten as a six-step, copy-paste walkthrough.** The guide now opens with a checkbox prerequisite list (Node, Cloudflare account, Upstash REST URL/token, Stripe keys, `wrangler login`), a "big picture" table mapping each step to its exact command + output, and then numbered steps: install → build → deploy + secrets → domain → cron worker → verify. The key confusion points are called out explicitly: a **build-time vs runtime env-var table** (`NEXT_PUBLIC_*` must be in your shell before the build and can NEVER be set in the dashboard; everything else goes through `wrangler secret put`), **deploy-then-secrets ordering** (the docs now explain `wrangler secret put` fails with "Could not find Worker" if the worker isn't deployed yet — it's in the troubleshooting table), secrets take effect immediately (no redeploy needed), and the domain step tells you to rebuild with `NEXT_PUBLIC_URL` once the custom domain is live. PowerShell + bash variants both included.
  - **⚙️ New convenience scripts in `package.json`:** `build:cloudflare` = `node scripts/inject-mapbox-token.mjs && npx opennextjs-cloudflare build` (the Mapbox token injection step was previously MISSING from the documented Cloudflare build — the OpenNext build bypasses `npm run build`), and `deploy:cf` = build + `npx wrangler deploy`. The docs use these instead of raw `npx opennextjs-cloudflare build`, so the standalone address form's token is injected on Cloudflare too.
  - **📖 README §1 restructured:** a **"Pick your platform"** comparison table (Vercel/Netlify easiest, Cloudflare = few terminal commands, Node host) plus a shared **"Common setup (every platform)"** flow (env vars → `/admin` login + Seed Defaults → Stripe webhook → `/admin → SetUp` checklist). Each platform subsection is now numbered click-path steps: Vercel (Import → Root Directory → env vars → deploy → `vercel.json` cron + Hobby one-cron/day note), Netlify (Import → Base directory → env vars → deploy → automatic scheduled function), Cloudflare (one-line quickstart + pointer to the full guide), and Any Node host (build/start + external scheduler).
  - **🧩 `cron-worker/README.md`** gained a deploy-order warning (deploy the main app FIRST — `TARGET_URL` needs a real URL), a note that `wrangler deploy` must precede `secret put`, and a Verify section (expected log lines + what `SKIPPED` means).
  - **🧹 `eslint.config.mjs` now ignores platform build/tool output** (`.open-next/**`, `.wrangler/**`, `cron-worker/.wrangler/**`, `.vercel/**`, `.netlify/**`). The generated OpenNext bundle used to be linted the first time a buyer ran a Cloudflare build, producing thousands of false errors from generated files.
  - Verified: `npm run build:cloudflare` runs the full OpenNext build end-to-end (`.open-next/worker.js` + `middleware/handler.mjs` produced), `npm run typecheck` clean, `npm test` passes, `npm run lint` clean. No Redis keys were added or changed.

- **2026-08-20 — Cloudflare Workers middleware fix (proxy.ts → middleware.ts):**
  - **🐛 `npx opennextjs-cloudflare build` crashed with `ERROR Node.js middleware is not currently supported`.** Root cause: Next.js 16 renamed `middleware` to `proxy`, and **`proxy.ts` is hardcoded to the Node.js runtime** (the docs say "Proxy always runs on Node.js runtime" — a `runtime` config in `proxy.ts` even throws E1031). OpenNext's Cloudflare adapter explicitly rejects a Node.js `/_middleware` in `functions-config-manifest.json`; it only accepts the legacy **Edge** `middleware` convention registered in `middleware-manifest.json` at `middleware["/"]`.
  - **🔧 Fix: `proxy.ts` was renamed to `middleware.ts`** (the deprecated-but-supported Edge middleware convention) and the named export `proxy` → `middleware`. The `config` matcher is unchanged (`/admin/:path*`, `/api/admin/:path*`). Verified against the compiled manifests: `middleware-manifest.json` now has `middleware: { "/": { name: "middleware", matchers: [...] } }` and `functions-config-manifest.json` has **no** `/_middleware` entry — so OpenNext's `useNodeMiddleware()` returns false and the build proceeds. The "middleware is deprecated" warning during `next build` is expected and harmless.
  - **⚠️ Do NOT add `runtime: 'edge'` to the middleware `config`.** An explicit `runtime: 'edge'` in `middleware.ts` is rejected by Next 16.2.12 with E1015 (`Page /middleware provided runtime 'edge', the edge runtime for rendering is currently experimental` — verified empirically). The `middleware.ts` convention **is** the Edge runtime by default; leaving the key out is the correct explicit Edge setup.
  - **🔒 Edge-safe import refactor.** The old `proxy.ts` imported `@/lib/server-config` and `@/lib/admin-verify`, which transitively pull in Node-only modules (`crypto`, `stripe`, `resend`) that are unavailable in the V8/workerd Edge runtime. The new `middleware.ts` imports only `createStorageClient` from `@/lib/storage` (verified zero Node builtins) and `ADMIN_DEVICES_KEY` from `@/lib/redis-keys` (zero imports), and inlines the small edge-safe helpers (`resolveAdminPassword`, `parseStoredValue`, `adminDeviceTokenFromRequest`, `adminDeviceValid`) mirroring `lib/server-config.ts` / `lib/admin-verify.ts` exactly. Behavior is byte-for-byte identical: Basic Auth on every `/admin` + `/api/admin` path, 2FA device-cookie gate (with the `/admin` page + verify-* endpoints exempt), lazy `admin:devices` expiry, `ADMIN_2FA_REQUIRED` 401, fail-open when no storage is configured.
  - Verified: `npx opennextjs-cloudflare build` completes (`OpenNext build complete`, worker + `middleware/handler.mjs` emitted, zero Node builtins in the edge chunks), `npm run build` green, `tsc --noEmit` clean, `npm test` **129/129**, `eslint` 0/0 on every touched file. No Redis keys were added or changed.

- **2026-08-19 — "Make it less laggy + organize the Redis" finalization pass (perf-payload + redis-bounded-dedupe + orphan-sweep):**
  - **🚀 `/api/store` payload cut ~in half and product pages stop downloading the whole catalog.** The endpoint used to serialize EVERY product twice — once in `allProducts` and again in its lifecycle section array (`activeProducts` / `archivedProducts` / `upcomingProducts`). It now returns ONE canonical `allProducts` array (lifecycle flags live on each product), and the four consumers (home, catalog, SiteChrome cart-pruning, Storefront) derive their sections client-side. A `?slug=` request now returns ONLY `config + product` (no `allProducts`, no sections) — product pages, the highest-traffic route, no longer download the entire catalog on every load. The 10s TTL cache + edge headers are unchanged.
  - **📦 `framer-motion` removed from the public bundle (~50–100KB gzipped).** It was only used by `/catalog` for three one-shot animations (tile hover lift, search-bar fade-up, detail-sheet slide-up). All three are now plain CSS (`app/globals.css` keyframes + classes), the dependency is out of `package.json`, and the built client chunks contain zero framer-motion references. Reduced-motion users already collapsed these to ~0ms via the existing media query.
  - **🗑 The unbounded dedupe sets are GONE — `entries:processed` and `entries:email_sent` are now bounded, timestamp-scored ZSETs.** Previously every Stripe session id and every `variant:size:email` row was SADD-ed forever, so a busy store's Redis grew without bound. Now: membership = ZSCORE, every write prunes members older than the retention window (**72h** for processed sessions — Stripe's webhook retry window; **30 days** for sent emails). New `lib/redis-maintenance.ts` (`markProcessedSession`/`isProcessedSession`/`markEntryEmailSent`/`isEntryEmailSent`) is wired into `/api/checkout/confirm-setup` + `/api/stripe/webhook`, self-migrates legacy SET-shaped keys on first write, and tolerates both shapes during migration (a race can never double-process). `zscore` added to the `StorageClient` contract + the Workers-KV adapter.
  - **🧹 Orphaned-state sweep keeps the key space small.** New `sweepOrphanedProductState()` (also in `lib/redis-maintenance.ts`) prunes per-product/per-user records whose product or user no longer exists: `entries:stats` fields, `entries:last_auto` fields, `ops:overrides#product:<id>`, `ops:live_state` rows, `store:carts` for deleted accounts, and empty/orphan pool-intent-waitlist keys. **`deleteProduct` now cleans everything on the spot too** — pools, intent/waitlist pools, fraud blocks, stats fields, last-auto fields, the product override — and it FIXED A REAL BUG: the old `hdel(LIVE_STATE_KEY, id)` matched nothing because live-state fields are `<productId>-<slug>:<size>`, so deleted products' live states lingered forever; the delete now drops every field starting with the id.
  - **🛠 Tidy Redis Schema + Site Self-Test upgraded.** `organize-redis` now finishes with `maintainDedupeStructures()` + `sweepOrphanedProductState()` (reports what it pruned) and the self-test gained a **"Dedupe sets bounded (72h / 30d)"** check that reports cardinalities and flags legacy SET-shaped data. Admin copy updated to explain the sweep. Run Tidy a few times a year to keep a live store's key space small.
  - **🖼 Product gallery images got `loading="lazy" decoding="async"`** (non-cropped paths already used background-image + content-visibility). Removed the accumulated scratch `.log`/`_dbg-*`/`tsbuildinfo` files from the repo root.
  - **🧪 Tests:** new `tests/redis-maintenance.test.ts` (5 cases: bounded mark/expiry pruning, legacy-SET self-migration, processed-session round-trip, full orphan sweep keep/prune matrix, named-key maintenance). `npm test` **129/129**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file, `npm run build` compiles every route + the proxy middleware, and the production server was smoke-tested (`/`, `/catalog`, `/[slug]`, `/api/store`, `/api/store?slug=…` all 200 with the new payload shapes). No new Redis keys — `entries:processed` / `entries:email_sent` keep their names (now ZSETs); the maintenance helpers live in `lib/redis-maintenance.ts`.

- **2026-08-18 — "Deleted products still show in Upcoming/Archives" + "categories won't delete" FIXED (delete-catalog-cleanup):**
  - **🐛 Deleted products kept rendering in Upcoming/Past Archives — root cause found.** `deleteProduct()` in `/api/admin/products` read the product with a raw `typeof rawProduct === 'string'` guard, but Upstash REST Redis (the default provider) auto-deserializes stored JSON, so `hget` returns an ALREADY-PARSED OBJECT. The guard failed → `syncCatalogConfigForProduct()` (which prunes the product from `store:config.catalogPreview.upcomingDrops` / `.archiveScents`) **never ran** → the deleted product's auto-created catalog entries survived and kept rendering on `/catalog`. Same bug class as the 2FA/verification fix. `deleteProduct` now reads through `safeParseRedisItem()` (accepts string OR object), so the cleanup always runs.
  - **🧹 Product deletion now removes EVERY trace.** `deleteProduct` also drops the product's `ops:catalog_archive` record (`unarchiveProductFromCatalog`) and its live inventory states (`hdel` on `ops:live_state`), wrapped in try/catch so a cleanup hiccup can never fail the delete itself.
  - **🛡 Read-time reconciliation self-heals already-stale data.** New self-contained **`lib/catalog-entries.ts`** (no `@/` imports so `node --test` loads it; re-exported from `@/lib/storefront-config` so existing imports are untouched) with `filterStaleCatalogEntries()`: auto-created catalog entries always carry the product's `slug`; manual entries added in the admin Catalog tab have NO slug. So any configured entry with a non-empty slug whose slug/name no longer resolves to a product in `store:products` is a DELETED product — dropped by `/api/catalog/status` (storefront) AND `/api/admin/catalog-settings` GET (admin Catalog tab — the next "Save Catalog Settings" purges them from Redis permanently). Manual entries are never touched. `syncCatalogConfigForProduct` now also tags auto entries with `id: product.id`.
  - **🏷 Category deletion actually sticks now — three separate bugs fixed.**
    - **Deleting ALL categories no longer resurrects the seeded defaults.** The admin `fetchSettings` replaced an empty `catalog.categories` (`[]` = "every category deleted") with `DEFAULT_CATALOG_SETTINGS.categories`, so the deleted list came back on reload and was re-saved to Redis. It now preserves `[]`. Same guard fixed on the storefront `/catalog` filter bar (initializer + `/api/store` refresh no longer substitute the static defaults for an empty list).
    - **The Catalog tab's "Save Catalog Settings" now persists categories too** (it previously only saved `catalogPreview`, silently losing category edits). Client sends `categories`, and `/api/admin/catalog-settings` POST writes them (normalized; empty = valid).
    - **Deleted categories disappear from products everywhere.** New `visibleProductCategories()` filters a product's tags against the current admin-managed category list on the home cards, the product page, the admin product list rows and the ProductLivePreview (new `categories` prop). The product's underlying tags are never destroyed (re-adding the category brings them back), but a deleted category can no longer render as a chip on any surface.
  - **🧪 Tests:** new `tests/catalog-entries.test.ts` (9 cases: normalizeCategories, visibleProductCategories incl. empty-list, filterStaleCatalogEntries incl. slug/name matching + manual-entry preservation). `npm test` **124/124**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file, `npm run build` compiles every route + the proxy middleware. No Redis keys were added or changed (categories live in `store:config.catalog.categories`; catalogPreview lives in `store:config`).

- **2026-08-18 — Storage abstraction layer landed: Upstash Redis ↔ Workers KV behind ONE interface ("storage-layer"):**
  - **🧱 New `lib/storage/` module — the data backend is now a seam, not a dependency.** `lib/storage/types.ts` defines the `StorageClient` contract (exactly the command surface the codebase uses — verified by inventory: strings, keyspace, hashes, lists, sets, zsets), `lib/storage/upstash.ts` wraps the `@upstash/redis` REST client (the ONLY file allowed to import it; env/alias resolution moved here unchanged), and `lib/storage/cloudflare-kv.ts` implements the same contract on **Workers KV** (envelope-encoded values with TTL, in-memory fallback for local dev/tests, auto-detects a KV-shaped global binding). `lib/storage/index.ts` → `createStorageClient()` selects the provider ONCE per process via `STORAGE_PROVIDER` (default `upstash`). Every route still calls `createRedisClient()` from `@/lib/server-config` (now a thin alias) — zero changes at call sites. The active provider is surfaced in `/admin → SetUp` (`/api/admin/env-status` now returns `storageProvider` + a "Data backend" row).
  - **🐛 Two checkout routes used the Upstash-only 3-arg `set(key, value, { ex })` form**, which the interface (and the KV adapter) can't honor — they now use `setex(key, seconds, value)` (`/api/checkout` + `/api/checkout/cart` promo-pending locks; 10-min TTL unchanged).
  - **🐛 `/api/admin/organize-redis`** passed an `unknown` (possibly object) value into `hset` — now coerced with `String(value)` before folding.
  - **🧹 KV adapter formatting cleaned** (three `}export`/`}  async` run-together lines) and the stale `createRedisClient` doc in `lib/server-config.ts` rewritten for the abstraction.
  - **🧪 Tests:** new `tests/storage.test.ts` (10 cases) exercises the KV adapter end-to-end on the in-memory fallback (strings/TTL, hashes, lists, sets, zsets, keyspace, renamenx, ping). `npm test` **115/115**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file. No Redis keys were added or changed — the key layout is untouched, only the client that talks to it.

- **2026-08-18 — Production finalization of the Cloudflare/preview pass ("finish what u were working on, finalize polish up for production"):**
  - **🔧 `npm run typecheck` is green again.** The prior commit shipped `open-next.config.ts`, which imports the OPTIONAL `@opennextjs/cloudflare` adapter — a package buyers install only when deploying to Cloudflare (see DEPLOY-CLOUDFLARE.md). Because `tsconfig.json` included `**/*.ts`, the standard typecheck failed with `TS2307: Cannot find module '@opennextjs/cloudflare'` on every repo — including the 95% that deploy on Vercel/Netlify/Node. `open-next.config.ts` is now excluded from the standard `tsc --noEmit` (documented inline; the OpenNext build still loads + bundles it when the adapter is installed), so the typecheck gate is green out of the box.
  - **🧹 Debug scratch removed from git.** The committed `tsc-err.txt` / `tsc-out.txt` (an empty error file + the TS2307 log) were session artifacts that never belonged in the shipped template — `git rm`'d.
  - **📏 Full lint is 0/0.** The two remaining warnings (`import/no-anonymous-default-export` on `cron-worker/src/index.mjs` and `netlify/functions/cron-tasks.mjs`) are gone — both scheduled functions now assign their handler to a named const and `export default` it (behavior unchanged; still valid Workers/Netlify exports).
  - Verified end-to-end: `npm run typecheck` clean, `npm run lint` 0 errors / 0 warnings, `npm test` **105/105**, `npm run build` compiles every route + the proxy middleware. No Redis keys were added or changed.

- **2026-08-18 — Product-editor live preview + Cloudflare setup shipped ("add previews for product panel" + "set up for Cloudflare"):**
  - **🖼 Live storefront preview in the product panel.** New client component `components/ProductLivePreview.tsx` renders a pixel-faithful mini product page inside the product editor (right under the at-a-glance strip, before Math & health check) built from the CURRENT UNSAVED form + `themeSettings` + `copySettings`. It updates on every keystroke: cover image with the admin crop applied 1:1 (`coverStyle` with natural dims loaded in the background), video badge, MIXED/RAFFLE/FCFS pills, Live now/Sold out/Upcoming/Archived label, name, tagline, category chips, description (pre-line), urgency + status lines with the per-product → global → built-in resolution, the mixed-format ribbon (template tokens resolved), clickable per-size chips with buy/raffle + 🧪 badges, the per-size sampler card with the credit math strip + progress bar (or the upgrade nudge), the countdown hint, price + CTA (Enter allocation / Secure piece · $X / PRICE NOT SET / Sold out), the "Why this drop matters" note count, and a legend explaining what the math decided (mode, sold-out state, price state). Same luminance-driven sampler/mode palettes as Storefront, same theme material (surfaceBackground + cardSheen + cardShadowStyle). Mounted with `key={editingProduct || 'new-product'}` so reopening a product resets the selected size.
  - **☁️ Cloudflare setup shipped.** New root **`open-next.config.ts`** (pins the `@opennextjs/cloudflare` adapter, documented) + **`wrangler.jsonc`** (main Worker: `main: .open-next/worker.js`, `assets` binding, `nodejs_compat`, observability) + **`DEPLOY-CLOUDFLARE.md`** — a complete walkthrough: install the adapter, build with `NEXT_PUBLIC_*` inlined (bash + PowerShell), `wrangler deploy`, the full runtime-secret list (`wrangler secret put`), custom domain (`wrangler domains add`), cron-worker deployment, a 6-point verify checklist (edge headers, self-test, manual cron ping, Stripe webhook), a troubleshooting table, and the Pages alternative. `.gitignore` now excludes `.open-next/`, `.wrangler/`, `.dev.vars*`. README + AGENTS.md Cloudflare sections updated. No Redis keys were added or changed.
  - Verified: `npm run typecheck` clean, `npm run lint` 0/0, `npm test` passes, `npm run build` compiles.

- **2026-08-18 — Platform-agnostic deployment pass (works on Vercel, Netlify, Cloudflare, or any Node host):**
  - **🔐 Cross-platform cron auth (`lib/cron-auth.ts`, dependency-free).** The four scheduled endpoints (`/api/checkout/cron-draw`, `/api/cron/auto-draw`, `/api/cron/recovery`, `/api/analytics/social-tick`) now share ONE auth helper instead of four copies of the Vercel-only check. Vercel's `x-vercel-cron: 1` header is trusted directly; every other scheduler authenticates with `Authorization: Bearer $CRON_SECRET` (legacy `?key=` query and `x-cron-secret` header also accepted). Netlify scheduled functions, Cloudflare cron workers, cron-job.org, GitHub Actions, QStash and self-hosted crontab all work. Per-route open-when-no-secret behavior preserved (draw endpoints closed, recovery/social-tick open).
  - **📦 Netlify support shipped:** `netlify.toml` (build command + `[functions."cron-tasks"]` daily schedule) and `netlify/functions/cron-tasks.mjs` — a scheduled function that pings the same three safety-net endpoints with the bearer `CRON_SECRET` (site URL auto-injected via `URL`/`DEPLOY_PRIME_URL`).
  - **☁️ Cloudflare support shipped:** `cron-worker/` — a tiny standalone Workers project (`wrangler.jsonc` daily cron trigger + `src/index.mjs` `scheduled` handler) that forwards the run to the same endpoints. Deploy with `npx wrangler deploy` + two secrets (`TARGET_URL`, `CRON_SECRET`). The main app deploys via the OpenNext adapter with zero code changes.
  - **🌐 Site-URL fallbacks now cover every major host (`lib/env.ts`):** after `NEXT_PUBLIC_URL`/`NEXT_PUBLIC_SITE_URL`/`SITE_URL`, `getSiteUrl()` falls back to Vercel (`VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL`), Netlify (`URL` → `DEPLOY_URL`) and Cloudflare Pages (`CF_PAGES_URL`), accepting both bare hostnames and full `https://host` values. `buildAbsoluteUrl` no longer depends on `VERCEL_ENV` (uses `NODE_ENV`).
  - **🛢 Redis client accepts every platform's Upstash REST aliases (`lib/server-config.ts`):** `UPSTASH_REDIS_REST_URL` → `KV_REST_API_URL` → `REDIS_REST_URL` → `REDIS_URL` (tokens likewise), skipping `redis://`/`rediss://` wire-protocol URLs that the REST client can't use. Admin SetUp/status checks updated to match.
  - **💨 `CDN-Cache-Control` alongside `Cache-Control` everywhere (`lib/cache-headers.ts` → `edgeCacheHeaders()`):** wired into `/api/store`, `/api/catalog/status`, `/api/config/public`, `/og`, `/icon` and `/media` so Netlify's CDN (which reads `CDN-Cache-Control`) and Cloudflare's edge cache the same bodies Vercel already cached — the Fast Origin Transfer fix now holds on every platform. Browsers still always revalidate the JSON routes (only the CDN layer gets the copy).
  - **🧪 Tests:** new `tests/cron-auth.test.ts` (6 cases: Vercel header trust, bearer/`?key=`/`x-cron-secret` acceptance + rejection, open-when-no-secret) and a new `tests/env.test.ts` platform-fallback case (Vercel/Netlify/Cloudflare hosts, placeholder/malformed skipping, explicit-URL-wins). `npm test` **105/105**, `tsc --noEmit` clean, `eslint` 0/0 on every touched file. No Redis keys were added or changed.

- **2026-08-18 — "Smart admin" pass: line breaks + show/hide everywhere, Pricing & Sizes absorbs inventory, credits/points incentives, anti-exploitation math gates, diverse seeds (smart-admin-pass):**
  - **🧮 The admin portal now UNDERSTANDS the math.** New pure engine **`lib/product-sanity.ts`** (`checkProductSanity` / `checkRewardsSanity` / `sortSanityIssues` / `parseWinnerTiers`) powers a live **"Math & health check"** panel at the top of the product editor (updates on every keystroke), a **Catalog Health** card on the Overview tab (every product's issues, click-through to fix), a **rewards-economy alert** in Settings → Rewards & Points, and a **save-time gate on BOTH the client and the server** (`/api/admin/products` returns 400 when an 'error' issue exists). Checks flag: sampler credits ≥ sampler price (a guaranteed profit loop — BLOCKED), credits ≥ full-size price (free items — BLOCKED), min-order ≤ credit, raffle winner tiers exceeding inventory (BLOCKED), winners configured on FCFS sizes, per-size inventory summing to something other than the total, go-live after countdown-end (BLOCKED), past one-shot countdowns, zero-inventory live products, no Stripe IDs, reward earn-rate ≥ redeem-rate (customers farm credit — BLOCKED at settings level), and gift discounts ≥ 100%.
  - **📦 "Inventory & Limits" is GONE as a separate section — it now lives INSIDE Pricing & Sizes.** The section is renamed **"Pricing, Sizes & Inventory"**: every size card gained its own **Units** stock input right beside price/Stripe ID (per-size inventory is where you think it is, not in a far-away panel), and a compact **"Inventory & limits"** sub-panel at the bottom holds Total inventory, Max raffle allocation, Max per email/cart, plus a **live reconciliation line** ("per-size units sum to X vs Total Y — make them match") so mismatches are obvious. The Drop Schedule section gained a **live "Next scheduled draw" preview** computed from the current product/global cadence.
  - **✍️ Text items can be ENABLED/DISABLED everywhere, and every prose field accepts line breaks.** New per-product **Show / hide** toggles (urgency line, status story, "Why this drop matters", mixed-format ribbon — default ALL on) persisted through `/api/admin/products` → `/api/store` → the product page. New global toggles: **hero elements** (eyebrow/headline/body/CTA/story) in Settings → Hero Content, **social-proof counter + caption** in Draws → Automation, and **footer tagline** in Settings → Footer. Product descriptions, note bodies and the mixed ribbon now render with `white-space: pre-line` on the product page + catalog, so an Enter in the admin is a real line break on the site.
  - **⭐ Credits & points are advertised so buyers are incentivized.** The product page shows **"Earn X points on this size"** for the selected size (from the admin earn rate, only when a real price is configured), the cart drawer shows **"You'll earn X points on this bag"** next to the total, and every cart line for a sampler size shows **"🧪 Includes $X credit after delivery"** with its upgrade target.
  - **🌍 Seeds are now diverse across buyer demographics.** The 14 seeded products were retargeted from an all-fragrance catalog to a multi-vertical showcase while keeping every mechanical demo: **streetwear** (Heavyweight Hoodie — flagship raffle + crops + 12h recurring), **sneakers** (Runner NRG — multi-size raffle with per-size timers), **fragrance/beauty** (Noir Citrus — mixed sampler→full-bottle credit), **candles & home** (Ember Candle — 3-size FCFS with per-size inventory), **art prints** (Limited Print — upcoming raffle), **gourmet pantry** (Small-Batch Syrup — upcoming FCFS), **tech accessories** (Studio Cable — tight 45-unit raffle), plus archived/apparel/accessory/draft/sold-out proof entries and the beauty member bundle. Every product stays tagged with the seeded category list and reuses existing image folders.
  - Verified: `npm test` **98/98** (11 new `tests/product-sanity.test.ts` cases), `tsc --noEmit` clean, `npm run lint` clean, `npm run build` compiles every route + middleware. No Redis keys were added or changed (show flags live on the product object in `store:products`; hero/social/footer toggles live in `store:config`; the sanity engine is a pure lib).

- **2026-08-18 — Product-editor UX finalization ("finalize and polish everything") — sticky save bar + mixed-format clarity + editable ribbon + rename safety:**
  - **📌 Product save bar now FOLLOWS the scroll exactly like Save All Settings.** The old bar sat at the END of the long product form with `sticky; top: 92` — so it was effectively invisible until you scrolled all the way down. It is now **`position: sticky; bottom: 12`**: it floats pinned to the bottom of the viewport the whole time the form is on screen and settles into place at the end. The **quick-jump nav is now genuinely sticky** too (`top: 92`, floating pill bar) — the section pills stay reachable no matter how deep you are in the form.
  - **🎟 Mixed products read correctly everywhere ("one raffle + one fcfs" finally makes sense).** (a) The **at-a-glance summary strip** now computes the EFFECTIVE per-size modes and shows a **MIXED · 🎟 N raffle + ⚡ M instant-buy** pill instead of a plain product-level RAFFLE pill. (b) Each size card gained a live **per-size summary line** — "🎟 Raffle size · draws 3 winners on draw 1 · inherits product timer" for raffle sizes and "⚡ Instant-buy size · charges at checkout · never enters a raffle pool" for FCFS. (c) The **"Winners / draw" input is hidden for FCFS sizes** (it was meaningless/confusing) and replaced with a clear "⚡ Sells instantly at checkout — never drawn" note; FCFS size cards also show an explanatory blue panel so the operator knows why there's no raffle timer. (d) The per-size raffle-settings panel remains visible ONLY for raffle sizes.
  - **✍️ The mixed-format ribbon is now editable** — "This release mixes formats — 1 raffle size and 1 instant-buy size…" is no longer hardcoded. New **`mixedFormatRibbon`** template setting in **Settings → Storefront copy** (global, with `{raffle}`/`{fcfs}` tokens that become the size counts) AND **per-product** in the product form's **Customer-facing copy** section. Resolution: per-product → global → built-in sentence (the built-in keeps the old colored strong-tag styling).
  - **🔧 Size-rename safety.** Renaming a size in Pricing & Sizes now re-keys **per-size inventory (`inventoryPerSize`), the per-size raffle config (`sizeConfigs`) AND sampler records** in ONE pass (previously a rename could orphan per-size stock, and a sampler rename early-returned before the raffle config was re-keyed).
  - Verified: `npm test` 87/87, `tsc --noEmit` clean, `npm run lint` clean, `npm run build` compiles every route + middleware. No Redis keys were added or changed (`mixedFormatRibbon` lives on the product object + `store:config.copy`).

- **2026-08-18 — Streamer masking expanded + product editor overhaul + seeded category defaults + richer settings previews + overview dashboard (admin-polish-pass):**
  - **🛡 Streamer Mode hides MORE.** The fixed-length mask system now covers **tracking numbers, promo codes, order refs, phone numbers and names** (new masks + `pii()` kinds), not just email/address/card. Wired into the ledger rows (Ref / promo / 📦 tracking), draw-history winners (promo), the trigger-drop result summary (promo), and a new `redactDetail()` helper redacts free-form **audit-log** lines (emails, phones, and any code-like 6+ char token mixing letters + digits → fixed masks). Over-masking is safe; under-masking leaks.
  - **🧭 Product editor reorganized ("more sense + more power").** New **at-a-glance summary strip** (live Status / RAFFLE / FCFS / 🧪 trial pills + size count, price range, inventory, category count, go-live/end times) and a **sticky quick-jump nav** (`Basics · Media · Pricing & sizes · Trial sizes · Inventory · Drop schedule · Sold-out · Copy · Notes`) that scrolls to each section — `SectionCard` now takes an `id` + scroll-margin. **Gallery & Images moved up** to right after Basics (photos-first editing), so Pricing & Sizes → Trial sizes → Inventory → Drop schedule → Sold-out → Copy → Notes flow logically top-to-bottom. The **product list** gained a **⧉ Duplicate** button (`duplicateProduct()` opens a new hidden copy with a fresh name/slug) and shows **category chips + per-size inventory** on every row.
  - **🏷 Product categories — real seeded defaults.** The junk placeholder list (`Clothes · Shoes · Food · Tools · Tires · Pastries · Beanies …`) is replaced everywhere with `['New Arrivals', 'Limited Edition', 'Best Sellers', 'Signature', 'Seasonal', 'Perfume', 'Fragrance', 'Candles & Home', 'Apparel', 'Accessories', 'Men', 'Women', 'Unisex']` — updated in `goyunir.config.ts`, `lib/store-config.ts`, `lib/storefront-config.ts`, `app/api/store/config/route.ts`, `app/api/admin/seed/route.ts` and the admin `DEFAULT_CATALOG_SETTINGS`. All 14 seed products + the 3 static config products were re-tagged to the new list (`Winter`/`Summer` → `Seasonal`, raffles get `Limited Edition`, samplers get `Best Sellers`, flagships get `New Arrivals`/`Signature`).
  - **🧪 "Anything non-blank is seeded."** The seed's `DEFAULT_CONFIG.branding` now carries the **full** share-card composition block (`shareTagline`, `shareUrl`, `brandFontSize`, `shareLayout`, `shareFontFamily`, `shareTitleSize`, `shareDescriptionSize`, `shareGlowIntensity`, `shareCornerRadius`, `shareImageOverlay`, `shareLogoVisible`, `shareTaglineVisible`, `shareSiteVisible`) so a freshly seeded store's Redis config is complete and matches what the admin editor shows — no missing non-blank defaults.
  - **🖼 Settings previews rebuilt.** Theme Colors now previews a **mini storefront** (page background + glass top bar with real chrome math + hero line + 2-card grid + CTA + radius/chrome/shadow legend) instead of a single card. The **Hero Content preview** renders on the themed page background with the configured brand name/font + accent + CTA. New **Registration Form preview** shows the entry card (title, email/address fields with placeholders, submit CTA, fine print) live from the form copy.
  - **📊 Overview dashboard upgraded.** New "Store Overview" card with quick actions (`+ Add Product`, `🎲 Run a Draw`, `⚙️ Settings`) and expanded stat grid: STARTED · ENTERED · CHARGED · INVENTORY LEFT · **PRODUCTS** · **REVENUE** (computed from the ledger's WINNER_CHARGED rows).
  - Verified: `npm test` 87/87, `tsc --noEmit` clean, `npm run lint` clean, `npm run build` compiles every route + middleware. No Redis keys were added or changed (categories + branding live in `store:config`).

- **2026-08-18 — Per-product urgency copy + per-size raffle engine ("customize each raffle differently") + admin product-form overhaul + hard auth on every admin route:**
  - **✍️ The product page's urgency/status lines are now editable ON the product admin page.** New **Customer-facing copy** section in the product form: `urgencyInStock`, `urgencySoldOut`, `statusLive`, `statusArchived` (all optional). Resolution order is per-product → global Settings → Storefront copy → built-in default (`components/Storefront.tsx`). Persisted through `/api/admin/products` (whitelisted, empty string = inherit) and passed through `/api/store` `sanitizeProduct`.
  - **🎟 Per-size raffle configs — the "2 sizes, both raffle, customize each differently" feature.** Each size card in Pricing & Sizes now has its own **🎟 Per-size raffle settings** panel: own **countdown end** (`sizeConfigs[<size>].releaseEndsAt`) + own **recurring schedule** (`sizeConfigs[<size>].customDropSchedule` — hourly/daily/weekly/biweekly/monthly/yearly/custom N hours), on top of the existing per-size checkout mode, winner tiers, inventory, sampler and Stripe ID. New self-contained **`lib/size-configs.ts`** (`sizeConfigKey` / `sizeConfigsOf` / `getSizeReleaseEndsAt` / `getSizeCustomSchedule` / `resolveSizeReleaseEndsAt` / `resolveSizeSchedule` / `normalizeSizeConfigs` — no `@/` VALUE imports so `node --test` loads it) re-exported from `@/lib/storefront-config`; `resolveSizeNextAnchorMs` composes them with the recurring-anchor math.
  - **🧭 One resolver, every consumer agrees.** `lib/auto-draw.ts` `evaluatePoolDue` now resolves the per-size cycle boundary + per-size schedule (own `releaseEndsAt`/schedule win over product → global); the deferred roll-forward writes each configured size's next anchor into `sizeConfigs[<size>].releaseEndsAt` while inheriting sizes still roll the product-level timer. `/api/store` `applyLifecycle` computes a per-size display-anchor map (`sizeNextReleaseEndsAt`) and the product-level `nextReleaseEndsAt` becomes the EARLIEST per-size anchor; `/api/catalog/status` tiles use the same earliest-anchor rule. `components/Storefront.tsx` now resolves its countdown + draw-trigger anchors PER SELECTED SIZE (per-size override → product → global) via a `resolveProductAnchors` helper + a `[product, selectedSize]` effect — switching sizes switches the timer, and the engine draws each size's pool on its own cycle.
  - **🧹 Products settings cleaned up.** Pricing & Sizes rows are now proper per-size cards (identity/price row, draw/format row, per-size raffle row) with a live RAFFLE/FCFS pill per size; a new Customer-facing copy card; size renames re-key sampler + sizeConfig records; removals prune them; `validateSeedProducts` now rejects `sizeConfigs` keys that aren't real price categories.
  - **🔐 Every `/api/admin` route now requires in-route authorization.** `env-status`, `status` and `verify-status` (the last three with no in-route check) now call `adminRequestAuthorized(request, password)` on top of the proxy.ts Basic-Auth + device-cookie gates — a misconfiguration that ever exposes a handler can never be read unauthenticated.
  - **🧪 Seeds:** Obsidian Void (p2) now demos per-size raffle configs (Standard inherits the product timer; Collector draws on its own 5-day countdown + own daily 19:00 cadence). New `tests/size-configs.test.ts` (7 cases). `npm test` 87/87, `tsc --noEmit` clean, `npm run lint` 0/0 on every touched file, `npm run build` compiles every route + middleware. No new Redis keys (`sizeConfigs` + copy fields live on the product object in `store:products`).

- **2026-08-16 — Fast Origin Transfer drain FIXED (10GB Hobby quota burned 2.5GB in 30 min) — robots.txt + edge caching + payload shrink:**
  - **📉 Root cause found and measured against the live site.** `/api/store` served **~3.0MB per request** (product galleries + the brand logo are stored in Redis as base64 `data:` URLs, and products were duplicated across `allProducts` + each section array) and `/api/catalog/status` ~600KB — while BOTH routes returned NO `Cache-Control`, so Vercel streamed the full body from the origin on EVERY request (`private, no-cache`). The `/og` card re-rendered on EVERY request too (`max-age=0, must-revalidate`, no ETag). 2.5GB ÷ 3MB ≈ **one `/api/store` fetch every ~2s** — a crawler/bot/monitor can easily sustain that with no human traffic. (Client-side loop audit found no runaway fetch loops: the countdown draw-trigger re-fetch loop was already fixed via `dueHandledRef`; the home-page heartbeat polls every 30s but returns 25 bytes.)
  - **🚫 `public/robots.txt` — `User-agent: *` + `Disallow: /`** blocks all web crawlers while the store is in private testing (remove the file to be indexed).
  - **🗄 Base64 media moved OUT of public payloads.** New `lib/media.ts` helpers `publicMediaRef()` / `brandLogoRef()` rewrite `data:` URLs into immutable refs (`/media/<productId>/<index>.<ext>?v=<hash>` and `/media/logo?v=<hash>`); new **`app/media/[...parts]/route.ts`** streams the bytes from Redis (`Content-Type` from the data URL, `Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable`, `?v=` hash = content-address so admin image replacements get a NEW URL). Wired into `/api/store` `sanitizeProduct`, `/api/catalog/status` tile images, `/api/store` `mergePublicConfig` branding, and `app/layout.tsx` `buildLiveTheme` (the theme blob no longer carries the 57KB base64 logo on every HTML page). URLs / relative paths (`/images/...`) pass through untouched; `isVideoMedia` still detects refs by extension (`.mp4` etc.).
  - **⏱ Edge caching on every hot dynamic route** (Vercel's CDN serves the body after ONE origin render — this is the actual Fast Origin Transfer fix): `/api/store` → `public, s-maxage=10, stale-while-revalidate=30`; `/api/catalog/status` → `s-maxage=15`; `/api/config/public` → `s-maxage=30`; `/og` → `public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400` (the `?v=` cache-buster already changes the URL on branding saves); `/icon` → `max-age=86400, s-maxage=86400`. No `max-age` on the JSON routes so browsers always revalidate.
  - **✅ Measured before/after (local build against the live Redis):** `/api/store` **3,009,759 → 59,024 bytes** (~98% smaller, 0 data URLs left); `/api/catalog/status` **603KB → 5.7KB**; home HTML drops the 57KB logo blob; all 7 unique `/media` refs resolve 200 with correct `Content-Type`; `/media/logo` 200; missing media 404s; `/robots.txt`, `/og` and `/icon` serve with the new cache headers.
  - **Tests:** `tests/media.test.ts` gained 2 suites (10 assertions) for `publicMediaRef`/`brandLogoRef` (video refs stay video-detected, deterministic `?v=`, URL pass-through). `npm test` 81/81, `tsc --noEmit` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware (incl. the new `/media/[...parts]` route). No Redis keys were added or changed.

- **2026-08-16 — "Total raffle entries" fluff tick REINED IN (min 3 / max 4 per day, 2–8h spacing):**
  - **🎛 The over-inflation is gone.** The social-proof auto-tick defaults were max **15/day** with a **1h** min gap — the counter visibly exploded through the day. New defaults (all overridable from /admin → Draws → Automation → **Social Proof Counter**): **minimum 3 ticks/day** (new `autoIncrementMinPerDay` field, guaranteed), **hard cap 4 ticks/day** (`autoIncrementMaxPerDay` 15→4), **2h min gap** (`autoIncrementMinHourGap` 1→2), **8h max gap** unchanged. Updated in ALL five config paths (`goyunir.config.ts`, `lib/store-config.ts` defaults, `lib/storefront-config.ts` `defaultSocialProof`, `/api/store/config`, seed route) + the engine fallbacks in `lib/social-proof.ts`.
  - **🧠 Minimum is guaranteed AND spread across the day.** New self-contained `lib/social-proof-core.ts` (`shouldIncrementSocialProof`, `dayStartMs` — no `@/` imports so `node --test` can load it) makes the daily minimum deadline-driven: with min N/day, tick #k lands by hour `(24/N)*k` (defaults → deadlines at hour 8/16/24), so guaranteed ticks come ~2–8h apart instead of front-loading at dawn. Max-gap force (8h) and the chance dice still apply between deadlines; `min` is clamped to `max` so settings can never contradict; NaN/garbage config falls back to safe defaults.
  - **🐛 Fixed a stale-cap skip on the first heartbeat of a new day** (`lib/social-proof.ts`): the daily reset wrote `today=0` but then read the PRE-reset (yesterday's) count, so a day that had capped yesterday could skip its first tick today. The engine now restarts `ticksToday` at 0 on a day boundary.
  - **🧪 Tests:** new `tests/social-proof.test.ts` (12 cases: default cap 4, 2h min gap, 8h max-gap force, first-tick on fresh Redis, min-deadline spread, min↔max clamping, custom cadences, chance-only path when min=0, NaN safety, unparsable day stamp, and a simulated day that never exceeds 4 ticks even with always-winning dice). `npm test` 79/79, `tsc --noEmit` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware.
  - **Note for the live store:** if a saved Social Proof override already exists in `ops:overrides` (from /admin → Draws → Automation → Save Social Proof), the OLD values (max 15 / 1h gap) still win until the form is re-saved — the form now loads with the new defaults. No Redis keys were added or changed.

- **2026-08-16 — Size-selection bug FIXED (the "it keeps switching between sizes by itself" bug) + full-configuration seed showcase:**
  - **🔧 The size chips no longer switch by themselves.** Root cause: `fetchProduct()` unconditionally reset `selectedSize` to the first size on EVERY fetch, and the product page's countdown-zero draw trigger (`components/Storefront.tsx`) re-fetched ~1.5s after triggering. Because the trigger's `notified` flag was local to each effect run, a re-fetch that returned the SAME due anchor (`releaseEndsAt` still in the past — e.g. a one-shot drop that already ended, or a recurring raffle whose pool is settling) re-triggered the whole block: re-notify → re-fetch → effect re-run → loop forever, resetting the visitor's size back to size #1 every ~1.5s. Fixes:
    - `fetchProduct` now **preserves a valid `selectedSize`** across re-fetches (functional update keeps the current pick when it still exists on the product; a default is only chosen when the selection is empty or invalid) and only resets the gallery image index when the visitor actually switched products.
    - The draw-trigger block is now guarded by a **persistent ref** (`dueHandledRef` = `{ anchor, at }`) so each cycle boundary fires notify + re-fetch at most once, re-arming after 4 minutes (matching `lib/client-auto-draw.ts`'s re-arm) — the endless ~1.5s loop is gone while the "stale pool still gets nudged" safety net stays.
    - Size chips got `type="button"` (defensive — they can never submit a wrapping form).
  - **🧪 Seeds now showcase EVERY configuration.** `app/api/admin/seed/route.ts` + static `goyunir.config.ts` p1–p3:
    - **p1 Elysian White** — now a **per-product recurring raffle** (`customDropSchedule: { mode: 'custom', customIntervalHours: 12 }` — the engine rolls the timer forward every 12h after the first draw), plus **per-media `crops`** (3 crops parallel to the 3 images; photo 2 is a custom operator crop) and category tags.
    - **p2 Obsidian Void** — now a **multi-size RAFFLE**: Standard ($110, winner tiers `2,2,1`) + Collector ($175, tiers `1,1`), each size with its own winner-tier CSV.
    - **p3 Noir Citrus** — sampler credit now uses the **"Never expires"** tri-state (`neverExpires: true`, `expiresDays: null`) — the days-based expiry stays demoed by p14.
    - **p4 Amber Pulse** — **per-size inventory** (`inventoryPerSize: { 'Fabric Card': 40, 'Travel Spray': 60, 'Full Bottle': 40 }`) so the admin Inventory & Limits panel and the live states show 3 sizes × 3 stock levels (live-state seeding reads `inventoryPerSize`).
    - **All 14 products** now carry `categories` (Perfume/Unisex/Men/Women/Summer/Winter) so the /catalog filter bar + home/product category chips work out of the box.
    - Seed `DEFAULT_CONFIG` now also writes `behavior.scrollToTopOnLoad` + `refPrefix: 'GU'` explicitly.
    - **Live-state seeding honors each size's own `priceCategories[].winnerTiers` CSV** (first tier per size, falling back to product `winnerTiers[0]`) so seeded live states agree with each size's advertised draw tiers.
    - New **`validateSeedProducts()`** guard in the seed route throws loudly on a broken seed (crops↔images mismatch, sampler/inventoryPerSize keys that aren't real price categories) so a bad edit can never seed a broken catalog.
    - Docs: this changelog entry. No new Redis keys. Verified: `tsc --noEmit` clean, `npm run lint` 0/0, `npm test` 67/67, `npm run build` compiles every route + middleware.

- **2026-08-16 — Mixed-format releases (RAFFLE + FCFS on ONE product) + sampler-card contrast fix:**
  - **🎟 A product can now be BOTH a raffle AND a direct-sale at the same time — per-size.** Each row in **Pricing & Sizes** gained a per-size mode select (**Auto (product) / 🎟 RAFFLE / ⚡ FCFS**). Leave it on Auto to follow the product-level Checkout Mode, or mix formats — e.g. the sampler sells instantly while the full bottle runs a raffle. Stored as `checkoutMode` on each `priceCategories[]` entry (persisted through `/api/admin/products`; the admin route sanitizes it to `RAFFLE`/`FCFS`/removed). No new Redis keys.
  - **🧭 One resolver, every consumer agrees.** New self-contained `lib/checkout-mode.ts` (`getSizeCheckoutMode(product, size)` / `hasMixedCheckoutModes` / `sizeCheckoutModes`, re-exported from `@/lib/storefront-config`). Wired into: the product page (CTA, countdown, add-to-bag, badges), `/api/checkout` (single product), `/api/checkout/cart` (per-line partition into the FCFS payment session + raffle setup session — mixed carts already created two sessions), and `lib/auto-draw.ts` (**FCFS sizes are NEVER drawn** — a stale/forced FCFS pool is skipped before the due-check so it can't be drawn or have its timer rolled forward).
  - **🖼 Storefront tells the story.** The product page shows the selected size's mode pill (RAFFLE / FCFS, plus a purple **MIXED** pill when the product mixes formats) and a mixed-format ribbon ("2 raffle sizes and 1 instant-buy size — pick a size above"). Size chips carry tiny `raffle`/`buy` tags (adaptive colors per theme). The sampler card shows an **INSTANT BUY** badge when the selected sampler is FCFS, and the CTA flips between "Enter allocation" (raffle size) and "Secure piece · $X" (FCFS size).
  - **📋 Catalog, home + admin badges.** `/api/store` now passes per-size `checkoutMode` through `priceCategories[].checkoutMode`. Home product cards and catalog tiles show a **RAFFLE + FCFS** pill for mixed products; the admin Drops list shows a MIXED pill and the Checkout Mode card shows a live "N raffle · M instant-buy" summary (with override count).
  - **🎨 Sampler-card contrast FIXED (the "sample note stuff is super hard to read" complaint).** The trial card, math strip, size-chip sample badge and nudge previously used hardcoded light-green text (`#a7f3d0`, `#4ade80`…) that vanished on light themes. They now use an **adaptive green palette** computed from the card surface's luminance: light cards get deep forest greens (`#14532d`/`#166534` on `#f0fdf4`), dark cards get bright mint (`#d1fae5`/`#4ade80` on translucent green). The customer-facing sampler note font-size was bumped 10 → 11 for legibility.
  - **🧪 Seeded demos now show the feature.** Noir Citrus (p3) and Gilded Hour (p14) are now **mixed-format**: the sampler/Discovery Kit size is FCFS instant-buy, the Full Bottle (and Grand Size) run raffles with winner tiers. Static `goyunir.config.ts` p3 updated to match.
  - Tests: new `tests/size-checkout-mode.test.ts` (9 cases). Verified: `npm test` 67/67, `npm run typecheck` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware.

- **2026-08-16 — Per-size sampler ("trial SKU") engine — the "Try a sample first" line is no longer one generic message for everything:**
  - **🎯 Mark ANY size as a sampler right in Pricing & Sizes.** Each size row gained a **"🧪 Sample" toggle chip** (green when on). Toggling it adds/removes a `samplerSizes` record for that size — no more "Trigger on size(s) CSV" free-text. Renaming a sampler size re-syncs its record (and any "credits toward" pointer); deleting a size prunes its sampler. Editing a product saved with the old CSV **auto-promotes** legacy trigger sizes into per-sampler records so nothing is lost.
  - **⚙️ "Trial sizes & sample credits" panel (replaces "Post-delivery credit").** Product-level **defaults** (credit $, min next-order $, never-expires + days, code prefix, eligible products/sizes) stay as the fallback, then **one setup card per sampler size**: badge label (Trial / Discovery / Mini), **"Credits toward"** (pick the exact full-size SKU, or "any next order"), per-sampler credit $, per-sampler min order $, tri-state expiry (use default / never / N days), per-sampler code prefix, customer-facing note, and per-sampler eligible products/sizes — every field blank = uses the product default.
  - **🧮 Storefront now tells EACH sampler's own story** (`lib/sampler-config.ts` → `samplerPresentation`): the selected sampler gets a headline ("Try the Trial first"), copy that names its exact size + credit + upgrade target, and a **math strip** (`Sample $19 → credit −$15 → Full Bottle $130`) with a progress bar showing what % of the full size the credit covers. Selecting a **non-sampler** size shows a gentle "Want to try it first?" nudge instead of the full card. Size chips carry the green **🧪 badge** (e.g. "Trial", "Discovery"). No more identical line for every size.
  - **📦 Delivery credits are issued per-sampler.** `/api/admin/update-shipping` + `/api/admin/shipping-status` resolve the effective sampler config via `resolveSamplerConfig()` (per-sampler overrides win; product defaults fall back; legacy `deliveryIncentiveTriggerSizes` still work), so a big-credit sampler and a small-credit sampler on the same product issue different credits/codes.
  - **🧪 Seeded demos** — Noir Citrus ("Sampler Set" → Trial → Full Bottle, $15 credit) and Gilded Hour ("Discovery Kit" → Discovery → Full Bottle, $20 credit) ship with full per-sampler configs; `goyunir.config.ts` static catalog updated to match.
  - **Backward compatible:** `deliveryIncentiveTriggerSizes` is now a *mirror* of `samplerSizes` on save, so old consumers still see the right sizes; products without `samplerSizes` render exactly as before.
  - New file `lib/sampler-config.ts` (types + `normalizeSamplerSizes` / `isSamplerSize` / `resolveSamplerConfig` / `formatMoneyCents` / `samplerPresentation`); new `tests/sampler-config.test.ts` (10 cases). No new Redis keys (`samplerSizes` lives on the product object in `store:products`). Verified: `npm test` 58/58, `tsc --noEmit` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware.

- **2026-08-16 — Everything-you-asked-for mega-pass (categories · share-card studio · streamer overhaul · emails/ledger fix · ref prefix · per-size inventory · credits · Mapbox enforcement):**
  - **🏷 PRODUCT CATEGORIES — createable & deletable.** New admin list under **Settings → Catalog → Product categories** (add/rename/delete chips, pre-seeded: Perfume · Clothes · Shoes · Food · Tools · Tires · Pastries · Beanies · Winter · Summer · Men · Unisex · Women). Products get a category picker in the product form (multi-select chips) persisted as `product.categories`. The **/catalog page has a category filter bar** (All categories + each tag) that filters live/upcoming/archive sections, and home cards + the product page render category chips. Stored inside the existing `store:config.catalog.categories` (no new Redis keys). Deleting a category never destroys product tags — the chips just stop filtering.
  - **🃏 SHARE-CARD STUDIO — full composition control.** New Branding & Share → **"Share card style"** panel: **layout** (classic / split-with-image / minimal-centered), **typeface** (system / serif), **title size** (36–92px), **description size** (18–42px), **glow intensity** (0–100), **corner radius** (0–64px), **image darkness** (0–100) and show/hide toggles for **logo / tagline / site URL**. Wired through `lib/share-card-config.ts` (`ShareCardOptions` + `normalizeShareCardOptions`), `components/ShareCard.tsx` (renders all three layouts), `/og` (server PNG), `app/layout.tsx` (`CARD_REVISION 7→8` so messengers re-fetch) and `components/LinkPreviewGallery.tsx` (previews are now pixel-faithful to the unsaved form: correct domain, tagline row, options honored, shareUrl used for the card domain). Share-field inputs got friendly labels/placeholders/hints (`SHARE_FIELD_META`).
  - **📧 EMAILS + LEDGER FIXED for real (the "entered 2 raffles thru cart, no email, nothing on ledger" bug).** Root cause: the Stripe webhook's setup branch only read `meta.variant`/`meta.size` — a `raffle_cart` session's `meta.variant` is EMPTY, so the webhook skipped the whole branch and never wrote a ledger row or sent the email. The webhook now expands `meta.cartItems`, locks/archives/sends **per line**, and **only marks `entries:email_sent` when the email actually sent** (a skipped/failed send used to be deduped forever). `/api/checkout/confirm-setup` gained a **repair path**: when the webhook raced ahead but its email failed, confirm-setup re-checks each secured line and sends the confirmation email with fresh account context. Order refs now appear in the email subject.
  - **🧑‍🎓 Account-context emails.** Entry-confirmation, winner (`lib/auto-draw.ts` + `/api/admin/trigger-drop`) and recovery emails look up the CURRENT `store:users` state at send time and render the right CTA: account = "Manage account / your balance is X points", guest = "Create a free account" (with the email prefilled into `/auth/signup?email=…`). If a customer entered as a guest and later created an account, every follow-up email reflects it.
  - **🔖 Order refs now start `GU-` (configurable).** `lib/order-ref.ts` default prefix is `GU-` (was `GY-`), with `normalizeRefPrefix()` sanitizing an admin-set prefix (uppercase A-Z0-9, ≤4 chars). New **Settings → Checkout & Orders → Reference code prefix** field; every checkout/webhook/auto-draw/trigger-drop route reads `store:config.refPrefix` and passes it through `buildOrderRef`/`formatOrderRef`. Legacy `GY-`/`GOY-` refs are re-labelled to the configured prefix automatically.
  - **🛡 Streamer Mode overhauled.** It now ONLY masks — it never blocks. The **"Reveal addresses" button is removed**; every PII value is masked with **fixed-length bullet strings** (even the character length of an email/address/card can't leak). The password stays in memory across toggles (**no retyping when disabling**), the password field shows a fixed `••••••••` mask while streaming, and **every action (saves, draws, edits, wipe) works while masked** — the password field is the only thing locked, so a password can never be typed on a livestream.
  - **📌 "Save Product / Cancel / unsaved-changes" is now a sticky bar** exactly like Save All Settings (`position: sticky; top: 92`) — no more scrolling a long product form to save a one-field tweak.
  - **📦 Per-size inventory.** When a product has multiple sizes/colours in Pricing & Sizes, **Inventory & Limits shows a per-size stock editor** (`inventoryPerSize` map on the product). Live states seed per-size stock through `getLiveProductState`/`getOrSeedLiveState` (blank = fall back to Total inventory). `2 different sizes = 2 different inventories`, exactly as asked.
  - **💳 Credits: "Never expires" toggle + real expiry + field explainers.** Post-delivery credits now have a **"Never expires" checkbox** (validity-window days hidden when checked), the validity window is ACTUALLY applied (`timeLimited` + `endAt` set on the generated promo — previously the days field was ignored and credits were immortal), the code-prefix fallback is brand-neutral `DROP-` (was `GOY`), and **Code prefix / Trigger on size(s) CSV / Eligible product slugs CSV / Eligible size(s) CSV** each got a plain-English explanation under the input.
  - **🗺 Address updates require the Mapbox dropdown (admin-overridable).** New **Settings → Checkout & Orders → "Require full address dropdown at checkout"** (default ON). Customer "update address" flows (`/api/account/update-address`, `/api/address/save`) reject partial addresses with the friendly dropdown message when ON; the **admin portal always overrides** (its update-address route saves any address). The /account address editor is now a `<form>` + `autocomplete="shipping street-address"` so the Mapbox SDK attaches to it too.
  - **✍️ Placeholder-text pass.** Registration Form + Footer inputs got context-aware placeholders ("e.g. Join The Allocation Draw", "https://instagram.com/yourbrand", …), the share fields got labeled hints, and the Setup checklist's Streamer Mode copy was updated.
  - Docs: AGENTS.md + README updated in the same change set. No new top-level Redis keys (categories live in `store:config.catalog.categories`, refPrefix in `store:config.refPrefix`, checkout policy in `store:config.checkout`; `inventoryPerSize`/`categories` live on the product object in `store:products`). Verified: `npm test` 48/48, `tsc --noEmit` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware.

- **2026-08-15 — Share card FIXED for real (Vercel env placeholder) + 2FA autofill & notification codes:**
  - **🃏 THE share-card bug.** The live site's `og:image`/`og:url`/canonical tags were `https://$vercel_project_production_url/og…` — a Vercel dashboard env-var PLACEHOLDER had leaked into a configured URL variable (`NEXT_PUBLIC_URL` or an alias). The WHATWG URL parser accepts `$` as a hostname character, so `getSiteUrl()` happily returned it as a "valid" base and every link preview pointed at a NONEXISTENT domain — messengers could never fetch the card, no matter how many times the card code itself was fixed. **Fix:** `getSiteUrl()` (`lib/env.ts`), `normalizeSiteBase()` (`lib/url-utils.ts`), `getRequestSiteUrl()` (`lib/request-url.ts`), `cardSiteUrlDisplay()` and `previewSiteUrl()` (`lib/share-card-config.ts`) now ALL treat any value containing `$` as unset and fall back through env → request host → neutral placeholder. A deployed store with the placeholder still in the env will now serve the REAL request-host domain (`https://goyunir.com/og?...`) automatically — no Vercel dashboard change required. `CARD_REVISION` bumped 6→7 so the og:image URL changes and WhatsApp/iMessage/Discord re-fetch. Tests: 5 new cases in `tests/env.test.ts` + `tests/url-utils.test.ts` + `tests/share-card-config.test.ts` (39/39 pass).
  - **📱 2FA "autofill + read from notifications" — done.** (a) The one-time code now lives in the email **SUBJECT** (`… — Admin sign-in code: 482913`, same for customer verify emails), so it shows right in the phone's push-notification preview and the mailbox list — no opening the email. (b) The code fields (admin gate + signup verify step + /account verify card) are proper OTP fields: `autocomplete="one-time-code"`, `inputMode="numeric"`, `pattern="[0-9]*"`, `autoFocus`, and the WebKit `textContentType="oneTimeCode"` property set via ref (React's web typings don't expose it) — iOS/Android show a one-tap autofill suggestion above the keyboard the moment the email lands. (c) **Auto-verify**: as soon as all 6 digits are present (typed, pasted, or autofilled) the code submits itself — a per-gate `lastSubmittedCodeRef` guards against re-submitting a wrong code, and resends reset it. (d) A "📋 Paste code from clipboard" button covers the desktop path. The gate copy now says exactly where the code is.
  - Docs: AGENTS.md updated (admin 2FA section + URL/placeholder section + this changelog). No Redis keys were added or changed. Verified: `npm test` 39/39, `tsc --noEmit` clean, `eslint` clean on every touched file, `npm run build` compiles every route + the proxy middleware, and the dev server hot-reloads the new card hash (`961bb98c` → `9a198141`).

- **2026-08-15 — Finalization & polish pass (all reported issues):**
  - **📈 "Total raffle entries not inflating thru the day" — FIXED.** The auto-increment only ran on the authenticated cron route (`/api/analytics/social-tick`), and Vercel Hobby allows max ONE cron run per day — so the boost never ticked during the day. New shared engine `lib/social-proof.ts` (`maybeAutoIncrementSocialProof`) is now called by BOTH the cron route AND the PUBLIC `/api/analytics/heartbeat` (rate-limited 120/min/IP) the home page calls on every load — so real visitor traffic nudges the counter upward through the day, with hard daily caps/gap windows that a script can't blow past. Defaults bumped (chance 0.15→0.18, amount 1→2, max/day 4→15, min-gap 3h→1h) in all five config paths (static + seed + `/api/store/config`), and the home page now POLLS the heartbeat every 30s so the displayed count refreshes live. The cron `social-tick` route is unchanged in behavior (same shared engine).
  - **📱 2FA "Remember this device for 30 days" checkbox — FIXED for mobile.** The label-wrapped controlled checkbox could be flaky on iOS/Android (tap lands on the text, not the input). The row now has `htmlFor`/`id`, and the label's `onClick` forces the toggle (preventDefault + setState) when the tap misses the input — so it always checks/unchecks when pressed.
  - **🖼 Product media formats — EXPANDED.** The products panel now accepts **PNG · JPEG · JPG · SVG · WEBP · GIF · BMP** (photos auto-compress) AND **videos: MP4 · MOV · MKV · AVI · WEBM** (stored as-is). `compressImageFile` keeps SVG/GIF/video bytes original (canvas would destroy transparency/animation; videos can't rasterize). `/api/admin/upload` validates MIME/extension (415 on unsupported), keeps 6MB image / 18MB video caps, and stores `data:video/…` URLs. The format list is shown right under the file input.
  - **🎬 Videos to the site.** Product galleries, home cards and catalog tiles render `<video>` for video items (muted looping cover on cards; inline controls on the product page + catalog modal). Admin thumbnails show a ▶ badge.
  - **⏳ Save locked while uploading.** New `imageUploadBusy` state disables "Save Product" (label flips to "Uploading…" with a spinner + per-file progress) and `saveProduct` refuses to run mid-upload — a product can never be saved with a half-finished media list.
  - **✂️ Post-crop preview (computer + mobile) with adjustable crop + aspect labels.** New `lib/media.ts` (isVideoMedia, normalizeCrop, coverStyle, aspectRatioLabel) + `CropEditor` in the products panel: for every photo you can drag to pan, zoom with a slider, and see TWO live previews labeled with the aspect ratio each device uses — **Computer · 2:1 (560×280)** and **Mobile · 1.17:1 (328×280)** — exactly what the product page renders. Crops are stored per-media in a parallel `product.crops` array (wired through `/api/admin/products`, `/api/store` sanitizer, `lib/storefront-config.ts`) and applied 1:1 on the product-page gallery via `coverStyle`; default crop = classic centered cover + Ken Burns, so existing products are unaffected.
  - **✏️ 'Handmade allocation. Low supply by design.' / 'Reserved for collectors moving early…' now admin-editable.** New Storefront copy overrides in Settings → Storefront copy: `urgencyInStock`, `urgencySoldOut`, `statusLive`, `statusArchived` (leave empty = built-in). Wired into the product page.
  - **🗓 'Repeat this raffle on a schedule while inventory remains' explained.** The admin product form now says the cadence only starts AFTER the "Countdown ends at" timer hits zero (first draw fires on that timer, then the cadence rolls forward), and tells the operator to clear "Countdown ends at" to start the raffle at release.
  - **🃏 Link preview / share card.** `cardSiteUrlDisplay` hardened (can NEVER return '' / a scheme-only `https:` leftover). The admin preview now prefers the configured Branding → Share URL so the top-right domain shows the REAL production domain even on localhost. Cleaned the buyer's live `store:config.branding` (shareImageUrl/shareTitle/shareTagline were literally `goyunir.com` — not an image). `CARD_REVISION` bumped 5→6 so WhatsApp/iMessage/Discord re-fetch.
  - **🎨 'Live preview — top bar & footer' rebuilt to match the real SiteChrome** — glass chrome background (chromeTransparency + color-mix), readable auto-picked header text, MORE pill, centered logo+name per headerMode, account + Bag/Cart icons, and the real footer (Terms/Privacy/Shipping/Manage My Entry, social links, tagline, copyright).
  - Tests: `tests/media.test.ts` added (9 cases); `npm test` 36/36, `tsc --noEmit` clean, `eslint` clean on every touched file. Docs: this changelog + namespace notes. No new Redis keys (crops live inside the product object; the boost/tick state reuses `analytics:ticks`).

- **2026-08-15 — CRITICAL: "I entered after the countdown restarted and got charged early" is fixed forever + custom per-raffle intervals (lead engine work):**
  - **💥 Cycle-aware draws.** The draw engine (`lib/auto-draw.ts` → `evaluatePoolDue`) now treats the persisted `releaseEndsAt` as the cycle boundary and draws ONLY entries whose `registeredAt` is before it (`splitEntriesByCycleEnd` in `lib/drop-timestamps.ts`). Root cause of the bug: when a cycle ended with an empty pool (or a missed draw), the product's persisted `releaseEndsAt` stayed in the PAST while the storefront showed a read-time "new countdown" — the next trigger drew EVERYTHING in the pool, including a customer who had just entered for the NEW round, and charged them. Now: post-cycle entrants are carried over untouched (they can never be charged before the timer they saw hits zero), and a stale recurring cycle with no eligible entries simply rolls `releaseEndsAt` forward WITHOUT drawing. This also fixes the "empty pool at cycle end → first entrant instantly charged" case. New `entries:pool` writes already carry `registeredAt`; legacy entries without one stay eligible so they're never stranded.
  - **⏱ Custom per-raffle interval: "each raffle per hour/day/week/month/X hours" per ITEM.** New `custom` schedule mode on the global cadence AND per-product: `customIntervalHours` (1–720). Wired through `DropScheduleConfig` (both type unions + defaults in `lib/storefront-config.ts`, `lib/store-config.ts`, `goyunir.config.ts`, seed + `/api/store/config`), `getDrawIntervalMs`, `getNextDrawTimestampForSchedule` (rolling fixed-interval anchors that always land in the future), `evaluatePoolDue`, and the admin schedule forms (global Draws→Automation + per-product Raffle schedule).
  - **🧭 Roll-forward always lands in the future.** The deferred roll-forward advances from `max(cycleEnd, now)` so a run that catches a stale cycle late skips past any intermediate missed anchors instead of chasing them one per run.
  - **Tests:** `tests/auto-draw-cycle.test.ts` (6 cases) proves the splitter protects post-cycle entrants and never strands legacy entries. `npm test` 32/32, `npm run typecheck` clean, `npm run lint` 0/0, `npm run build` compiles every route + middleware.
  - Docs: this changelog entry + the Auto-draw section above updated. No Redis keys were added (existing `entries:pool:*` entries already carry `registeredAt`).


- **2026-08-15 — Orb glow premium pass + preset identity sweep + global polish (orb-presets-globals):**
  - **✨ Glow orbs read as light, not blobs.** `orbGradient()` in `components/SiteChrome.tsx` now uses a smooth multi-stop eased falloff (gaussian-like) that is FULLY transparent by ~62% of the radius (58% for the cart-drawer orbs) instead of the old 72%/60% hard-ish taper — so every orb reads as a seamless ambient wash. Overlapping orbs now ADD their light via `mix-blend-mode: screen` on dark themes (light themes keep plain compositing) — the high-end glow harmony where intersections brighten instead of one disc covering another. Explicit opacity 0 still renders nothing.
  - **🎢 More alive-but-tasteful motion.** Added smoothed pointer VELOCITY tracking (`pointerVelX/YRef`): fast flicks now inject real momentum into the springs, so the small accent layers visibly overshoot the stopping point and settle back (gated off entirely for `prefers-reduced-motion`). Idle drift is now a 3-harmonic Lissajous wander over the gentle random retarget (never-repeating, organic). Each layer gained a `parallax` factor — a subtle scroll-depth offset (big ambient layers drift slightly more than small accents), gated by `reducedMotion` and the admin `scrollEnabled` switch. `maxVel` raised 0.085 → 0.105 (still no teleporting), impulse scale nudged up, accent-layer friction lowered for a springier bounce. Idle-throttle (~7fps writes) and the direct-DOM-writes architecture are unchanged.
  - **📱 Mobile stays strong, not overpowering.** Mobile orb boost dialed 1.7×/1.4× → 1.6× opacity / 1.35× size (the softer gradient keeps it a wash). Default orb palette aligned to the Apple preset's system colors (`#0071e3` / `#bf5af2` / `#ff9f0a` / `#64d2ff` / `#ff375f`, opacities 6–14).
  - **🎨 Presets verified + identity sweep.** All 11 presets in `lib/theme-presets.ts` re-verified with WCAG relative-luminance math: every `textMain`/`textMuted` vs `primaryBackground` and `cardTextMain`/`cardTextMuted` vs `cardBackground` pair clears AA comfortably (worst preset ≈ 9.3:1 — no regressions from prior contrast passes). Apple preset `backdropBlur` 88 → 86 so every preset sits in the Liquid-Glass band (radius 18–26, squircle, blur 76–86, chrome 56–68, shadow 14–18, hairline borders 0.14–0.20). Monochrome + Warm Paper orb opacities nudged into the 8–16 band (mains) while keeping whisper accents.
  - **🧹 Global polish** (`app/globals.css`): focus-visible is now a soft double halo in system blue (`rgba(0,122,255,…)` — visible on light AND dark surfaces, still glow-style); `::selection` tint + input `caret-color` aligned to system blue; scrollbar thumbs are slim padding-box capsules; `--font-sans` theme token now matches the body stack (adds `SF Pro Display` + `Helvetica`); `prefers-reduced-motion` also forces `scroll-behavior: auto`.
  - Docs: this changelog entry. No Redis keys were added or changed. Verified: `npx tsc --noEmit` clean, `npm run lint` 0/0 (full project), `npm test` 32/32.

- **2026-08-15 — Security hardening + brand-cleanliness sweep (security-brand):**
  - **🔐 Stripe webhook is now STRICT.** `/api/stripe/webhook` previously parsed the raw JSON body whenever `STRIPE_WEBHOOK_SECRET` or the `stripe-signature` header was missing — anyone could forge a `checkout.session.completed` event and fabricate WINNER_CHARGED ledger rows, decrement inventory, award points, or lock entries. It now REQUIRES a valid signature in production; unverified parsing is only possible in non-production with an explicit `DEV_WEBHOOK_BYPASS=1` env flag. Also added: 1MB payload cap, generic 400 responses (no internal error echo), 50KB cap on cart metadata, length clamps + email-format validation on every session payload, and invalid payloads are marked processed so Stripe retries can't wedge. Webhook logs now mask customer emails (`maskEmail`) — never full addresses.
  - **🧹 Brand leakage fixed:** winners CSV download was named `goyunir-winners-*.csv` → now `winners-*.csv`; the delivery-incentive promo-code generator defaulted to a customer-visible `GOY-…` prefix → now neutral `DROP-…` (both admin routes); stale "falls back to GOYUNIR" comment in `lib/server-config.ts` corrected. The `GOYUNIR_STORE_SUITE` export name is unchanged (internal); its VALUE was already neutral. The only remaining `GOYUNIR` strings are internal identifiers (cookie names, CSS classes, event names, `__GOYUNIR_THEME__`) — not customer-facing text.
  - **📁 CSV formula-injection fix:** winners export now defuses spreadsheet formulas (`=`, `+`, `-`, `@`, tab, CR) in customer-supplied cells so a crafted email/address can't execute in Excel/Sheets.
  - **🕐 Rate limiting added to every public write endpoint** via a new shared `lib/rate-limit.ts` (`isRateLimited` / `rateLimitedResponse`, generic `cache:rate:<namespace>:<ip>` keys in `lib/redis-keys.ts`): checkout (20/min), checkout/cart (20/min), checkout/direct (10/min), confirm-setup (20/min), alerts/subscribe (10/min), address/save (20/min), signup (10/min), login (20/min), verify-email (10/min), resend-verification (10/min), forgot-password (10/min), reset-password (10/min), redeem-points (10/min), change-password (10/min), promo validate/track (30/min), promo validate non-quiet (60/min), analytics heartbeat (120/min, generous so multi-tab visitors are never tripped). Auto-draw's existing limiter is unchanged. A limiter hiccup never blocks a legit request (fail-open by design).
  - **🔑 Auth hardening:** login + change-password now compare scrypt hashes with `timingSafeEqual` (was `!==`); all 6-digit verification codes (admin 2FA + customer verify) now use `crypto.randomInt` and the stored hashes are compared in constant time (was `Math.random` + `===`); welcome/reward/delivery promo-code suffixes now use `crypto.randomBytes` (was `Math.random`). Proxy Basic-Auth comparison is now constant-time (XOR-based, Edge-safe) for username AND password. Signup/login/verify/reset validate email format + password bounds (6–128) and guard `request.json()`.
  - **🚫 No internal error leakage:** every public + customer-facing route now returns a generic message instead of `err.message` (checkout, cart, direct, confirm-setup, store, store/config, catalog/status, stock, alerts, address, account/*, auth/*, heartbeat, auto-draw, cron/recovery, admin seed — which also dropped `stack: err.stack`). Details are logged server-side only. No API returns Redis errors verbatim anymore.
  - **🛡 Misc:** `confirm-setup` email-failure log no longer logs the customer email; `/api/cart/sync` caps stored carts at 100 items with field-length limits; forgot-password returns the same generic response for unknown/invalid emails (no account enumeration); admin routes remain fully gated by proxy.ts (Basic Auth + 2FA device cookie) — `env-status`/`status`/`verify-status` have no in-route check but are unreachable without the proxy's two gates.
  - Docs: AGENTS.md namespace map updated for the generic `cache:rate:*` keys. Verified: `tsc --noEmit` clean, `npm run lint` clean for every file touched (the only remaining lint errors/warnings are in `app/admin/page.tsx`, owned by the admin-portal teammate), `npm test` passes.

- **2026-08-15 — Start-at-top setting + share-card Vercel-domain fallback + multi-line text fields + bag/cart live-switch + active drawer & mobile orbs + button-corner artifact pass:**
  - **🧭 "Site opens mid-page" fixed AND made configurable.** New admin setting **Settings → Behavior → "Start at the top when the page opens"** (default ON), persisted as `store:config.behavior.scrollToTopOnLoad`. When ON (default) `SiteChrome` sets `history.scrollRestoration = 'manual'` and `scrollTo(0,0)` in a `useLayoutEffect` (before first paint — no mid-page flash), plus a `pageshow` handler so back/bfcache restores also reset. Turn it OFF to let the browser restore the visitor's last scroll position. Wired through `store-config.ts`, `/api/store` (`mergePublicConfig`), `/api/admin/settings`, `ThemeProvider` + the layout theme blob, and the admin form.
  - **🔗 Share-card/link-preview domain fallback.** `lib/env.ts` `getSiteUrl()` now falls back to Vercel's system variables `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` (bare hostnames normalized to `https://…`) when `NEXT_PUBLIC_URL`/`NEXT_PUBLIC_SITE_URL`/`SITE_URL` are unset — so metadata/`og:image`/email URLs always resolve the store's REAL production domain, never `https://example.com`. `CARD_REVISION` bumped `4 → 5` so messengers re-fetch the card after this deploy. Verified `/og` → 200 `image/png` with the new `?v=7ccbdedd` hash.
  - **📝 Multi-line text everywhere.** Hero Content + Storefront copy prose fields are now **textareas** (headline, body, eyebrow, story footer, heroTitle, heroSubtitle, priorityDropsSubtitle, footerTagline) and the home hero h1/p/eyebrow, priority-drops subtitle and footer tagline render with `white-space: pre-line` — so `by our hands.\nto your hands.` shows exactly that on the page.
  - **🛍 Bag/cart icon now switches LIVE (admin preview + storefront).** The admin "Top-right action label" select writes `goyunir-header-action-mode` to localStorage and dispatches a `goyunir-header-action-mode` event; `SiteChrome` listens (plus the `storage` event) and uses the override so the header icon, tooltip, drawer title and empty-state wording swap the instant the buyer toggles the select — before Save. The localStorage write no longer clobbers a valid override on mount. The product page's "Add to {bag|cart}" already reads the same key, so everything agrees.
  - **✨ Cart/bag drawer orbs are back and ACTIVE.** The drawer now paints 3 compact soft-gradient orbs (primary/secondary/tertiary colors from admin → Orb Glow) behind the content, each with its own slow CSS drift animation (`goyunirOrbDriftA/B/C` — pure transform, compositor-only, zero per-frame JS) and boosted opacity (~1.8–2.2×) so the panel feels alive.
  - **📱 Orbs are stronger on mobile.** Background orbs get ~1.7× opacity and ~1.4× size below 768px (capped), so the home page glow reads as strongly on a 390px phone as it does on desktop.
  - **🧹 "Weird outlines around product buttons/corners" pass.** (a) Global `button { appearance: none; -webkit-appearance: none; }` — kills iOS Safari's native button chrome that paints corner rectangles on styled buttons; (b) `-webkit-tap-highlight-color: transparent` on `a`/`button` — the purple UA tap rectangle tinted the SQUARE bounding box of rounded card links, leaving visible corner outlines on mobile; (c) catalog tiles now use the theme's `cardShadowStyle` instead of the hardcoded `0 12px 30px rgba(0,0,0,0.16)`; (d) home/catalog card `<Link>` wrappers got `display: block` + the card's `borderRadius` so focus rings and overflow follow the rounded corners.
  - Docs: this changelog + AGENTS.md settings/env sections updated in the same change set. No new Redis keys (behavior lives under the existing `store:config`). Verified: `tsc --noEmit` clean, `eslint` 0/0 on changed files, `npm test` 26/26, and live CDP checks — reload restores `scrollY=0`, bag↔cart event swaps the header icon, drawer renders 3 animated orbs, mobile orbs render at 81.2vw (1.4×), hero h1/p computed `white-space: pre-line`, `/og` 200 `image/png`.


- **2026-08-15 — Final polish for production sale: flat Liquid Glass + top-bar color settings + desktop-swipe fix + cart/bag icon sync + Redis hash consolidation + admin reorganization + richer demo seeds:**
  - **🎨 Top bar has its OWN color settings now.** New `themeColors.headerBackground` / `headerText` tokens (Settings → Theme Colors → **Top bar**). Empty = auto (headerBackground matches the card surface, headerText is auto-picked readable). Every one of the 11 presets carries header colors; the admin UI has friendly labels + Auto-reset buttons for every theme color input.
  - **🪟 Liquid Glass is FLAT — no more ugly gradient.** The painted specular sheen on the header/drawer/toasts made a dark top bar wear a bright white band even when nothing was behind it. `glassSurfaceStyle` + the `.liquid-glass` utility + the banner/toast gradients now use a hairline top light only; the frosted backdrop-filter is the sole "glass" and only shows when real content scrolls underneath. White AND black chrome both look clean now.
  - **🖱 Desktop image-swipe "stuck" bug fixed** (`components/Storefront.tsx`): the gallery used per-element pointerup, so releasing the mouse button off-element (fast drag off the photo, release outside the window, lost capture) left the photo dragged and the cursor "trying to scroll". The drag is now a ref-based state machine with WINDOW-level pointerup/pointercancel/blur listeners, explicit `releasePointerCapture`, right-click ignored, and an unmount cleanup.
  - **🛍 Cart/Bag icon + wording now consistent EVERYWHERE.** The admin "Top-right action label" (Cart vs Bag) switches the header ICON (cart vs bag SVG) AND every word: header tooltip, drawer title + empty state, product-page "Add to {bag|cart}" button + toast messages. Added a hint in the admin so buyers know it's site-wide.
  - **✨ Orbs more tasteful + GONE from the cart.** Default orb opacities lowered across every config path (primary 16→12, secondary 26→15, tertiary 12→8, fourth 10→8, fifth 8→6) and the entire cart-drawer orb layer + animation was removed (drawer is now clean dark glass). The stale `topBar` orb entry was purged from the store config defaults.
  - **🗄 Redis is NEAT — the key space no longer grows per user / per product / per size.** Consolidated the high-churn namespaces into single hashes: `store:carts` (field = user id), `entries:last_auto` (field = `variant:size`), `ops:overrides` (fields `schedule`, `social_proof`, `product:<id>`), `analytics:ticks` (fields `last`/`today`/`day`), and the admin 2FA counters now live INSIDE the `admin:verify:<email>` payload (no `admin:verify_attempts:*` / `admin:send_attempts:*`). A store with thousands of customers keeps the same fixed set of keys. **Tidy Redis Schema** gained a v2 folding step (lossless, safe to re-run) and the **Site Self-Test** flags any leftover `ops:override:*` / `store:cart:*` / `entries:last_auto:*` / `analytics:ticks:*` / `admin:verify_attempts:*` / `admin:send_attempts:*` keys.
  - **🖥 Admin portal reorganized Apple-style.** The tab bar is now grouped into **Store** (Overview, Drops, Products, Ledger) / **Customers** (Users, Promotions, Growth) / **Configuration** (Settings, System, SetUp) with small uppercase group labels and pill transitions. Theme-color inputs use friendly names ("Page background", "Text on cards", …) instead of raw camelCase, and the new Top bar section has Auto buttons.
  - **🖼 Richer seeded demos.** Every seeded product now ships a 3-photo gallery (brand-neutral gradients generated with sharp at `/images/*/1-3.jpeg`) so the swipe/arrows demo works out of the box; the catalog preview gained a Solar Drift upcoming entry + Atlas Bloom archive. The 14 seed products keep their full "Why this drop matters" explainers.
  - Docs: AGENTS.md namespace map + changelog + README updated in the same change set. Verified: `tsc --noEmit` clean, `eslint` clean (0/0), `npm test` 26/26, and `npm run build` compiles every route + middleware.

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


