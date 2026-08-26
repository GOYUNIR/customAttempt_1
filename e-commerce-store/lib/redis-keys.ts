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
/** Hash of signed-in user carts; field = user id, value = JSON array.
 *  Anonymous carts live only in the browser (localStorage); the moment a
 *  customer signs in, SiteChrome merges the local bag with this record and
 *  every subsequent change is persisted here (debounced client-side), so the
 *  same account sees the same bag on any device. ONE hash (not one key per
 *  user) keeps the Redis browser tidy no matter how many customers sign up.
 *  Deletable — it is a cache of the browser cart, never a source of truth. */
export const STORED_CARTS_KEY = 'store:carts';

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

/** ZSET of Stripe session ids already processed by confirm-setup / webhook,
 *  scored by processing timestamp. Bounded: every write prunes members older
 *  than 72h (Stripe's webhook retry window), so it can never grow unbounded.
 *  Legacy SET-shaped data is self-migrated by `lib/redis-maintenance.ts`. */
export const PROCESSED_SESSIONS_KEY = 'entries:processed';
/** ZSET of `<variant>:<size>:<email>` rows that already got a confirmation
 *  email, scored by send timestamp. Bounded: members older than 30 days are
 *  pruned on every write (email sends only repeat within days of checkout). */
export const ENTRY_EMAIL_SENT_KEY = 'entries:email_sent';
/** Hash — last auto-draw timestamp per pool (field = `variant:size`). The
 *  draw-scheduler dedupe lives in ONE hash so every product/size never spawns
 *  its own top-level key. */
export const LAST_AUTO_DRAW_HASH_KEY = 'entries:last_auto';
export function lastAutoDrawField(variant: string, size: string): string {
  return `${variant}:${size}`;
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

// Live-apply overrides managed from /admin (no redeploy needed). ALL overrides
// live in ONE hash `ops:overrides` (fields: `schedule`, `social_proof`,
// `product:<id>`) so the ops namespace never grows a key per product.
export const OVERRIDES_KEY = 'ops:overrides';
export const OVERRIDE_SCHEDULE_FIELD = 'schedule';
export const OVERRIDE_SOCIAL_PROOF_FIELD = 'social_proof';
export function productOverrideField(productId: string): string {
  return `product:${String(productId || '')}`;
}

// Outbound webhooks (multi-tenant B2B SaaS events: user.registered,
// license.updated, settings.changed). Delivered by lib/webhooks.ts with
// exponential backoff. Subscribers map lives in the config string; pending
// jobs are JSON lines in the queue list.
/** String — JSON object mapping event name → subscriber URL(s). */
export const WEBHOOK_CONFIG_KEY = 'ops:webhooks:config';
/** List — pending outbound webhook jobs (JSON strings). */
export const WEBHOOK_QUEUE_KEY = 'ops:webhooks:queue';



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
/** Name of the httpOnly admin 2FA device cookie set after a successful code. */
export const ADMIN_DEVICE_COOKIE = 'goyunir_admin_device';

// Admin login sessions (the in-site /admin/login form replaces the native
// browser Basic-Auth dialog). After the operator's email + password are
// verified, a SHORT-LIVED login session is stored under `admin:auth:<token>`
// (TTL string) and carried in the `goyunir_admin_auth` cookie. That session is
// the "password passed" layer — the operator still has to clear the emailed 2FA
// code (which issues the long-lived `ADMIN_DEVICE_COOKIE`) before the portal
// unlocks. Keeping login sessions as TTL strings (not hash fields) means they
// self-expire without any lazy-cleanup sweep.
export const ADMIN_AUTH_PREFIX = 'admin:auth';
/** String w/ TTL — an in-site admin login session (`admin:auth:<token>`). */
export function adminAuthKey(token: string): string {
  return `${ADMIN_AUTH_PREFIX}:${token}`;
}
/** Name of the httpOnly admin LOGIN-SESSION cookie (proves email+password passed). */
export const ADMIN_AUTH_COOKIE = 'goyunir_admin_auth';

// ────────────────────────────────────────────────────────────────────────────
// Analytics (social proof counters + online visitors)
// ────────────────────────────────────────────────────────────────────────────


/** Prefix for per-tenant daily usage hashes (`analytics:usage:<tenant>:<day>`).
 *  Fields: `api_calls`, `ai_generations`, `system_events` (see lib/analytics.ts). */
export const ANALYTICS_USAGE_PREFIX = 'analytics:usage';
export function analyticsUsageKey(tenantId: string, day: string): string {
  const t = String(tenantId || 'default').trim().toLowerCase().slice(0, 64) || 'default';
  return `${ANALYTICS_USAGE_PREFIX}:${t}:${String(day || '').slice(0, 10)}`;
}


/** ZSET of visitor ids scored by last-seen timestamp. */
export const ANALYTICS_ONLINE_KEY = 'analytics:online';
/** String — social-proof boost counter (real + auto-increment). */
export const SOCIAL_PROOF_BOOST_KEY = 'analytics:social_boost';
/** Hash of the social-proof auto-tick counters — ONE key for the whole ticker
 *  (fields: `last` = last tick timestamp, `today` = ticks today, `day` =
 *  YYYY-MM-DD stamp that resets the daily counter). */
export const ANALYTICS_TICKS_KEY = 'analytics:ticks';
export const TICKS_LAST_FIELD = 'last';
export const TICKS_TODAY_FIELD = 'today';
export const TICKS_DAY_FIELD = 'day';

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
/** String w/ TTL — per-IP request counter for a public rate-limited endpoint
 *  (`cache:rate:<namespace>:<ip>`). Ephemeral; lives under `cache:` because it
 *  can be deleted anytime without affecting correctness (it only throttles
 *  abuse). Every public endpoint that writes state should use this via
 *  `lib/rate-limit.ts` (`isRateLimited`) so a script can never hammer a route. */
export function rateLimitKey(namespace: string, ip: string): string {
  const ns = String(namespace || 'api').replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'api';
  return `cache:rate:${ns}:${String(ip || 'unknown').slice(0, 64)}`;
}

/** String w/ TTL — per-IP request counter for the PUBLIC `/api/checkout/auto-draw`
 *  trigger (kept as an alias of the generic helper for back-compat). */
export function autoDrawRateLimitKey(ip: string): string {
  return rateLimitKey('auto_draw', ip);
}

