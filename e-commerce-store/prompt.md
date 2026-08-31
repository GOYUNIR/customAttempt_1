STRICT AUDIT, REFACTOR & FULL IMPLEMENTATION DIRECTIVE:
We noticed past passes took shortcuts, used superficial fallbacks, or misreported completion on features that were still broken. Proven results matter — impress us by resolving every single item below with zero shortcuts, no mock placeholders, and strict line-by-line verification.

PHASE 1: AUTHENTICATION, RATE LIMITING & SECURITY TOOLS
- Fix 429 Resend 2FA Error on Account Page: Resolve the F12 429 status code ('Failed to load resource: the server responded with a status of 429 ()') when resending verification codes in /account. Implement a visible frontend cooldown timer button and adjust rate-limiting windows to prevent accidental rate-limit hits.
- Secure Admin Password Troubleshooting Tool: Implement a secure admin-side password viewing/troubleshooting tool inside the Admin Portal. Protect access behind explicit admin re-authentication/confirmation and log all access events for security.
- Storefront Locked Email UI Polish: On Raffle/FCFS entry forms for signed-in users, grey out and lock the email field to their account address cleanly. Remove extra lock emojis or clutter to keep the UI clean.


PHASE 2: DYNAMIC SYSTEM CHECKS, MULTI-CLOUD & BRANDING HYGIENE
- Align System Checks with Setup Wizard: Fix the Site Self-Test runner. Stop checking hardcoded process.env variables that report 13 false 'MISSING' errors (e.g., STRIPE_SECRET_KEY, UPSTASH_REDIS_REST_URL, RESEND_API_KEY). Instead, evaluate active configurations stored in Supabase (global_platform_settings).
- Dynamic Provider Diagnostics: Automatically adjust required environment checks based on the active provider chosen in the Setup Wizard. If Supabase is selected as the primary store, do not demand Redis keys unless Redis is explicitly enabled.
- Multi-Cloud & Provider Redundancy: Ensure full hosting/database compatibility for Vercel, Cloudflare, and custom VPS environments. Support optional dual-write/mirroring (e.g., Supabase + Redis/Cloudflare KV) for data redundancy.
- Fix Theme Hex Validation: Fix theme color validation so hex picker values like 'cardBorder' do not trigger non-hex failure errors.
- Purge Vercel Branding: Search the entire repository for any Vercel logos or SVGs and delete them completely.

PHASE 3: PRODUCT PANEL OVERHAUL, HYDRATION & LOGIC FIXES
- Fix Dropdown State Hydration on Edit Load: Fix the critical bug in 'Pricing, Sizes & Inventory' where dropdowns fail to populate with their saved values when loading an existing product, leading to accidental corrupted overwrites upon saving.
- Per-Item Granular Inventory & Limits: Change 'Inventory & limits' from an aggregated total sum to granular per-variant / per-size inventory tracking and purchase limit enforcement.
- Shared Product Reference IDs for Samples: Implement shared sample reference IDs so a standalone sample product can be linked directly into multiple full-size product listings without duplicating item definitions.
- Strict Drop Schedule Timestamps: When no date or time is set for 'Drop Schedule', do not automatically assign a release timestamp. Keep undefined drop schedules strictly null/unset.
- Rework 'Trial Sizes & Sample Credits': Completely redesign the sloppy, redundant 'Trial sizes & sample credits' section into a clean, intuitive, and streamlined component.
- Enhanced Image Cropping (Pan + Zoom): Upgrade the crop editor in 'Gallery & Images' to support full image panning/dragging within crop bounds, in addition to zooming.

PHASE 4: SEPARATED AI ARCHITECTURE (ADMIN HELPER & MAIN PAGE HERO)
- Move & Expand AI Admin Helper: Move the AI Helper to the VERY TOP of the Admin Portal. Expand it from a simple settings assistant into a comprehensive Admin Portal Helper that can read store data, diagnose issues, and perform edits across all editable admin modules.
- AI Permission & Mode Toggle: Add clear operation modes to the AI Admin Helper: 'Inquiry / Tell-Only Mode' vs. 'Verified Edit Mode' (which requires explicit user confirmation before applying any changes).
- Standalone Main Page Hero AI: Keep the main page top product animation AI system completely separated from the Admin Helper, dedicated solely to processing cover images and rendering visual hero animations on the storefront.

PHASE 5: SYSTEM-WIDE TIMESTAMPS & RECORD AUDIT
- Comprehensive Timestamps: Ensure all system items, products, logs, drop pools, and user activity entries record and display readable, formatted timestamps.

PHASE 6: EXHAUSTIVE TESTING & FINAL REPORT
- Execute all tests from the current project root directory.
- Use local node dependencies (`npx tsc --noEmit` or `npm run type-check`, `npx eslint .`, and `npm test`). Do NOT attempt global system installations like `apt install`.
- Test every requirement listed above in a real environment. In your final response, list every phase and feature line-by-line with proof of completion.
