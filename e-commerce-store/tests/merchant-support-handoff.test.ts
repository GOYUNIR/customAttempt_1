import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupportHandoff, redeemSupportHandoff, supportHandoffUrl } from '../lib/merchant-support-handoff.ts';
import { isPortalPathAllowed } from '../lib/edge-router.ts';

// A KV whose setIfAbsent is atomic (as store_kv's primary-key INSERT is).
function fakeKv(opts: { atomic?: boolean } = {}) {
  const m = new Map<string, string>();
  const kv: any = {
    m,
    get: async (k: string) => m.get(k) ?? null,
    del: async (...ks: string[]) => ks.filter((k) => m.delete(k)).length,
  };
  if (opts.atomic !== false) kv.setIfAbsent = async (k: string, v: string) => (m.has(k) ? false : (m.set(k, v), true));
  return kv;
}

test('a handoff code redeems once, for the session it was made for', async () => {
  const kv = fakeKv();
  const code = await createSupportHandoff(kv, 'tok-1', 'tenant-a');
  assert.match(String(code), /^[0-9a-f]{64}$/);
  assert.ok(![...kv.m.keys()].some((k: string) => k.includes(String(code))), 'only the hash is stored');
  assert.deepEqual(await redeemSupportHandoff(kv, String(code)), { token: 'tok-1', tenantId: 'tenant-a' });
  assert.equal(await redeemSupportHandoff(kv, String(code)), null, 'second use refused');
});

test('two simultaneous redemptions: exactly one wins', async () => {
  const kv = fakeKv();
  const code = String(await createSupportHandoff(kv, 'tok-2', 'tenant-a'));
  const results = await Promise.all([redeemSupportHandoff(kv, code), redeemSupportHandoff(kv, code), redeemSupportHandoff(kv, code)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('unknown, malformed or expired codes are refused; no atomic store = no handoff', async () => {
  const kv = fakeKv();
  assert.equal(await redeemSupportHandoff(kv, 'a'.repeat(64)), null);
  assert.equal(await redeemSupportHandoff(kv, 'not-a-code'), null);
  const code = String(await createSupportHandoff(kv, 'tok-3', 'tenant-a'));
  for (const [k, v] of kv.m) kv.m.set(k, JSON.stringify({ ...JSON.parse(v), expiresAt: Date.now() - 1 }));
  assert.equal(await redeemSupportHandoff(kv, code), null);
  assert.equal(await createSupportHandoff(fakeKv({ atomic: false }), 'tok-4', 'tenant-a'), null);
});

test('the code travels in the fragment, to the merchant host', () => {
  assert.equal(supportHandoffUrl('abc', 'example.com'), 'https://app.example.com/app/support#abc');
  assert.equal(supportHandoffUrl('abc', ''), '/app/support#abc');
});

test('the redeem endpoint answers on the merchant host only', () => {
  assert.equal(isPortalPathAllowed('/api/merchant-support/redeem', 'merchant', 'example.com'), true);
  for (const p of ['admin', 'sales', 'storefront', 'marketing'] as const) {
    assert.equal(isPortalPathAllowed('/api/merchant-support/redeem', p as any, 'example.com'), false, p);
  }
});
