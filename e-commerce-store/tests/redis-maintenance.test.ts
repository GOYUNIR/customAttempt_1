import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudflareKvClient } from '../lib/storage/cloudflare-kv.ts';
import type { StorageClient } from '../lib/storage/types.ts';
import {
  ensureDedupeZset,
  isDedupeMember,
  markDedupeMember,
  markProcessedSession,
  isProcessedSession,
  maintainDedupeStructures,
  sweepOrphanedProductState,
} from '../lib/redis-maintenance.ts';
import {
  PROCESSED_SESSIONS_KEY,
  PRODUCTS_KEY,
  USERS_KEY,
  STORED_CARTS_KEY,
  LIVE_STATE_KEY,
  OVERRIDES_KEY,
  POOL_STATS_KEY,
  LAST_AUTO_DRAW_HASH_KEY,
  POOL_KEY_PREFIX,
} from '../lib/redis-keys.ts';

function kv(): StorageClient {
  const client = createCloudflareKvClient();
  assert.ok(client, 'factory never returns null');
  return client;
}

test('bounded dedupe: mark + membership + expiry pruning', async () => {
  const c = kv();
  const key = 'entries:test:dedupe';

  await c.del(key);
  assert.equal(await isDedupeMember(c, key, 'member-a'), false);

  await markDedupeMember(c, key, 'member-a', 10_000);
  assert.equal(await isDedupeMember(c, key, 'member-a'), true);

  // An expired member is pruned by the NEXT mark, keeping the set bounded.
  await markDedupeMember(c, key, 'old', 0); // window 0 → immediately expired
  await markDedupeMember(c, key, 'fresh', 60_000);
  assert.equal(await isDedupeMember(c, key, 'fresh'), true);
  assert.equal(await isDedupeMember(c, key, 'old'), false);
  assert.equal(await c.type(key), 'zset');

  await c.del(key);
});

test('bounded dedupe: legacy SET is self-migrated to ZSET', async () => {
  const c = kv();
  const key = 'entries:test:migrate';

  await c.del(key);
  await c.sadd(key, 'legacy-1', 'legacy-2');
  assert.equal(await c.type(key), 'set');

  await ensureDedupeZset(c, key);
  assert.equal(await c.type(key), 'zset');
  assert.equal(await isDedupeMember(c, key, 'legacy-1'), true);
  assert.equal(await isDedupeMember(c, key, 'legacy-2'), true);
  // New bounded member coexists with migrated ones.
  await markDedupeMember(c, key, 'new', 60_000);
  assert.equal(await isDedupeMember(c, key, 'new'), true);

  await c.del(key);
});

test('markProcessedSession / isProcessedSession round-trip', async () => {
  const c = kv();
  await c.del(PROCESSED_SESSIONS_KEY);
  assert.equal(await isProcessedSession(c, 'cs_test_abc'), false);
  await markProcessedSession(c, 'cs_test_abc');
  assert.equal(await isProcessedSession(c, 'cs_test_abc'), true);
  assert.equal(await c.type(PROCESSED_SESSIONS_KEY), 'zset');
  await c.del(PROCESSED_SESSIONS_KEY);
});

test('sweepOrphanedProductState prunes deleted-product/user state and keeps live state', async () => {
  const c = kv();

  // Canonical product + user (the "live" records that must be KEPT).
  await c.hset(PRODUCTS_KEY, {
    p1: JSON.stringify({ id: 'p1', name: 'Elysian White' }),
    p2: JSON.stringify({ id: 'p2', name: 'Obsidian Void' }),
  });
  await c.hset(USERS_KEY, { u1: JSON.stringify({ id: 'u1', email: 'a@b.co' }) });

  // Live state: keep fields for p1 / p2, orphan for a deleted product px.
  await c.hset(LIVE_STATE_KEY, {
    'p1-elysian-white:Standard': JSON.stringify({ productId: 'p1' }),
    'p2-obsidian-void:Standard': JSON.stringify({ productId: 'p2' }),
    'px-ghost:Standard': JSON.stringify({ productId: 'px' }),
  });

  // Stats / last-auto: keep p1+p2, orphan names that no longer exist.
  await c.hset(POOL_STATS_KEY, {
    'sub:elysian white:Standard': '5',
    'int:obsidian void:Standard': '2',
    'sub:ghost drop:Standard': '3',
  });
  await c.hset(LAST_AUTO_DRAW_HASH_KEY, {
    'elysian white:Standard': '123',
    'ghost drop:Standard': '999',
  });

  // Overrides: keep schedule + p1 override; orphan the px override.
  await c.hset(OVERRIDES_KEY, {
    schedule: JSON.stringify({ drawHour: 21 }),
    'product:p1': JSON.stringify({ releaseEndsAt: 'x' }),
    'product:px': JSON.stringify({ releaseEndsAt: 'y' }),
  });

  // Carts: keep u1, orphan u9.
  await c.hset(STORED_CARTS_KEY, { u1: JSON.stringify([]), u9: JSON.stringify([]) });

  // Pools: keep a live pool; drop an orphan + an empty one.
  await c.rpush(`${POOL_KEY_PREFIX}elysian white:Standard`, JSON.stringify({ email: 'x@y.z' }));
  await c.rpush(`${POOL_KEY_PREFIX}ghost drop:Standard`, JSON.stringify({ email: 'g@y.z' }));
  await c.rpush('entries:intent:elysian white:Standard', JSON.stringify({ email: 'i@y.z' }));
  // (empty list key)
  await c.rpush('entries:waitlist:empty:Standard');

  const sweep = await sweepOrphanedProductState(c);

  assert.equal(sweep.entriesStats, 1); // ghost drop stat removed
  assert.equal(sweep.lastAuto, 1); // ghost drop last-auto removed
  assert.equal(sweep.overrides, 1); // product:px removed
  assert.equal(sweep.liveState, 1); // px-ghost removed
  assert.equal(sweep.carts, 1); // u9 removed
  assert.equal(sweep.orphanPools, 1); // ghost drop pool removed
  assert.equal(sweep.emptyPools, 1); // empty waitlist removed

  // KEPT records are untouched.
  assert.ok((await c.hget(LIVE_STATE_KEY, 'p1-elysian-white:Standard')) != null);
  assert.ok((await c.hget(POOL_STATS_KEY, 'sub:elysian white:Standard')) != null);
  assert.ok((await c.hget(LAST_AUTO_DRAW_HASH_KEY, 'elysian white:Standard')) != null);
  assert.ok((await c.hget(OVERRIDES_KEY, 'product:p1')) != null);
  assert.ok((await c.hget(STORED_CARTS_KEY, 'u1')) != null);
  assert.ok((await c.lrange(`${POOL_KEY_PREFIX}elysian white:Standard`, 0, -1)).length === 1);

  // REMOVED records are gone.
  assert.equal(await c.hget(LIVE_STATE_KEY, 'px-ghost:Standard'), null);
  assert.equal(await c.hget(POOL_STATS_KEY, 'sub:ghost drop:Standard'), null);
  assert.equal(await c.hget(LAST_AUTO_DRAW_HASH_KEY, 'ghost drop:Standard'), null);
  assert.equal(await c.hget(OVERRIDES_KEY, 'product:px'), null);
  assert.equal(await c.hget(STORED_CARTS_KEY, 'u9'), null);

  // Cleanup: leave the shared in-memory store tidy for other tests.
  await c.del(PRODUCTS_KEY, USERS_KEY, LIVE_STATE_KEY, POOL_STATS_KEY, LAST_AUTO_DRAW_HASH_KEY, OVERRIDES_KEY, STORED_CARTS_KEY);
  await c.del(`${POOL_KEY_PREFIX}elysian white:Standard`);
  await c.del('entries:intent:elysian white:Standard');
});

test('maintainDedupeStructures migrates + prunes both named dedupe keys', async () => {
  const c = kv();
  await c.del(PROCESSED_SESSIONS_KEY);
  await c.sadd(PROCESSED_SESSIONS_KEY, 'legacy-session');
  const pruned = await maintainDedupeStructures(c);
  assert.equal(typeof pruned, 'number');
  assert.equal(await c.type(PROCESSED_SESSIONS_KEY), 'zset');
  assert.equal(await isProcessedSession(c, 'legacy-session'), true);
  await c.del(PROCESSED_SESSIONS_KEY);
});

