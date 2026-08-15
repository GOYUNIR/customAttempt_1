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
| `auth:` | Auth tokens + verification challenges | `auth:session:<token>` (ttl string), `auth:reset:<token>` (ttl string), `auth:verify:<email>` (ttl string) |
| `admin:` | Admin-only data + two-step verification state | `admin:audit_log` (list), `admin:verify:<email>` (ttl string), `admin:devices` (hash of verified device tokens — one key, not one per browser), `admin:verify_attempts:<email>` / `admin:send_attempts:<email>` (ttl strings) |
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
  reading `process.env.*` directly** in customer-facing code.

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
  - **Share/OG card follows design presets** (`app/opengraph-image.tsx`,
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


