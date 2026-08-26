import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStorageProvider, resolveReplicaProviders, normalizeStorageProvider, STORAGE_PROVIDER_ENV, STORAGE_REPLICAS_ENV } from '../lib/storage/types.ts';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  const keys = [STORAGE_PROVIDER_ENV, STORAGE_REPLICAS_ENV, 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
  for (const k of keys) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('explicit STORAGE_PROVIDER wins over auto-detection', () => {
  withEnv({ [STORAGE_PROVIDER_ENV]: 'upstash', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sk' }, () => {
    assert.equal(resolveStorageProvider(), 'upstash');
  });
  withEnv({ [STORAGE_PROVIDER_ENV]: 'cloudflare-kv', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sk' }, () => {
    assert.equal(resolveStorageProvider(), 'cloudflare-kv');
  });
  withEnv({ [STORAGE_PROVIDER_ENV]: 'supabase' }, () => {
    assert.equal(resolveStorageProvider(), 'supabase');
  });
});

test('Supabase is the DEFAULT primary store when its env is present', () => {
  withEnv({ [STORAGE_PROVIDER_ENV]: undefined, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sk' }, () => {
    assert.equal(resolveStorageProvider(), 'supabase');
  });
  // anon key alone also satisfies the default detection
  withEnv({ [STORAGE_PROVIDER_ENV]: undefined, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' }, () => {
    assert.equal(resolveStorageProvider(), 'supabase');
  });
});

test('defaults to supabase when nothing is detected (Supabase is the default primary store)', () => {
  withEnv({ [STORAGE_PROVIDER_ENV]: undefined, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, () => {
    assert.equal(resolveStorageProvider(), 'supabase');
  });
});

test('normalizeStorageProvider maps tokens + rejects unknown', () => {
  assert.equal(normalizeStorageProvider('supabase'), 'supabase');
  assert.equal(normalizeStorageProvider('redis'), 'upstash');
  assert.equal(normalizeStorageProvider('cloudflare-kv'), 'cloudflare-kv');
  assert.equal(normalizeStorageProvider('d1'), 'cloudflare-kv');
  assert.equal(normalizeStorageProvider(''), null);
  assert.equal(normalizeStorageProvider('bogus'), null);
});

test('resolveReplicaProviders parses comma/space lists + dedupes + drops unknown', () => {
  withEnv({ [STORAGE_REPLICAS_ENV]: 'upstash' }, () => {
    assert.deepEqual(resolveReplicaProviders(), ['upstash']);
  });
  withEnv({ [STORAGE_REPLICAS_ENV]: 'upstash, supabase, upstash' }, () => {
    assert.deepEqual(resolveReplicaProviders(), ['upstash', 'supabase']);
  });
  withEnv({ [STORAGE_REPLICAS_ENV]: 'upstash bogus cloudflare-kv' }, () => {
    assert.deepEqual(resolveReplicaProviders(), ['upstash', 'cloudflare-kv']);
  });
  withEnv({ [STORAGE_REPLICAS_ENV]: '' }, () => {
    assert.deepEqual(resolveReplicaProviders(), []);
  });
});
