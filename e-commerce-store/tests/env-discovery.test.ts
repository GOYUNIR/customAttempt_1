import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverEnvironment, computeAdminReady, detectStorageDrivers, detectStorageProvider } from '../lib/env-discovery.ts';

test('empty environment reports storage + admin as the blocking groups', () => {
  const result = discoverEnvironment({});
  assert.equal(result.blockingReady, false);
  assert.deepEqual(new Set(result.summary.blockingMissing), new Set(['storage', 'admin']));
});

test('full legacy env is blocking-ready and required-ready', () => {
  const result = discoverEnvironment({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'secret',
    ADMIN_BASIC_AUTH_PASSWORD: 'pw',
    ADMIN_VERIFY_EMAIL: 'admin@example.com',
    STRIPE_SECRET_KEY: 'sk_…',
    STRIPE_WEBHOOK_SECRET: 'whsec_…',
    CRON_SECRET: 'cron',
    NEXT_PUBLIC_URL: 'https://store.example',
  });
  assert.equal(result.blockingReady, true);
  assert.equal(result.requiredReady, true);
  assert.deepEqual(result.summary.blockingMissing, []);
  assert.deepEqual(result.summary.requiredMissing, []);
});

test('aliases satisfy checks (KV_REST_API_URL / KV_REST_API_TOKEN / SITE_URL)', () => {
  const result = discoverEnvironment({
    KV_REST_API_URL: 'https://kv.example',
    KV_REST_API_TOKEN: 'token',
    ADMIN_BASIC_AUTH_PASSWORD: 'pw',
    SITE_URL: 'https://site.example',
  });
  assert.equal(result.blockingReady, true);
  const redisUrl = result.all.find((c) => c.id === 'redis-url');
  assert.equal(redisUrl?.present, true);
  const siteUrl = result.all.find((c) => c.id === 'site-url');
  assert.equal(siteUrl?.present, true);
});

test('no individual check is blocking — blocking state is group-level', () => {
  const result = discoverEnvironment({});
  assert.equal(result.all.every((c) => c.blocking === false), true);
  const password = result.all.find((c) => c.id === 'admin-password');
  assert.equal(password?.required, true);
  assert.equal(password?.blocking, false);
});

test('bindings, license and bootstrap checks are non-blocking and not required', () => {
  const result = discoverEnvironment({});
  for (const id of ['binding-d1', 'binding-r2', 'binding-kv', 'binding-ai', 'license-key', 'license-server', 'initial-admin-email']) {
    const check = result.all.find((c) => c.id === id);
    assert.ok(check, `missing check ${id}`);
    assert.equal(check?.blocking, false, `${id} must not block`);
    assert.equal(check?.required, false, `${id} must not be required`);
    assert.equal(check?.present, false, `${id} defaults to absent`);
  }
  // Bindings carry a copyable wrangler.toml block.
  const d1 = result.all.find((c) => c.id === 'binding-d1');
  assert.match(d1?.wranglerToml || '', /\[\[d1_databases\]\]/);
  assert.ok((d1?.commands || []).some((c) => c.includes('wrangler d1 create')));
});

test('computeAdminReady unlocks on ANY storage driver + ANY admin method', () => {
  const redis = { supabase: false, cloudflare: false, redis: true };
  const cloudflare = { supabase: false, cloudflare: true, redis: false };
  const supabase = { supabase: true, cloudflare: false, redis: false };
  const none = { supabase: false, cloudflare: false, redis: false };

  // redis + password
  assert.equal(computeAdminReady({ storage: redis, legacyAdminOk: true, platformConfigured: null }), true);
  // no storage
  assert.equal(computeAdminReady({ storage: none, legacyAdminOk: true, platformConfigured: null }), false);
  // storage but no admin
  assert.equal(computeAdminReady({ storage: redis, legacyAdminOk: false, platformConfigured: null }), false);
  // Supabase super-admin satisfies BOTH storage and admin
  assert.equal(computeAdminReady({ storage: none, legacyAdminOk: false, platformConfigured: true }), true);
  // platformConfigured=false (wizard not run) does NOT count
  assert.equal(computeAdminReady({ storage: none, legacyAdminOk: false, platformConfigured: false }), false);
  // cloudflare driver + password
  assert.equal(computeAdminReady({ storage: cloudflare, legacyAdminOk: true, platformConfigured: null }), true);
  // supabase driver + password
  assert.equal(computeAdminReady({ storage: supabase, legacyAdminOk: true, platformConfigured: null }), true);
  // legacy password alone (no storage) still false
  assert.equal(computeAdminReady({ storage: none, legacyAdminOk: true, platformConfigured: false }), false);
});

test('detectStorageDrivers detects each driver independently', () => {
  const d = detectStorageDrivers({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });
  assert.equal(d.supabase, true);
  assert.equal(d.redis, true);
  assert.equal(d.cloudflare, false);
});

test('detectStorageDrivers honors STORAGE_PROVIDER for cloudflare + supabase needs full env', () => {
  assert.equal(detectStorageDrivers({ STORAGE_PROVIDER: 'cloudflare-kv' }).cloudflare, true);
  // supabase requires all three keys — partial env is not satisfied
  assert.equal(detectStorageDrivers({ STORAGE_PROVIDER: 'supabase' }).supabase, false);
  assert.equal(detectStorageDrivers({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a' }).supabase, false);
});

test('detectStorageProvider defaults to supabase and reflects the detected driver', () => {
  assert.equal(detectStorageProvider({}), 'supabase');
  assert.equal(
    detectStorageProvider({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }),
    'upstash',
  );
  assert.equal(detectStorageProvider({ STORAGE_PROVIDER: 'cloudflare-kv' }), 'cloudflare-kv');
  assert.equal(
    detectStorageProvider({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }),
    'supabase',
  );
});

test('discovery result shape carries groups and copyable commands', () => {
  const result = discoverEnvironment({});
  assert.ok(result.groups.length > 0);
  assert.equal(result.summary.total, result.all.length);
  assert.equal(result.summary.present, 0);
  const stripe = result.all.find((c) => c.id === 'stripe-secret');
  assert.ok(stripe?.commands.some((c) => c.includes('wrangler secret put STRIPE_SECRET_KEY')));
});
