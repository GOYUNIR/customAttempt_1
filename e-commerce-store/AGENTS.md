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
- **Fallback products** exist in `components/Storefront.tsx` if Redis is empty

### Key Redis Keys

store:products - All products
store:active_products - Active products (shown on storefront)
store:archived_products - Archived products (shown in catalog archive)
store:product_images - Product 360° rotation images
store:config - Site configuration (colors, hero, footer, etc.)
drop_pool:* - Entry pools for each product/size
archive:ledger - Permanent entry history


### Admin Portal (`/admin`)
- Protected by Basic Auth (`ADMIN_BASIC_AUTH_USERNAME`/`PASSWORD`)
- Full CRUD for products, images, settings
- Draw trigger and history
- Entry management and ledger search
- **ALL configuration** (sizes, prices, Stripe IDs, inventory, schedule, social proof, etc.) is editable live – no redeploy required.

## CRITICAL RULES FOR AI AGENTS

### When Making Changes
1. **Never assume Redis has data** – always use fallbacks.
2. **Products must be in Redis to appear on site** – use the **Seed Defaults** button in admin if Redis is empty.
3. **/elysian-white and /obsidian-void are fallback slugs** – they redirect if not in Redis.
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
- `components/Storefront.tsx` – Contains fallback products, modify carefully
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

**Last Updated**: 2026-08-06

---

## GOAL STATUS (from previous AI)
- ✅ Stripe unified price ID `price_1U1MD0PIsR6ijfBZ872i58N1` is now the default for all seed products.
- ✅ Default size label is now `'Standard'` – changeable via admin portal.
- ✅ All products, prices, sizes, and Stripe IDs can be fully customized through `/admin` → Products and Settings.
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

## Image Upload

- Upload images via the admin form (file input). Images are stored in `/public/uploads/{productId}/` and auto‑numbered.
- Supported formats: JPEG, PNG, GIF, WebP, etc.
- The product’s `images` array is updated with the new URLs.

## Cart / Multiple Items

**Not implemented yet.** This is a planned feature. For now, each transaction is single‑item (raffle entry or direct purchase). A future update will add cart support.

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