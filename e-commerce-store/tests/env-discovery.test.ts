import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverEnvironment, computeAdminReady } from '../lib/env-discovery.ts';

test('empty environment reports the three blocking checks as missing', () => {
  const result = discoverEnvironment({});
  assert.equal(result.blockingReady, false);
  assert.deepEqual(new Set(result.summary.blockingMissing), new Set(['redis-url', 'redis-token', 'admin-password']));
});

test('full legacy env is blocking-ready and required-ready', () => {
  const result = discoverEnvironment({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'secret',
    ADMIN_BASIC_AUTH_USERNAME: 'admin',
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

test('admin password is blocking but username is not (defaults to admin)', () => {
  const result = discoverEnvironment({});
  const username = result.all.find((c) => c.id === 'admin-username');
  const password = result.all.find((c) => c.id === 'admin-password');
  assert.equal(username?.blocking, false);
  assert.equal(password?.blocking, true);
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

test('computeAdminReady requires storage AND an admin account', () => {
  assert.equal(computeAdminReady({ storageOk: true, legacyAdminOk: true, platformConfigured: null }), true);
  assert.equal(computeAdminReady({ storageOk: false, legacyAdminOk: true, platformConfigured: null }), false);
  assert.equal(computeAdminReady({ storageOk: true, legacyAdminOk: false, platformConfigured: null }), false);
  // Supabase super-admin satisfies the admin-account requirement.
  assert.equal(computeAdminReady({ storageOk: true, legacyAdminOk: false, platformConfigured: true }), true);
  assert.equal(computeAdminReady({ storageOk: false, legacyAdminOk: false, platformConfigured: true }), false);
  // platformConfigured=false (wizard not run) does NOT count as an admin account.
  assert.equal(computeAdminReady({ storageOk: true, legacyAdminOk: true, platformConfigured: false }), true);
  assert.equal(computeAdminReady({ storageOk: true, legacyAdminOk: false, platformConfigured: false }), false);
});

test('discovery result shape carries groups and copyable commands', () => {
  const result = discoverEnvironment({});
  assert.ok(result.groups.length > 0);
  assert.equal(result.summary.total, result.all.length);
  assert.equal(result.summary.present, 0);
  const stripe = result.all.find((c) => c.id === 'stripe-secret');
  assert.ok(stripe?.commands.some((c) => c.includes('wrangler secret put STRIPE_SECRET_KEY')));
});
