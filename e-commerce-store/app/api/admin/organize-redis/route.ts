import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, ADMIN_DEVICES_KEY, OVERRIDES_KEY, OVERRIDE_SCHEDULE_FIELD, OVERRIDE_SOCIAL_PROOF_FIELD, ANALYTICS_TICKS_KEY, TICKS_LAST_FIELD, TICKS_TODAY_FIELD, TICKS_DAY_FIELD, STORED_CARTS_KEY, LAST_AUTO_DRAW_HASH_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { maintainDedupeStructures, sweepOrphanedProductState } from '@/lib/redis-maintenance';
import { pruneExpiredSupabaseKv } from '@/lib/storage/supabase';

export const dynamic = 'force-dynamic';

// ============================================================
// REDIS SCHEMA — TIDY & MIGRATE
//
// Redis is the primary data store, and every key now follows the tidy
// `domain:subdomain:…` schema defined in lib/redis-keys.ts (see that file for
// the namespace map + the mandatory rules for future agents).
//
// This endpoint is the ADMIN-DRIVEN migration path:
//   1. MIGRATE — any key still using a legacy name (drop_pool:*, intent_pool:*,
//      session:*, live_state, stats:*, config:promos, …) is RENAMED to its tidy
//      equivalent. Rename is atomic, preserves the value + TTL, and is skipped
//      when the target key already exists (never overwrites). Data is never
//      dropped — only moved.
//   2. CLEAN — removes the true legacy duplicate keys (product mirror hashes,
//      standalone image keys, the old catalog_config copy) that have no tidy
//      equivalent because they are redundant by design.
//
// The same migration a fresh install starts with. Safe to re-run anytime.
// ============================================================

/** old-key regex → new-key builder (keep in sync with lib/redis-keys.ts). */
const LEGACY_MIGRATIONS: { pattern: RegExp; to: (match: RegExpMatchArray) => string }[] = [
  { pattern: /^drop_pool:(.*)$/, to: (m) => `entries:pool:${m[1]}` },
  { pattern: /^intent_pool:(.*)$/, to: (m) => `entries:intent:${m[1]}` },
  { pattern: /^waitlist:(.*)$/, to: (m) => `entries:waitlist:${m[1]}` },
  { pattern: /^drop_fraud_block:(.*):emails$/, to: (m) => `entries:block:email:${m[1]}` },
  { pattern: /^drop_fraud_block:(.*):cards$/, to: (m) => `entries:block:card:${m[1]}` },
  { pattern: /^stats:pools$/, to: () => 'entries:stats' },
  { pattern: /^stats:social_proof_boost$/, to: () => 'analytics:social_boost' },
  { pattern: /^stats:social_proof_last_tick$/, to: () => 'analytics:ticks:last' },
  { pattern: /^stats:social_proof_ticks_today$/, to: () => 'analytics:ticks:today' },
  { pattern: /^stats:social_proof_ticks_day_stamp$/, to: () => 'analytics:ticks:day' },
  { pattern: /^drop_processed_sessions$/, to: () => 'entries:processed' },
  { pattern: /^drop_last_draw_summary$/, to: () => 'draws:last' },
  { pattern: /^admin:draw_history$/, to: () => 'draws:history' },
  { pattern: /^live_state$/, to: () => 'ops:live_state' },
  { pattern: /^catalog:archive_state$/, to: () => 'ops:catalog_archive' },
  { pattern: /^config:promos$/, to: () => 'promo:codes' },
  { pattern: /^config:recovery$/, to: () => 'ops:recovery_config' },
  { pattern: /^recovery:sent$/, to: () => 'ops:recovery_sent' },
  { pattern: /^alerts:waitlist$/, to: () => 'customer:waitlist' },
  { pattern: /^address:submissions$/, to: () => 'customer:addresses' },
  { pattern: /^email:entry_confirmed$/, to: () => 'entries:email_sent' },
  { pattern: /^promo:used_emails:(.*)$/, to: (m) => `promo:used:${m[1]}` },
  { pattern: /^promo:delivery_credit_issued:(.*)$/, to: (m) => `promo:credit:${m[1]}` },
  { pattern: /^promo:pending:(.*)$/, to: (m) => `promo:pending:${m[1]}` },
  { pattern: /^session:(.*)$/, to: (m) => `auth:session:${m[1]}` },
  { pattern: /^reset:(.*)$/, to: (m) => `auth:reset:${m[1]}` },
  { pattern: /^analytics:active_users_online$/, to: () => 'analytics:online' },
  { pattern: /^stripe:portal_config_id$/, to: () => 'cache:stripe_portal_config' },
  { pattern: /^config:drop_schedule$/, to: () => 'ops:override:schedule' },
  { pattern: /^config:social_proof$/, to: () => 'ops:override:social_proof' },
  { pattern: /^config:product:(.*)$/, to: (m) => `ops:override:product:${m[1]}` },
  { pattern: /^draw:last_auto:(.*)$/, to: (m) => `entries:last_auto:${m[1]}` },
];

/** True legacy duplicate keys that have NO tidy equivalent — safe to delete. */
const MIRROR_KEYS = [
  'store:active_products',
  'store:archived_products',
  'store:upcoming_products',
];
const CATALOG_CONFIG_KEY = 'store:catalog_config';
const PRODUCT_IMAGES_PREFIX = 'store:product_images:';

/** Rename an existing key to a new name, preserving TTL. Returns true on success. */
async function renamePreservingTtl(redis: any, oldKey: string, newKey: string): Promise<boolean> {
  try {
    const ttlMs = Number((await redis.pttl(oldKey)) ?? -1);
    // RENAMENX refuses to overwrite an existing target (no data loss).
    const renamed = await redis.renamenx(oldKey, newKey);
    if (!renamed) return false;
    // Re-apply the TTL explicitly so very old servers / REST shims behave identically.
    if (ttlMs > 0) {
      try {
        await redis.pexpire(newKey, ttlMs);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/** Type-aware copy+delete fallback for REST clients without RENAMENX. */
async function copyDeleteFallback(redis: any, oldKey: string, newKey: string): Promise<boolean> {
  try {
    const type = String((await redis.type(oldKey)) || '').toLowerCase();
    if (type === 'list') {
      const items = (await redis.lrange(oldKey, 0, -1)) || [];
      if (items.length > 0) await redis.rpush(newKey, ...items);
    } else if (type === 'set') {
      const members = (await redis.smembers(oldKey)) || [];
      if (members.length > 0) await redis.sadd(newKey, ...members);
    } else if (type === 'hash') {
      const hash = (await redis.hgetall(oldKey)) || {};
      if (Object.keys(hash).length > 0) await redis.hset(newKey, hash);
    } else {
      const value = await redis.get(oldKey);
      if (value != null) await redis.set(newKey, value);
    }
    await redis.del(oldKey);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const migrated: string[] = [];
    const skipped: string[] = [];
    const removed: string[] = [];

    // ── 1) Migrate every legacy-prefix key to the tidy schema ─────────────
    // Scan with the regex's fixed prefix (a key may match more than one
    // pattern, so dedupe with a Map<oldKey, newKey>).
    const pending = new Map<string, string>();
    for (const { pattern, to } of LEGACY_MIGRATIONS) {
      try {
        const prefix = pattern.source.replace(/[$^]/g, '');
        const found = (await redis.keys(`${prefix}*`)) as string[] | null;
        if (Array.isArray(found)) {
          for (const key of found) {
            const match = key.match(pattern);
            if (match && !pending.has(key)) pending.set(key, to(match));
          }
        }
      } catch {
        /* individual pattern failures are non-fatal */
      }
    }

    for (const [oldKey, newKey] of pending) {
      if (oldKey === newKey) continue;
      try {
        const targetExists = (await redis.exists(newKey)) > 0;
        if (targetExists) {
          skipped.push(`${oldKey} → ${newKey} (target already exists)`);
          continue;
        }
        const ok = (await renamePreservingTtl(redis, oldKey, newKey)) || (await copyDeleteFallback(redis, oldKey, newKey));
        if (ok) migrated.push(`${oldKey} → ${newKey}`);
        else skipped.push(`${oldKey} (could not migrate)`);
      } catch {
        skipped.push(`${oldKey} (migration error)`);
      }
    }

    // ── 2) Remove the true legacy duplicate keys (redundant by design) ─────
    for (const key of MIRROR_KEYS) {
      try {
        const exists = await redis.exists(key);
        if (exists) {
          await redis.del(key);
          removed.push(key);
        }
      } catch {}
    }

    try {
      const imageKeys = await redis.keys(`${PRODUCT_IMAGES_PREFIX}*`);
      if (Array.isArray(imageKeys) && imageKeys.length > 0) {
        await redis.del(...imageKeys);
        removed.push(`${PRODUCT_IMAGES_PREFIX}* (${imageKeys.length} keys)`);
      }
    } catch {}

    // ── 3) Fold legacy `admin:device:<token>` string keys into the single
    // `admin:devices` hash (field = token). Hash fields can't carry a per-field
    // TTL, so each folded value gains an explicit `expiresAt` derived from the
    // key's remaining TTL. Safe to re-run — tokens already folded are skipped.
    try {
      const deviceKeys = (await redis.keys('admin:device:*')) as string[] | null;
      if (Array.isArray(deviceKeys) && deviceKeys.length > 0) {
        const now = Date.now();
        for (const key of deviceKeys) {
          const token = key.slice('admin:device:'.length);
          try {
            // Already folded by a previous run — just drop the legacy key.
            const existing = await redis.hget(ADMIN_DEVICES_KEY, token);
            if (existing) {
              await redis.del(key);
              removed.push(`${key} (already folded into ${ADMIN_DEVICES_KEY})`);
              continue;
            }
            const raw = await redis.get(key);
            const ttlMs = Number((await redis.pttl(key).catch(() => -1)) ?? -1);
            const parsed = safeParseRedisItem<{ email?: string; createdAt?: number }>(raw) || {};
            await redis.hset(ADMIN_DEVICES_KEY, {
              [token]: JSON.stringify({
                email: String(parsed.email || ''),
                createdAt: Number(parsed.createdAt) || now,
                expiresAt: ttlMs > 0 ? now + ttlMs : now + 30 * 24 * 60 * 60 * 1000,
              }),
            });
            await redis.del(key);
            migrated.push(`${key} → ${ADMIN_DEVICES_KEY}#${token.slice(0, 8)}…`);
          } catch {
            skipped.push(`${key} (could not fold into ${ADMIN_DEVICES_KEY})`);
          }
        }
      }
    } catch {}

    // ── 4) FOLD v2 string keys into single hashes (KEY NEATNESS) ───────────
    // These namespaces used to grow ONE top-level key per thing (per product,
    // per size, per user, per ticker). They are now FIELDS of a single hash, so
    // the Redis browser stays tidy no matter how big the store gets. Existing
    // installs are folded losslessly here; a fresh install simply has nothing
    // to fold. Safe to re-run — the source keys are deleted after folding.
    const foldStringIntoHash = async (sourceKey: string, targetHash: string, field: string, list: string[]) => {
      try {
        const exists = await redis.exists(sourceKey);
        if (!exists) return;
        const value = await redis.get(sourceKey);
        if (value != null) {
          await redis.hset(targetHash, { [field]: String(value) });
          list.push(`${sourceKey} → ${targetHash}#${field}`);
        }
        await redis.del(sourceKey);
      } catch {
        /* non-fatal */
      }
    };

    // analytics:ticks:last / :today / :day → analytics:ticks#last|today|day
    await foldStringIntoHash('analytics:ticks:last', ANALYTICS_TICKS_KEY, TICKS_LAST_FIELD, migrated);
    await foldStringIntoHash('analytics:ticks:today', ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD, migrated);
    await foldStringIntoHash('analytics:ticks:day', ANALYTICS_TICKS_KEY, TICKS_DAY_FIELD, migrated);

    // ops:override:schedule / :social_proof → ops:overrides#schedule|social_proof
    await foldStringIntoHash('ops:override:schedule', OVERRIDES_KEY, OVERRIDE_SCHEDULE_FIELD, migrated);
    await foldStringIntoHash('ops:override:social_proof', OVERRIDES_KEY, OVERRIDE_SOCIAL_PROOF_FIELD, migrated);

    // ops:override:product:<id> → ops:overrides#product:<id>
    try {
      const productOverrideKeys = (await redis.keys('ops:override:product:*')) as string[] | null;
      if (Array.isArray(productOverrideKeys)) {
        for (const key of productOverrideKeys) {
          const productId = key.slice('ops:override:product:'.length);
          await foldStringIntoHash(key, OVERRIDES_KEY, `product:${productId}`, migrated);
        }
      }
    } catch {}

    // store:cart:<userId> → store:carts#<userId>
    try {
      const cartKeys = (await redis.keys('store:cart:*')) as string[] | null;
      if (Array.isArray(cartKeys)) {
        for (const key of cartKeys) {
          const userId = key.slice('store:cart:'.length);
          await foldStringIntoHash(key, STORED_CARTS_KEY, userId, migrated);
        }
      }
    } catch {}

    // entries:last_auto:<variant>:<size> → entries:last_auto#<variant>:<size>
    try {
      const lastAutoKeys = (await redis.keys('entries:last_auto:*')) as string[] | null;
      if (Array.isArray(lastAutoKeys)) {
        for (const key of lastAutoKeys) {
          const field = key.slice('entries:last_auto:'.length);
          await foldStringIntoHash(key, LAST_AUTO_DRAW_HASH_KEY, field, migrated);
        }
      }
    } catch {}

    // admin:verify_attempts:* / admin:send_attempts:* — transient rate-limit
    // counters that now live INSIDE the single `admin:verify:<email>` payload.
    // Safe to delete: they only throttle, and the challenge key carries the
    // same information going forward.
    try {
      for (const prefix of ['admin:verify_attempts:', 'admin:send_attempts:']) {
        const counters = (await redis.keys(`${prefix}*`)) as string[] | null;
        if (Array.isArray(counters)) {
          for (const key of counters) {
            await redis.del(key);
            removed.push(`${key} (folded into admin:verify:<email> payload)`);
          }
        }
      }
    } catch {}

    // 4) Migrate then drop the legacy catalog config copy. Manual entries edited
    //    in the admin Catalog tab are folded into store:config.catalogPreview
    //    (the canonical location) so nothing is lost before the old key dies.
    try {
      const catalogExists = await redis.exists(CATALOG_CONFIG_KEY);
      if (catalogExists) {
        const legacyCatalog = safeParseRedisItem<any>(await redis.get(CATALOG_CONFIG_KEY)) || {};
        const configRaw = await redis.get('store:config');
        const storeConfig = safeParseRedisItem<any>(configRaw) || {};
        const preview = storeConfig.catalogPreview || {};
        const upcomingDrops = Array.isArray(preview.upcomingDrops) ? preview.upcomingDrops : [];
        const archiveScents = Array.isArray(preview.archiveScents) ? preview.archiveScents : [];
        const legacyUpcoming = Array.isArray(legacyCatalog.upcomingDrops) ? legacyCatalog.upcomingDrops : [];
        const legacyArchive = Array.isArray(legacyCatalog.archiveScents) ? legacyCatalog.archiveScents : [];
        const dedupeBySlug = (items: any[]) =>
          items.filter((item, index, all) => all.findIndex((other) => String(other.slug || other.name) === String(item.slug || item.name)) === index);
        const merged = {
          ...storeConfig,
          catalogPreview: {
            upcomingDrops: dedupeBySlug([...upcomingDrops, ...legacyUpcoming]),
            archiveScents: dedupeBySlug([...archiveScents, ...legacyArchive]),
          },
          updatedAt: new Date().toISOString(),
        };
        if (JSON.stringify(merged) !== configRaw) {
          await redis.set('store:config', JSON.stringify(merged));
        }
        await redis.del(CATALOG_CONFIG_KEY);
        removed.push(`${CATALOG_CONFIG_KEY} (migrated into store:config.catalogPreview)`);
      }
    } catch {}

    // ── 5) Maintenance sweep: keep the tidy schema BOUNDED, not just named. ──
    //  a) `entries:processed` / `entries:email_sent` were unbounded SETS in
    //     older builds — migrate any legacy SET data to the timestamp-scored
    //     ZSET format and prune members past their retention windows.
    //  b) Per-product / per-user state (entries:stats, entries:last_auto,
    //     ops:overrides#product:<id>, ops:live_state, store:carts, pool keys)
    //     can outlive a deleted product/user — sweep every orphan.
    try {
      const prunedDedupe = await maintainDedupeStructures(redis);
      if (prunedDedupe > 0) removed.push(`dedupe sets (${prunedDedupe} expired members pruned)`);
    } catch {}
    try {
      const sweep = await sweepOrphanedProductState(redis);
      const totals = sweep.entriesStats + sweep.lastAuto + sweep.overrides + sweep.liveState + sweep.carts + sweep.emptyPools + sweep.orphanPools;
      if (totals > 0) removed.push(`orphan sweep (${sweep.entriesStats} stats, ${sweep.lastAuto} last-auto, ${sweep.overrides} overrides, ${sweep.liveState} live-states, ${sweep.carts} carts, ${sweep.emptyPools} empty pools, ${sweep.orphanPools} orphan pools)`);
    } catch {}
    // c) Supabase-backed store: prune expired `store_kv` rows (self-heal the KV
    //    table so dead keys never accumulate).
    try {
      if (await pruneExpiredSupabaseKv()) {
        removed.push('Supabase store_kv (expired rows pruned)');
      }
    } catch {}

    return NextResponse.json({
      success: true,
      message: migrated.length > 0
        ? `Migrated ${migrated.length} legacy key(s) to the tidy schema.`
        : 'Redis schema is already tidy.',
      migrated,
      skipped,
      removed,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Unable to tidy Redis' }, { status: 500 });
  }
}

