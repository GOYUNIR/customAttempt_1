/**
 * lib/adapters/db.ts tests (node --test) — confirms the DbAdapter facade
 * translates select/insert/update/remove into the exact PostgREST requests
 * services/config/supabase-client.ts's supabaseRestFetch would make, without
 * re-implementing any HTTP logic of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDbAdapter } from '../lib/adapters/db.ts';

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

type Call = { url: string; method?: string; body?: string };

function installFetchMock(handler: (call: Call) => { ok: boolean; status: number; text: () => Promise<string> }) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { toString?: () => string }).toString?.() ?? input);
    const call: Call = { url, method: init?.method, body: init?.body as string };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('configured reflects whether SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are both set', async () => {
  await withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    assert.equal(getDbAdapter().configured, false);
  });
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, async () => {
    assert.equal(getDbAdapter().configured, true);
  });
});

test('select builds a GET against /<table>?<query>', async () => {
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, async () => {
    const { calls, restore } = installFetchMock(() => ({ ok: true, status: 200, text: async () => JSON.stringify([{ id: '1' }]) }));
    const rows = await getDbAdapter().select('products', 'tenant_id=eq.abc&limit=1');
    restore();
    assert.deepEqual(rows, [{ id: '1' }]);
    assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/products?tenant_id=eq.abc&limit=1');
    assert.equal(calls[0].method, 'GET');
  });
});

test('insert POSTs the rows and returns the representation', async () => {
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, async () => {
    const { calls, restore } = installFetchMock(() => ({ ok: true, status: 201, text: async () => JSON.stringify([{ id: '2' }]) }));
    const rows = await getDbAdapter().insert('products', { name: 'Test' });
    restore();
    assert.deepEqual(rows, [{ id: '2' }]);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body, JSON.stringify({ name: 'Test' }));
  });
});

test('update PATCHes /<table>?<query> with the patch body', async () => {
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, async () => {
    const { calls, restore } = installFetchMock(() => ({ ok: true, status: 200, text: async () => JSON.stringify([{ id: '3', name: 'Updated' }]) }));
    const rows = await getDbAdapter().update('products', 'id=eq.3', { name: 'Updated' });
    restore();
    assert.deepEqual(rows, [{ id: '3', name: 'Updated' }]);
    assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/products?id=eq.3');
    assert.equal(calls[0].method, 'PATCH');
  });
});

test('remove DELETEs /<table>?<query>', async () => {
  await withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, async () => {
    const { calls, restore } = installFetchMock(() => ({ ok: true, status: 204, text: async () => '' }));
    await getDbAdapter().remove('products', 'id=eq.3');
    restore();
    assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/products?id=eq.3');
    assert.equal(calls[0].method, 'DELETE');
  });
});

test('select rejects with a clear error when Supabase is not configured', async () => {
  await withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    await assert.rejects(() => getDbAdapter().select('products'), /not configured/i);
  });
});
