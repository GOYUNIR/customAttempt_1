import test from 'node:test';
import assert from 'node:assert/strict';
import { flushSiteCache, FlushCacheError } from '../src/flush-client.ts';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(status: number, body: unknown): () => CapturedCall {
  let captured: CapturedCall = { url: '', init: {} };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    return captured;
  };
}

test('flushSiteCache: POSTs the hostname with a bearer secret and returns the payload', async () => {
  const capture = installFetchMock(200, { ok: true, siteKey: 'demo', flushedKeys: ['site_cache:v1:demo'] });

  const result = await flushSiteCache(
    'https://template-edge-renderer.example.workers.dev/',
    'flush-secret',
    'demo.yourplatform.com',
  );
  const captured = capture();
  const headers = new Headers(captured.init.headers);

  assert.equal(captured.url, 'https://template-edge-renderer.example.workers.dev/api/flush-cache');
  assert.equal(captured.init.method, 'POST');
  assert.equal(headers.get('authorization'), 'Bearer flush-secret');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(captured.init.body)), { hostname: 'demo.yourplatform.com' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.flushedKeys, ['site_cache:v1:demo']);
});

test('flushSiteCache: throws FlushCacheError with the server error on failure', async () => {
  const capture = installFetchMock(401, { ok: false, error: 'Unauthorized' });

  await assert.rejects(
    () => flushSiteCache('https://template-edge-renderer.example.workers.dev', 'wrong', 'demo.yourplatform.com'),
    (error: unknown) => {
      assert.ok(error instanceof FlushCacheError);
      assert.equal(error.message, 'Unauthorized');
      assert.equal(error.status, 401);
      return true;
    },
  );
  const captured = capture();
  assert.equal(captured.url, 'https://template-edge-renderer.example.workers.dev/api/flush-cache');
});

test('flushSiteCache: refuses an empty hostname without calling the network', async () => {
  await assert.rejects(
    () => flushSiteCache('https://template-edge-renderer.example.workers.dev', 'flush-secret', '   '),
    (error: unknown) => error instanceof FlushCacheError && error.status === 400,
  );
});
