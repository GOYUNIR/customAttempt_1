/**
 * Supabase credential resolution tests (node --test).
 *
 * Locks in the behavior the Supabase STORAGE adapter (lib/storage/supabase.ts)
 * depends on: `readSupabaseEnv()` must honor the inline runtime override (the
 * Setup Wizard) AND the NEXT_PUBLIC_* aliases, and `supabaseServiceConfigured()`
 * must require the service-role key (because `store_kv` has RLS enabled with no
 * anon policy — the anon key can neither read nor write it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readSupabaseEnv,
  setSupabaseRuntimeCredentials,
  supabaseConfigured,
  supabaseServiceConfigured,
  supabaseServiceConfiguredFromEnv,
} from '../services/config/supabase-client.ts';

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setSupabaseRuntimeCredentials(null);
  }
}

test('readSupabaseEnv: honors the NEXT_PUBLIC_* aliases', () => {
  withEnv(
    {
      SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_URL: 'https://alias.supabase.co/',
      SUPABASE_ANON_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-alias',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
    },
    () => {
      const env = readSupabaseEnv();
      assert.equal(env.url, 'https://alias.supabase.co');
      assert.equal(env.anonKey, 'anon-alias');
      assert.equal(env.serviceRoleKey, 'svc');
    },
  );
});

test('readSupabaseEnv: inline runtime override wins over process.env', () => {
  withEnv(
    { SUPABASE_URL: 'https://env.supabase.co', SUPABASE_ANON_KEY: 'anon-env', SUPABASE_SERVICE_ROLE_KEY: 'svc-env' },
    () => {
      setSupabaseRuntimeCredentials({ url: 'https://wizard.supabase.co', anonKey: 'anon-wizard', serviceRoleKey: 'svc-wizard' });
      const env = readSupabaseEnv();
      assert.equal(env.url, 'https://wizard.supabase.co');
      assert.equal(env.anonKey, 'anon-wizard');
      assert.equal(env.serviceRoleKey, 'svc-wizard');
    },
  );
});

test('supabaseServiceConfigured: requires the service-role key (store_kv RLS)', () => {
  withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: undefined }, () => {
    assert.equal(supabaseConfigured(), true); // anon alone satisfies the public RPC gate
    assert.equal(supabaseServiceConfigured(), false); // storage needs the service role
  });
  withEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, () => {
    assert.equal(supabaseServiceConfigured(), true);
  });
});

test('supabaseServiceConfiguredFromEnv: ignores the runtime override', () => {
  withEnv({ SUPABASE_URL: 'https://env.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-env' }, () => {
    setSupabaseRuntimeCredentials({ url: 'https://wizard.supabase.co', serviceRoleKey: 'svc-wizard' });
    assert.equal(supabaseServiceConfiguredFromEnv(), true);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(supabaseServiceConfiguredFromEnv(), false); // override alone is NOT env
    assert.equal(supabaseServiceConfigured(), true); // but it still satisfies the general check
  });
});
