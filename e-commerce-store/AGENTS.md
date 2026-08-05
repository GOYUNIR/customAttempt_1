<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# GOYUNIR PROJECT - COMPLETE AGENT INSTRUCTIONS

## Project Overview

GOYUNIR is a raffle/drop allocation storefront built on Next.js with Redis as the primary data store. The entire site is designed to be managed through the admin portal at `/admin` - no code changes should be needed for normal operation.

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


### Admin Portal (/admin)
- Protected by Basic Auth (ADMIN_BASIC_AUTH_USERNAME/PASSWORD)
- Full CRUD for products, images, settings
- Draw trigger and history
- Entry management and ledger search

## CRITICAL RULES FOR AI AGENTS

### When Making Changes
1. **Never assume Redis has data** - always use fallbacks
2. **Products must be in Redis to appear on site** - use Seed Defaults button in admin
3. **/elysian-white and /obsidian-void are fallback slugs** - they redirect if not in Redis

### Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 404 on product page | Product not in Redis | Seed defaults in admin |
| 404 on home page | No active products in Redis | Seed defaults or add product |
| Admin not accessible | Basic Auth missing | Check env variables |
| Settings not applying | Need redeploy | Settings stored in Redis, need build |

### Testing New Changes
1. Always test with Redis empty (clear Redis first)
2. Test with Redis seeded (click Seed Defaults)
3. Test admin portal for each feature

### Files to NEVER Modify
- `components/Storefront.tsx` - Contains fallback products, modify carefully
- `app/api/store/config/route.ts` - Critical for site loading
- `app/[slug]/page.tsx` - Product page routing

## Development Commands
```bash
npm run dev     # Local development
npm run build   # Build for production
npm run start   # Start production server

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
ADMIN_BASIC_AUTH_USERNAME
ADMIN_BASIC_AUTH_PASSWORD
CRON_SECRET

When to Update This File
When new Redis keys are added

When admin portal gains new features

When critical bugs are fixed

When architecture changes

Last Updated
2026-08-05

