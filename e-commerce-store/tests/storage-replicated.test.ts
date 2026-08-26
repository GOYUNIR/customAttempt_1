import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudflareKvClient } from '../lib/storage/cloudflare-kv.ts';
import { ReplicatedStorageClient } from '../lib/storage/replicated.ts';
import type { StorageClient } from '../lib/storage/types.ts';

/**
 * ReplicatedStorageClient — write-through mirroring + read failover.
 * Uses two independent in-memory KV stores (each `createCloudflareKvClient()`
 * builds a fresh store) plus a throwing mock to prove failover.
 */

test('writes mirror to the replica and reads come from the primary', async () => {
  const primary = createCloudflareKvClient();
  const replica = createCloudflareKvClient();
  const client = new ReplicatedStorageClient(primary, [replica]);

  await client.set('k', 'v');
  await client.hset('h', { a: '1' });
  await client.rpush('list', 'x');

  // primary read
  assert.equal(await client.get('k'), 'v');
  assert.deepEqual(await client.hgetall('h'), { a: '1' });
  assert.deepEqual(await client.lrange('list', 0, -1), ['x']);

  // the replica received the mirror writes directly
  assert.equal(await replica.get('k'), 'v');
  assert.deepEqual(await replica.hgetall('h'), { a: '1' });
  assert.deepEqual(await replica.lrange('list', 0, -1), ['x']);
});

test('a downed replica never breaks a write (primary result still returns)', async () => {
  const primary = createCloudflareKvClient();
  const broken: StorageClient = {
    ...createCloudflareKvClient(),
    set: () => Promise.reject(new Error('replica down')),
  };
  const client = new ReplicatedStorageClient(primary, [broken]);
  const result = await client.set('k', 'v');
  assert.ok(result !== undefined);
  assert.equal(await primary.get('k'), 'v');
});

test('a primary write error propagates to the caller', async () => {
  const primary: StorageClient = {
    ...createCloudflareKvClient(),
    set: () => Promise.reject(new Error('primary down')),
  };
  const replica = createCloudflareKvClient();
  const client = new ReplicatedStorageClient(primary, [replica]);
  await assert.rejects(() => client.set('k', 'v'), /primary down/);
});

test('reads fail over to the replica when the primary throws', async () => {
  const replica = createCloudflareKvClient();
  await replica.set('k', 'from-replica');
  const primary: StorageClient = {
    ...createCloudflareKvClient(),
    get: () => Promise.reject(new Error('primary down')),
  };
  const client = new ReplicatedStorageClient(primary, [replica]);
  assert.equal(await client.get('k'), 'from-replica');
});

test('reads fail over to the replica when the primary returns empty', async () => {
  const replica = createCloudflareKvClient();
  await replica.hset('h', { a: '1' });
  const primary = createCloudflareKvClient(); // empty
  const client = new ReplicatedStorageClient(primary, [replica]);
  assert.deepEqual(await client.hgetall('h'), { a: '1' });
});
