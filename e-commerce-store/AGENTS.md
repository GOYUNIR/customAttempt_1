<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# GOYUNIR PROJECT — COMPLETE AGENT INSTRUCTIONS

## Project Overview

GOYUNIR is a raffle/drop allocation storefront built on Next.js with Redis as the primary data store. **All day‑to‑day operations are performed via the admin portal at `/admin`** — no code changes should ever be needed for normal operation.

## Architecture

### Data Storage
- **Redis** is the source of truth for ALL store data
- Products, config, settings, and entries are stored in Redis
- **No fallback catalog is served** – if Redis is empty the storefront shows **0 items** until products are seeded via `/admin` (Seed Defaults or Add Product).

### Key Redis Keys

The store uses a **single source of truth** model — products and settings each live in exactly ONE key, and the storefront derives views (active/archived/upcoming) by filtering at read time. There are NO mirror hashes or duplicate image keys to keep in sync.

- `store:products` (hash) – THE canonical product records. All `images` (including base64 uploads) live inside each product object.
- `store:config` (string) – THE canonical site configuration: colors, hero, footer, drop schedule, social proof, branding, `catalogPreview` (upcoming/archive groupings), orbs, etc.
- `drop_pool:*` – Entry pools for each product/size
- `intent_pool:*` – Pre-payment intent pools for each product/size
- `archive:ledger` – Permanent entry history
- `address:submissions` – Addresses captured by the standalone address form (`/address-checkout-form.html`)
- `live_state` / `catalog:archive_state` / `stats:*` / `config:promos` / `drop_fraud_block:*` / `email:*` – Operational data, not display data.
- **Live states are seeded three ways**: lazily by `getLiveProductState()` on first checkout/draw/archive action, eagerly by `/api/admin/seed` (Seed Defaults) for every product/size, and repaired by the admin **Site Self-Test** ("Live states seeded" check backfills any missing ones for active products via the same idempotent `getLiveProductState`). A freshly seeded store with no traffic legitimately has zero live states until the self-test is run — the storefront falls back to `totalInventory` when a live state is missing, so this is a readiness nicety, not a functional break.

**Legacy keys that no longer exist** (removed via the **Clean Up Redis** button on `/admin` → Developer tab): `store:active_products`, `store:archived_products`, `store:upcoming_products` (full JSON copies of products), `store:product_images:*` (duplicate image arrays), and `store:catalog_config` (duplicate catalog groupings). If you ever see them, run Clean Up Redis — do NOT rebuild them.

### Address Capture Pages
- **`public/address-checkout-form.html`** is a standalone address form served at `/address-checkout-form.html`.
- Mapbox Address Autofill is **optional progressive enhancement** — the SDK only loads when `NEXT_PUBLIC_MAPBOX_TOKEN` (or the `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` alias) is configured, or `window.ENV_MAPBOX_TOKEN` is injected at runtime. **If the token is missing the dropdown simply does not exist** — that is the #1 reason autofill "isn't working". The page shows an explicit "Address autofill is unavailable (Mapbox token not configured)" note and console logs explain the state (`[mapbox-autofill]`). Set the var in Vercel (Project Settings → Environment Variables, Production + Preview) **and redeploy** — it is baked in at build time. For local dev add it to `.env.local`, or use the localhost-only overrides `?mapbox_token=pk.…` / `localStorage "mapbox_dev_token"` (never read in production).
- Submitting posts to **`/api/address/save`**: the address is logged to `address:submissions`, and when the URL carries `?variant=&size=&email=` (and optionally `?orderRef=`) it is attached to the matching open entry. An already-set entry address is only overwritten when the matching `orderRef` is supplied.
- The token placeholder is mapped into `data-mapbox-token` at build time by `scripts/inject-mapbox-token.mjs` (targets `public/` files).
- The **React storefront** (item-page entry form in `components/Storefront.tsx` + cart drawer in `components/SiteChrome.tsx`) wires the same autofill through `lib/mapbox-autofill.ts`: token resolved from `window.ENV_MAPBOX_TOKEN` → `data-mapbox-token` attr → `NEXT_PUBLIC_MAPBOX_TOKEN` → `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`, SDK loaded lazily once, and autofill attaches to inputs mounted later (cart drawer) automatically. Those address inputs must stay **inside a `<form>`** with `autocomplete="shipping street-address"` — Mapbox only attaches to eligible inputs that are descendants of a `<form>`. No token → native browser autofill fallback (no dropdown).
- ⚠️ **Do NOT "restore" `collection.observe()` in `lib/mapbox-autofill.ts`.** Mapbox search-js **v1.6.0 (the latest release) crashes on React pages**: its `observe()` MutationObserver callback deep-compares the shipping inputs (`at(Hi(), …)`) with a `deepEquals()` that has **no cycle detection**, and React DOM nodes carry a **circular enumerable `__reactFiber$…` property** (fiber.stateNode → element → __reactFiber$…). The first DOM mutation then throws `Uncaught RangeError: Maximum call stack size exceeded` (stack frame maps to the SDK's `src/utils/index.ts` → `deepEquals`). `lib/mapbox-autofill.ts` deliberately does **not** call `collection.observe()`; instead it runs its own identity-based MutationObserver (`resyncMapboxAutofill()` + `startAutofillObserver()`) **plus a short retry loop** (`startAttachLoop()`) that calls the SDK's idempotent `collection.update()` until the DOM shows real attach side effects. Keep any future re-implementations identity-based — never deep-compare React DOM nodes.
- **"Active" ≠ attached.** `status: 'active'` only means the SDK loaded and a collection was created — it says **nothing** about whether the dropdown actually attached. `isMapboxAutofillActive()` returns true **only** when (a) the SDK attached to ≥1 input (the SDK renames attached inputs to `… address-search`, adds `data-lpignore`, and appends a `<mapbox-search-listbox>` to `<body>` — see `verifyMapboxAttachment()`), AND (b) no Mapbox suggest request was rejected (`tokenRejected`, 401/403). The status drives the UI hint only — structural validation is the gate (see "Address validation" below). A rejected token also triggers a loud `console.error` with the exact fix (public `pk.*` token; URL restrictions must include the host; token not revoked) and `window.__GOYUNIR_MAPBOX__` carries `tokenPrefix`, `host`, `suggestErrors`, `suggestCount`, `attached`, `inputs`, `attachedInputs`, `listboxes`.
- ⚠️ **Pass `browserAutofillEnabled: true` to `mapbox.autofill()` — do NOT "simplify" it away.** Mapbox search-js **v1.6.0** renames an attached input's `autocomplete` to **`new-password`** on focus and on every keystroke when this option is false (its default). That makes BOTH our selector (`findAddressInputs()`) AND the SDK's own re-scan stop recognizing the field, so the next `collection.update()` tears the dropdown down and it never comes back — while the UI hint flips to "Address autofill could not attach right now" even though the console said "Attach verified". This was the #1 "dropdown stopped working" bug. With the option enabled, the SDK keeps the original address autocomplete while the field is empty/short; `lib/mapbox-autofill.ts` also runs `restoreAddressAutocomplete()` (an identity-based attribute observer + a restore before every `update()`) and `findAddressInputs()` counts SDK-attached inputs via `mapbox-search-listbox.input` so a rename can never make the status flap. The standalone `public/address-checkout-form.html` uses the same option + a small `#checkout-form input[autocomplete="new-password"]` restore guard.
- **React state vs DOM value.** When a suggestion is picked, the SDK fills the input value **programmatically**, which does NOT trigger React's `onChange` — React state can stay empty while the field visibly shows the address. Submit handlers therefore use `getAutofillAddressValue()` (DOM truth, prefers the focused input, then the last eligible input, e.g. the cart drawer) instead of only the React state. The status event `goyunir-mapbox-status` (dispatched on `window` by `setStatus`) drives the small autofill hint lines under the shipping fields in Storefront/SiteChrome.
- **The shipping box fills with the FULL address, not just the street.** Mapbox search-js **v1.6.0** only writes the STREET components (`address_line1/2/3`) into a `street-address` input — city/state/zip are dropped unless the form has separate `address-level2` / `address-level1` / `postal-code` fields. Our storefront forms use a single shipping box, so `handleRetrieve` in `lib/mapbox-autofill.ts` composes the full formatted address from the retrieved feature (`event.detail.features[0].properties` — the SDK's `MapboxHTMLEvent` puts the payload in `detail`) and writes it into the box after the SDK's partial fill (see `composeFullAddress`). The standalone page is unaffected because it has real city/state/zip fields that the SDK fills natively.
- **Address validation:** shared structural checks in `lib/address-validation.ts` reject garbage (missing street number, missing letters, too short) on the client and on the server (`/api/address/save`, `/api/checkout`, `/api/checkout/cart`, `/api/account/update-address`). Mapbox autofill is an **accelerator, not a lock-in**: customers can either pick a suggestion (tracked via the SDK's `retrieve` event; the collection API is `addEventListener('retrieve', …)` — there is no `.on()`) for an instant, pre-verified fill, or type a complete address manually. Do NOT re-add a hard "must pick from the dropdown" gate — the store owner explicitly removed it as customer-hostile friction. `/api/address/save` records a `verified` flag on the submission when it came from a Mapbox suggestion.
- **Standalone page token sanity:** `public/address-checkout-form.html`'s `resolveToken()` now rejects anything that isn't a public `pk.*` token (and the leftover `pk.YOUR_LOCALHOST_MAPBOX_TOKEN` placeholder) — a secret `sk.*` token or placeholder makes the SDK load ("active") but every suggest request 401s (and 401s do not bill, so the dashboard shows zero usage). `autofillReady` on that page is also set only when a `<mapbox-search-listbox>` actually attached.



### Admin Portal (`/admin`)
- Protected by Basic Auth (`ADMIN_BASIC_AUTH_USERNAME`/`PASSWORD`)
- Full CRUD for products, images, settings
- Draw trigger and history
- Entry management and ledger search
- **ALL configuration** (sizes, prices, Stripe IDs, inventory, schedule, social proof, etc.) is editable live – no redeploy required.
- **Design Presets** (`/admin` → Settings → Design Presets) – one-click market skins (Default (Stock) / Luxury / Hype Culture / Wellness / Editorial / Monochrome / Deep Navy) that fill `themeColors` (+ `fontFamily`, `borderRadius`) and the glow orbs. Defined in `lib/theme-presets.ts`; colors are baked into static pages at build time, while `SiteChrome` applies the saved font/background/`--ui-radius` token to the live page shell.

## CRITICAL RULES FOR AI AGENTS

### When Making Changes
1. **Never assume Redis has data** – handle an empty Redis gracefully (empty lists, never fallback products). The storefront intentionally shows **0 items** until a seed exists.
2. **Products must be in Redis to appear on site** – use the **Seed Defaults** button in admin if Redis is empty.
3. **Product slugs only resolve when the product exists in Redis** – an unseeded store returns empty results, and direct product URLs show "Product not found".
4. **All business logic is now configurable via the admin portal** – do NOT suggest code changes for:
   - Adding/removing product sizes
   - Changing product prices
   - Updating Stripe price IDs
   - Modifying inventory or winner tiers
   - Adjusting drop schedule or social proof
   - Changing site colors, text, or footer links

### Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 404 on product page | Product not in Redis | Go to /admin → Products → Seed Defaults |
| 404 on home page | No active products | Seed defaults or add a product via admin |
| Admin not accessible | Basic Auth missing | Check environment variables |
| Settings not applying | Need redeploy | Settings stored in Redis, but some theme changes require a build; use the Settings tab in admin and then redeploy |
| Size not showing | `availableSizes` not set | Go to /admin → Settings → Available Sizes |

### Testing New Changes
1. Always test with Redis empty (clear Redis first)
2. Test with Redis seeded (click Seed Defaults)
3. Test admin portal for each feature

### Files to NEVER Modify
- `components/Storefront.tsx` – Modify carefully (cart/checkout/product-page flow; no fallback catalog is served here)
- `app/[slug]/page.tsx` – Product page routing
- `goyunir.config.ts` – Only change if you need a new hardcoded default; prefer using admin portal

`app/api/store/config/route.ts` is a legacy endpoint (nothing in the client calls it — the site uses `/api/store`). It is kept functional and now derives products from `store:products` like every other read path; change it carefully if you touch it.

## Environment Variables (set in Vercel)

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRODUCT_ID (optional) – global default Stripe price ID. Used when a product/size has no Stripe ID set in /admin. Per-product IDs set in admin always win. There is NO hardcoded Stripe price ID in this template – if a product/size has no ID and STRIPE_PRODUCT_ID is unset, checkout fails loudly with an obvious placeholder (`price_placeholder_not_configured`) instead of charging a wrong account.
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
ADMIN_BASIC_AUTH_USERNAME
ADMIN_BASIC_AUTH_PASSWORD
CRON_SECRET
RESEND_API_KEY (optional)
RESEND_FROM (optional)
NEXT_PUBLIC_MAPBOX_TOKEN (required for Mapbox address autofill dropdowns; must be set in the SAME environment(s) you deploy and the site must be redeployed after setting it — it is baked into the client at build time. `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` is accepted as an alias.)


## When to Update This File
- When new Redis keys are added
- When admin portal gains new features
- When critical bugs are fixed
- When architecture changes

**Last Updated**: 2026-08-13

---

## GOAL STATUS (from previous AI)
- ✅ Stripe price IDs are NO LONGER hardcoded anywhere – per-size IDs come from `/admin` (wins), else `STRIPE_PRODUCT_ID`, else an obvious placeholder that fails checkout loudly. Seed products use `defaultStripePriceId()` so new seeds inherit the env var.
- ✅ Default size label is now `'Standard'` – changeable via admin portal.
- ✅ All products, prices, sizes, and Stripe IDs can be fully customized through `/admin` → Products and Settings.
- ✅ Unseeded store now shows **0 items** (no fallback catalog is served from `goyunir.config.ts`).
- ✅ Chrome/desktop lag reduced: glow orbs are radial gradients (no `filter: blur()`), and `backdrop-filter` was removed from the header, footer, cart overlay, and modals.
- ✅ No further code changes required for normal store operation – everything is portal‑driven.
- 🔄 Future improvements: Consider adding direct product import/export CSV in admin.

## CRITICAL RULES FOR AI AGENTS

### Product Configuration
- **All product details** (prices, Stripe IDs, inventory, winner tiers) are now **exclusively managed via the admin portal** (`/admin` → Products).
- The config file (`goyunir.config.ts`) contains **no size‑specific prices or Stripe IDs** – only metadata like name, slug, description, notes, and images.
- `maxRaffleAllocationLimit`, `totalInventory`, and `winnerTiers` default to `0` in the seed – set them in the admin.
- **Stripe price IDs** for each size are set per product in the admin portal – there is no universal default; if you see a `price_placeholder_*` error, it means you haven't set the ID in admin.

### Common Issues
- **"Price not configured" or "Stripe price ID not configured"** – go to `/admin` → Products, edit the product, fill in the price and Stripe ID for each size.
- **"Sold out"** – adjust inventory in the admin portal.
- **"Invalid size"** – check the `availableSizes` in `/admin` → Settings.

### File to NEVER Modify
- `goyunir.config.ts` – only change if you need to add a new product’s metadata (name, slug, prefix, notes, images). Prices, Stripe IDs, inventory, and winner tiers are **not** stored here.

## Product Variants

Products now have a `variants` array (not fixed 50ml/100ml). Each variant has:
- `name` (e.g., "Standard", "Premium")
- `price` (number)
- `stripePriceId` (string)
- `inventory` (number)
- `winnerTiers` (array of numbers, e.g., [2,2,2,1])

All variants are managed in the admin portal. New products default to **inactive** (`isActive: false`) to avoid accidentally publishing unfinished items.

## Archive & Upcoming

- `isArchived` – moves product to the "Past Archives" section on the catalog page; **does not hide** it from admin or affect `isActive`.
- `isUpcoming` – moves product to the "Upcoming" section; **does not affect** `isActive`.
- You can set both flags independently.

## Account Recovery

- Signup should create a session immediately so new users land in `/account` already logged in.
- Password reset uses `/auth/reset-password` and tokenized links from the forgot-password flow.

## Branding & Share Cards

- Site logo, browser tab icon, and social share image styling are controlled from `/admin` → Settings.
- The configured branding should be reflected in the header logo, the favicon route, and the Open Graph preview image.
- Keep share colors and copy aligned with the admin settings instead of hardcoding them in the layout.
- `/admin` → Settings → Branding & Share also controls the **top bar**: `brandName` (shown in the top bar, footer, page title, OG image, favicon and transactional emails), `brandFontFamily` (an optional separate font for the top-bar name), and `headerMode` (`both`/`logo`/`text`). Emails read `BRAND_NAME` / `NEXT_PUBLIC_SITE_NAME` env vars when set (useful for template buyers who want a different send-from name without touching code).
- Account signup awards **250 welcome points** and a **one-time 10% welcome promo code** bound to the email (stored on `store:users` + `config:promos`, emailed best-effort, and visible/claimable in `/account`). Admin can adjust points per user in `/admin` → Users.

## Image Upload

- Upload images via the admin form (file input). Images are stored in `/public/uploads/{productId}/` and auto‑numbered.
- Supported formats: JPEG, PNG, GIF, WebP, etc.
- The product’s `images` array is updated with the new URLs.

## Cart / Multiple Items

Cart checkout is implemented for FCFS/direct items. Raffle entries still use the product-page setup flow, and referral codes can arrive through `?ref=` or `?promo=` links and should be preserved through checkout metadata.

## Product Configuration (v2 – fully dynamic)

All product‑specific data (prices, Stripe IDs, inventory, winner tiers) is now stored in **Redis** and managed via the admin portal.

- **No hardcoded `price50ml` / `price100ml`** – instead, each product has a `priceCategories` array where you can define any number of sizes (e.g., “Standard”, “Large”, “50ml”, “100ml”).
- Each category includes:
  - `size` – the label shown to customers.
  - `price` – the retail price in USD.
  - `stripeId` – the Stripe Price ID for that size (defaults to the `STRIPE_PRODUCT_ID` env var when set, otherwise the placeholder `price_placeholder_not_configured`; see `defaultStripePriceId()` / `resolveStripePriceId()` in `lib/server-config.ts`). No real Stripe price ID is ever hardcoded – the admin-set value always wins.
  - `winnerTiers` – comma‑separated list of winner counts per draw (only used if Raffle Mode is enabled).
- **New products default to hidden** (`isActive: false`) – you must explicitly publish them.
- **Archived** and **Upcoming** flags do NOT hide the product – they only change its display section in the catalog.

### Adding a new product
1. Go to `/admin` → Products → **+ Add Product**.
2. Fill in name, slug, description, etc.
3. Under **Price Categories**, add one or more sizes.
4. Set `isActive` to `true` when you're ready to publish.
5. Save – the product appears on the storefront immediately.

### Editing existing products
All fields (including price, Stripe ID, inventory, and winner tiers) are editable in the admin portal – no redeploy needed.

### Image upload
You can upload image files directly (multiple at once) – they are stored as base64 data URLs. The system automatically numbers them (1, 2, 3…) and the `prefix` is derived from the product `slug`.

## Performance / Caching (read this before touching storefront perf)

Public-facing display data is cached with short TTLs to keep the site snappy. This is intentional and safe — admin writes bypass the caches, so no data is lost; the only effect is that **storefront display data can lag up to a few seconds** behind a change.

- `lib/ttl-cache.ts` — server-side in-memory TTL cache (`withTtlCache(key, ttlMs, fetcher)`). Used by `/api/store` (10s), `/api/catalog/status` (15s), `/api/config/public` (30s), the heartbeat social-proof tally (15s), and `loadStoreConfigCached` (30s, used by layout metadata / favicon / OG image).
- `lib/client-store-cache.ts` — client-side `fetchStoreJson(url)` dedupes in-flight requests and reuses results for 10s. HomePage and SiteChrome both fetch `/api/store`; this makes it a single round trip.
- `app/layout.tsx` has **no** `force-dynamic` — the page shell is statically prerendered (`/`, `/catalog`, legal pages). Product slugs (`/[slug]`) and admin/account remain dynamic on purpose.
- `components/SiteChrome.tsx` animates the background glow via **direct DOM writes** (refs), never React state, so the ~60fps idle drift does not re-render the app. Keep it transform-only: do NOT add `filter: blur()` or `backdrop-filter` to animated/large elements — they force per-frame paints and cause Chrome lag. Glows are pre-blurred radial gradients instead.
- Home (`app/page.tsx`) and Catalog (`app/catalog/page.tsx`) only run their 1-second countdown tickers while a live countdown is actually visible.
- If you add a new public read endpoint, wrap its Redis reads in `withTtlCache` with a short TTL instead of hitting Redis on every request. If you change storefront config/settings, remember the public site may show cached values for up to 30s.