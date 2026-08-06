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

