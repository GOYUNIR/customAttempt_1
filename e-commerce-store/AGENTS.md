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

store:products - All products
store:active_products - Active products (shown on storefront)
store:archived_products - Archived products (shown in catalog archive)
store:product_images - Product 360° rotation images
store:config - Site configuration (colors, hero, footer, etc.)
drop_pool:* - Entry pools for each product/size
archive:ledger - Permanent entry history
address:submissions - Addresses captured by the standalone checkout pages (`/checkout.html`, `/address-checkout-form.html`)

### Address Capture Pages
- **`public/checkout.html`** and **`public/address-checkout-form.html`** are standalone address forms served at `/checkout.html` and `/address-checkout-form.html`.
- Mapbox Address Autofill is **optional progressive enhancement** — the SDK only loads when `NEXT_PUBLIC_MAPBOX_TOKEN` is configured (or `window.ENV_MAPBOX_TOKEN` is injected at runtime). Without a token the forms still work via native browser autofill + manual entry.
- Submitting posts to **`/api/address/save`**: the address is logged to `address:submissions`, and when the URL carries `?variant=&size=&email=` (and optionally `?orderRef=`) it is attached to the matching open entry. An already-set entry address is only overwritten when the matching `orderRef` is supplied.
- The token placeholder is mapped into `data-mapbox-token` at build time by `scripts/inject-mapbox-token.mjs` (targets `public/` files).
- The **React storefront** (item-page entry form in `components/Storefront.tsx` + cart drawer in `components/SiteChrome.tsx`) wires the same autofill through `lib/mapbox-autofill.ts`: token resolved from `window.ENV_MAPBOX_TOKEN` → `NEXT_PUBLIC_MAPBOX_TOKEN`, SDK loaded lazily once, and a single autofill collection `observe()`s the document so inputs mounted later (cart drawer) attach automatically. Those address inputs must stay **inside a `<form>`** with `autocomplete="shipping street-address"` — Mapbox only attaches to eligible inputs that are descendants of a `<form>`. No token → native browser autofill fallback (no dropdown).


### Admin Portal (`/admin`)
- Protected by Basic Auth (`ADMIN_BASIC_AUTH_USERNAME`/`PASSWORD`)
- Full CRUD for products, images, settings
- Draw trigger and history
- Entry management and ledger search
- **ALL configuration** (sizes, prices, Stripe IDs, inventory, schedule, social proof, etc.) is editable live – no redeploy required.
- **Design Presets** (`/admin` → Settings → Design Presets) – one-click market skins (Luxury / Hype Culture / Wellness) that fill `themeColors` (+ `fontFamily`, `borderRadius`) and the glow orbs. Defined in `lib/theme-presets.ts`; colors are baked into static pages at build time, while `SiteChrome` applies the saved font/background/`--ui-radius` token to the live page shell.

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
- `app/api/store/config/route.ts` – Critical for site loading
- `app/[slug]/page.tsx` – Product page routing
- `goyunir.config.ts` – Only change if you need a new hardcoded default; prefer using admin portal

## Environment Variables (set in Vercel)

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
ADMIN_BASIC_AUTH_USERNAME
ADMIN_BASIC_AUTH_PASSWORD
CRON_SECRET
RESEND_API_KEY (optional)
RESEND_FROM (optional)


## When to Update This File
- When new Redis keys are added
- When admin portal gains new features
- When critical bugs are fixed
- When architecture changes

**Last Updated**: 2026-08-13

---

## GOAL STATUS (from previous AI)
- ✅ Stripe unified price ID `price_1U1MD0PIsR6ijfBZ872i58N1` is now the default for all seed products.
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
  - `stripeId` – the Stripe Price ID for that size (defaults to `price_1U1MD0PIsR6ijfBZ872i58N1`).
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