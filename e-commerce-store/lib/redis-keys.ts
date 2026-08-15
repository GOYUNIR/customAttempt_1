/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REDIS KEY REGISTRY — the SINGLE source of truth for every Redis key the
 * storefront touches.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Redis is the primary data store for this template. When the site scales to
 * thousands of customers, a messy key space (scattered `drop_*`/`live_state`
 * keys, raw `session:<token>` keys, underscore-heavy names) makes the Redis
 * data browser unusable and makes schema changes dangerous. This file exists
 * so that:
 *
 *   1. Every key follows ONE convention: `domain:subdomain:…` — lowercase,
 *      colon-delimited, no underscores in top-level segments, no product-name
 *      soup. Prefixes sort and filter cleanly in any Redis browser.
 *   2. Renaming or adding a key is a ONE-LINE change with no cross-file grep.
 *   3. The migration table in `/api/admin/organize-redis` can move any
 *      installation from an older schema to this one without data loss.
 *
 * NAMESPACE MAP
 * -------------
 *   store:        Canonical, admin-edited catalog/account data (the ONLY data
 *                 a buyer ever configures). Never delete these casually.
 *   archive:      The permanent entry/charge ledger (append-only history).
 *   promo:        Promo codes + their operational state (used/pending/credit).
 *   entries:      LIVE entry pools, intent pools, fraud blocks, dedupe sets.
 *   draws:        Draw summaries + draw history (operational).
 *   ops:          Operational state: live inventory, catalog archive, recovery
 *                 campaign state, admin live-apply overrides.
 *   auth:         Auth tokens (sessions, password-reset tokens).
 *   admin:        Admin-only data (audit log).
 *   analytics:    Counters/timestamps for social proof + online visitors.
 *   customer:     Customer-submitted data (waitlist, standalone addresses).
 *   cache:        Ephemeral caches — safe to delete anytime, rebuilt lazily.
 *
 * MANDATORY RULES FOR FUTURE AGENTS
 * ---------------------------------
 * 1. NEVER hardcode a Redis key string outside this file.
 * 2. When you add/rename a key: (a) update this file, (b) update AGENTS.md +
 *    README.md in the SAME change, (c) add an entry to the migration table in
 *    `app/api/admin/organize-redis/route.ts` so existing installs upgrade.
 * 3. Canonical config stays in `store:config` / `store:products`. Operational
 *    data stays OUT of `store:`. There is exactly ONE source of truth per fact.
 * 4. Pool keys are `entries:pool:<product name>:<size>` — product name is the
 *    join key used by the entry/ledger system (entries carry `variant`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────────
// Canonical catalog & accounts (admin-edited — the only "real" data)
// ────────────────────────────────────────────────────────────────────────────

/** Hash of product records; field = product id. THE canonical catalog. */
export const PRODUCTS_KEY = 'store:products';
/** Single JSON string: theme, branding, copy, legal, catalogPreview, … */
export const STORE_CONFIG_KEY = 'store:config';
/** Hash of customer accounts; field = user id. */
export const USERS_KEY = 'store:users';
/** String — the signed-in user's saved cart (JSON array), keyed by user id.
 *  Anonymous carts live only in the browser (localStorage); the moment a
 *  customer signs in, SiteChrome merges the local bag with this record and
 *  every subsequent change is persisted here (debounced client-side), so the
 *  same account sees the same bag on any device. Deletable — it is a cache of
 *  the browser cart, never a source of truth. */
export function userCartKey(userId: string): string {
  return `store:cart:${String(userId || '').slice(0, 128)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Permanent ledger (append-only entry/charge history)
// ────────────────────────────────────────────────────────────────────────────

/** List of JSON ArchiveRecords — searchable in /admin → Ledger. */
export const ARCHIVE_LEDGER_KEY = 'archive:ledger';

// ────────────────────────────────────────────────────────────────────────────
// Promos (code records + operational state)
// ────────────────────────────────────────────────────────────────────────────

/** Hash of promo-code records; field = uppercase code. */
export const PROMO_CODES_KEY = 'promo:codes';
/** Set of emails that have consumed a promo code. */
export function promoUsedKey(code: string): string {
  return `promo:used:${code}`;
}
/** TTL string — reservation while a checkout session is open. */
export function promoPendingKey(code: string, email: string): string {
  return `promo:pending:${code}:${email}`;
}
/** String — delivery-credit dedupe per order reference. */
export function promoCreditKey(orderRef: string): string {
  return `promo:credit:${orderRef}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Live entries & draws (high-churn operational data)
// ────────────────────────────────────────────────────────────────────────────

/** List of confirmed raffle entries for a product+size. */
export function poolKey(variant: string, size: string): string {
  return `entries:pool:${variant}:${size}`;
}
/** List of pre-payment intent entries for a product+size. */
export function intentPoolKey(variant: string, size: string): string {
  return `entries:intent:${variant}:${size}`;
}
/** List of waitlist entries for an FCFS product+size (charged at trigger-drop). */
export function waitlistPoolKey(variant: string, size: string): string {
  return `entries:waitlist:${variant}:${size}`;
}
export const POOL_KEY_PREFIX = 'entries:pool:';
export const INTENT_KEY_PREFIX = 'entries:intent:';
export const WAITLIST_POOL_PREFIX = 'entries:waitlist:';

/** Hash of per-pool entry counts (fields `sub:<variant>:<size>` / `int:…`). */
export const POOL_STATS_KEY = 'entries:stats';
export function poolStatField(kind: 'sub' | 'int', variant: string, size: string): string {
  return `${kind}:${variant}:${size}`;
}

/** Set of emails blocked from entering a product+size (fraud / duplicate). */
export function emailBlockKey(variant: string, size: string): string {
  return `entries:block:email:${variant}:${size}`;
}
/** Set of card fingerprints blocked from entering a product+size. */
export function cardBlockKey(variant: string, size: string): string {
  return `entries:block:card:${variant}:${size}`;
}

/** Set of Stripe session ids already processed by confirm-setup / webhook. */
export const PROCESSED_SESSIONS_KEY = 'entries:processed';
/** Set of `<variant>:<size>:<email>` rows that already got a confirmation email. */
export const ENTRY_EMAIL_SENT_KEY = 'entries:email_sent';
/** Timestamp of the last auto-draw per pool (draw-scheduler dedupe). */
export function lastAutoDrawKey(variant: string, size: string): string {
  return `entries:last_auto:${variant}:${size}`;
}

/** String — JSON summary of the most recent draw run. */
export const LAST_DRAW_KEY = 'draws:last';
/** List — capped draw history shown in /admin → Draws. */
export const DRAW_HISTORY_KEY = 'draws:history';

// ────────────────────────────────────────────────────────────────────────────
// Operational state
// ────────────────────────────────────────────────────────────────────────────

/** Hash of live inventory/product states (field = `productId-slug:size`). */
export const LIVE_STATE_KEY = 'ops:live_state';
/** Hash of catalog archive records (field = product id). */
export const CATALOG_ARCHIVE_KEY = 'ops:catalog_archive';
/** String — recovery-campaign configuration. */
export const RECOVERY_CONFIG_KEY = 'ops:recovery_config';
/** Hash — recovery-email dedupe (field = `email|variant|size|kind`). */
export const RECOVERY_SENT_KEY = 'ops:recovery_sent';

// Live-apply overrides managed from /admin (no redeploy needed).
/** String — global drop-schedule override. */
export const SCHEDULE_OVERRIDE_KEY = 'ops:override:schedule';
/** String — global social-proof override. */
export const SOCIAL_PROOF_OVERRIDE_KEY = 'ops:override:social_proof';
/** Prefix — per-product pricing/schedule overrides (`ops:override:product:<id>`). */
export const PRODUCT_OVERRIDE_PREFIX = 'ops:override:product:';
export function productOverrideKey(productId: string): string {
  return `${PRODUCT_OVERRIDE_PREFIX}${productId}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────────

/** String w/ TTL — user session (7 days). One key per signed-in customer. */
export function sessionKey(token: string): string {
  return `auth:session:${token}`;
}
export const AUTH_SESSION_PREFIX = 'auth:session:';
/** String w/ TTL — password-reset token (30 min). */
export function passwordResetKey(token: string): string {
  return `auth:reset:${token}`;
}
/** String w/ TTL — email-verification challenge for a customer account
 * (`auth:verify:<email>`). Holds the hashed 6-digit code + attempt counter so
 * signups can prove the inbox is real before welcome rewards are issued. */
export function emailVerifyKey(email: string): string {
  return `auth:verify:${email}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Admin
// ────────────────────────────────────────────────────────────────────────────

/** List — JSON audit trail of admin actions. */
export const AUDIT_LOG_KEY = 'admin:audit_log';

// Two-step admin verification (email one-time code + remembered devices).
/** String w/ TTL — pending admin 2FA challenge for an email (`admin:verify:<email>`). */
export function adminVerifyKey(email: string): string {
  return `admin:verify:${email}`;
}
/** Hash of verified admin device tokens (field = token, value = JSON with an
 * explicit `expiresAt`). A valid token in this hash is what the "remember
 * device" / "this browser" cookie maps to, and proxy.ts checks it so every
 * /api/admin request is 2FA-gated. A SINGLE hash (not one key per token) keeps
 * the Redis data browser tidy — expired tokens are lazy-deleted the next time
 * they're checked, and revoking a device is a one-field HDEL. */
export const ADMIN_DEVICES_KEY = 'admin:devices';
/** String w/ TTL — wrong-code counter for brute-force lockout (`admin:verify_attempts:<email>`). */
export function adminVerifyAttemptsKey(email: string): string {
  return `admin:verify_attempts:${email}`;
}
/** String w/ TTL — resend throttle counter (`admin:send_attempts:<email>`). */
export function adminSendAttemptsKey(email: string): string {
  return `admin:send_attempts:${email}`;
}
/** Name of the httpOnly admin 2FA device cookie set after a successful code. */
export const ADMIN_DEVICE_COOKIE = 'goyunir_admin_device';

// ────────────────────────────────────────────────────────────────────────────
// Analytics (social proof counters + online visitors)
// ────────────────────────────────────────────────────────────────────────────

/** ZSET of visitor ids scored by last-seen timestamp. */
export const ANALYTICS_ONLINE_KEY = 'analytics:online';
/** String — social-proof boost counter (real + auto-increment). */
export const SOCIAL_PROOF_BOOST_KEY = 'analytics:social_boost';
/** String — timestamp of the last auto-increment tick. */
export const TICKS_LAST_KEY = 'analytics:ticks:last';
/** String — number of auto-increment ticks today. */
export const TICKS_TODAY_KEY = 'analytics:ticks:today';
/** String — YYYY-MM-DD stamp that resets the daily tick counter. */
export const TICKS_DAY_STAMP_KEY = 'analytics:ticks:day';

// ────────────────────────────────────────────────────────────────────────────
// Customer records
// ────────────────────────────────────────────────────────────────────────────

/** Hash of standalone address-form submissions (field = submission id). */
export const ADDRESS_SUBMISSIONS_KEY = 'customer:addresses';
/** Hash of waitlist / drop-alert subscribers (field = email). */
export const WAITLIST_KEY = 'customer:waitlist';

// ────────────────────────────────────────────────────────────────────────────
// Ephemeral caches (safe to delete anytime)
// ────────────────────────────────────────────────────────────────────────────

/** String — cached Stripe billing-portal configuration id. */
export const STRIPE_PORTAL_CACHE_KEY = 'cache:stripe_portal_config';
/** String w/ TTL — per-IP request counter for the PUBLIC `/api/checkout/auto-draw`
 *  trigger. Ephemeral; lives under `cache:` because it can be deleted anytime
 *  without affecting correctness (it only throttles abuse). */
export function autoDrawRateLimitKey(ip: string): string {
  return `cache:rate:auto_draw:${String(ip || 'unknown').slice(0, 64)}`;
}

