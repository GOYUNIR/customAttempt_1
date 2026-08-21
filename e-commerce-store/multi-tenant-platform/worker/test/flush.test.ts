import test from 'node:test';
import assert from 'node:assert/strict';
import { FLUSH_CACHE_PATH, handleFlushCache } from '../src/flush.ts';
import type { Env } from '../src/env.ts';

/** Minimal in-memory KVNamespace stand-in so tests can assert on keys. */
class MemoryKV {
  private readonly store = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SITE_CACHE: new MemoryKV() as unknown as KVNamespace,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    PLATFORM_ROOT_DOMAIN: 'yourplatform.com',
    CACHE_VERSION: '2',
    FLUSH_CACHE_SECRET: 'flush-secret',
    ...overrides,
  };
}

const FLUSH_URL = `https://template-edge-renderer.example.workers.dev${FLUSH_CACHE_PATH}`;

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(FLUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

test('flush: rejects non-POST methods with 405', async () => {
  const env = makeEnv();
  const res = await handleFlushCache(new Request(FLUSH_URL, { method: 'GET' }), env);
  assert.equal(res.status, 405);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? '', /POST only/);
});

test('flush: rejects missing or wrong bearer secret with 401', async () => {
  const env = makeEnv();
  const noAuth = await handleFlushCache(
    post(JSON.stringify({ hostname: 'demo.yourplatform.com' })),
    env,
  );
  assert.equal(noAuth.status, 401);

  const wrongSecret = await handleFlushCache(
    post(JSON.stringify({ hostname: 'demo.yourplatform.com' }), { authorization: 'Bearer wrong' }),
    env,
  );
  assert.equal(wrongSecret.status, 401);
});

test('flush: fails closed when no secret is configured', async () => {
  const env = makeEnv({ FLUSH_CACHE_SECRET: '' });
  const res = await handleFlushCache(
    post(JSON.stringify({ hostname: 'demo.yourplatform.com' }), { authorization: 'Bearer anything' }),
    env,
  );
  assert.equal(res.status, 401);
});

test('flush: rejects invalid JSON and a missing hostname with 400', async () => {
  const env = makeEnv();
  const auth = { authorization: 'Bearer flush-secret' };

  const badJson = await handleFlushCache(post('{nope', auth), env);
  assert.equal(badJson.status, 400);

  const noHost = await handleFlushCache(post(JSON.stringify({}), auth), env);
  assert.equal(noHost.status, 400);

  const wrongType = await handleFlushCache(post(JSON.stringify({ hostname: 42 }), auth), env);
  assert.equal(wrongType.status, 400);
});

test('flush: platform subdomain deletes every cached version of the tenant key only', async () => {
  const kv = new MemoryKV();
  const env = makeEnv({ SITE_CACHE: kv as unknown as KVNamespace, CACHE_VERSION: '2' });
  await kv.put('site_cache:v1:demo', '{"old":true}');
  await kv.put('site_cache:v2:demo', '{"current":true}');
  await kv.put('site_cache:v2:other', '{"keep":true}'); // unrelated tenant survives

  const res = await handleFlushCache(
    post(JSON.stringify({ hostname: 'demo.yourplatform.com' }), { authorization: 'Bearer flush-secret' }),
    env,
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; siteKey: string; flushedKeys: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.siteKey, 'demo');
  assert.deepEqual(body.flushedKeys, ['site_cache:v1:demo', 'site_cache:v2:demo']);
  assert.deepEqual(kv.keys(), ['site_cache:v2:other']);
});

test('flush: custom domain with www alias resolves to the bare-domain key', async () => {
  const kv = new MemoryKV();
  const env = makeEnv({ SITE_CACHE: kv as unknown as KVNamespace, CACHE_VERSION: '1' });
  await kv.put('site_cache:v1:shop.acme.com', '{"cached":true}');

  const res = await handleFlushCache(
    post(JSON.stringify({ hostname: 'www.shop.acme.com' }), { authorization: 'Bearer flush-secret' }),
    env,
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { siteKey: string; flushedKeys: string[] };
  assert.equal(body.siteKey, 'shop.acme.com');
  assert.deepEqual(body.flushedKeys, ['site_cache:v1:shop.acme.com']);
  assert.deepEqual(kv.keys(), []);
});

test('flush: bare tenant key (no domain) passes through', async () => {
  const kv = new MemoryKV();
  const env = makeEnv({ SITE_CACHE: kv as unknown as KVNamespace, CACHE_VERSION: '1' });

  const res = await handleFlushCache(
    post(JSON.stringify({ hostname: 'demo' }), { authorization: 'Bearer flush-secret' }),
    env,
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; siteKey: string; flushedKeys: string[] };
  assert.equal(body.siteKey, 'demo');
  assert.deepEqual(body.flushedKeys, ['site_cache:v1:demo']);
  assert.deepEqual(kv.keys(), []);
});
