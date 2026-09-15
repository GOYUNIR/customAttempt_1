import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProductionEnv, productionEnvHasBlockingIssues } from '../lib/env-schema.ts';

test('a completely empty env is valid (nothing configured yet is not an error)', () => {
  const { ok, errors, warnings } = validateProductionEnv({});
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

// Every fixture below is intentionally SHORT and low-entropy (never a
// plausible real key length) so it can never match a real provider's secret
// pattern or trip GitHub Secret Scanning / Push Protection, while still
// exercising lib/env-schema.ts's format-only regexes (none of which impose
// a minimum length beyond "one or more characters" — see that file).
test('well-formed real-shaped keys pass', () => {
  const { ok, errors } = validateProductionEnv({
    STRIPE_SECRET_KEY: 'sk_test_mock1',
    STRIPE_WEBHOOK_SECRET: 'whsec_mock1',
    RESEND_API_KEY: 're_mock1',
    SUPABASE_URL: 'https://abcdefghijklmno.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'aaa.bbb.ccc',
    UPSTASH_REDIS_REST_URL: 'https://example-instance.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'mock-token-1',
    NEXT_PUBLIC_MAPBOX_TOKEN: 'pk.mock1',
  });
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
});

test('a Stripe SECRET key format still passes the loose sk_/rk_ check (format only, not liveness)', () => {
  const { ok } = validateProductionEnv({ STRIPE_SECRET_KEY: 'sk_test_mock2' });
  assert.equal(ok, true);
});

test('a truncated/garbage Stripe key is a blocking error', () => {
  const { ok, errors } = validateProductionEnv({ STRIPE_SECRET_KEY: 'sk_liv' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'STRIPE_SECRET_KEY'));
});

test('a Stripe PRODUCT id pasted where a PRICE id belongs is a blocking error', () => {
  const { ok, errors } = validateProductionEnv({ STRIPE_PRODUCT_ID: 'prod_AbCdEfGh' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'STRIPE_PRODUCT_ID'));
});

test('a literal placeholder string is a blocking error, not a valid key', () => {
  const { ok, errors } = validateProductionEnv({ RESEND_API_KEY: 'your-key-here' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'RESEND_API_KEY'));
});

test('an unresolved platform template token ($VAR) is a blocking error', () => {
  const { ok, errors } = validateProductionEnv({ SUPABASE_URL: '$SUPABASE_URL' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'SUPABASE_URL'));
});

test('a secret Mapbox token (sk.) is flagged — it must never be the public token', () => {
  const { ok, errors } = validateProductionEnv({ NEXT_PUBLIC_MAPBOX_TOKEN: 'sk.mock1' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'NEXT_PUBLIC_MAPBOX_TOKEN'));
});

test('a Redis token with embedded whitespace (copy-paste newline) is a blocking error', () => {
  const { ok, errors } = validateProductionEnv({ UPSTASH_REDIS_REST_TOKEN: 'abc\ndef' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'UPSTASH_REDIS_REST_TOKEN'));
});

test('a short admin password is a WARNING, not a blocking error', () => {
  const { ok, errors, warnings } = validateProductionEnv({ ADMIN_BASIC_AUTH_PASSWORD: 'short1' });
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.field === 'ADMIN_BASIC_AUTH_PASSWORD'));
});

test('a short CRON_SECRET is a WARNING, not a blocking error', () => {
  const { ok, warnings } = validateProductionEnv({ CRON_SECRET: 'abc123' });
  assert.equal(ok, true);
  assert.ok(warnings.some((w) => w.field === 'CRON_SECRET'));
});

test('USE_POSTGRES_PRIMARY accepts true/false (any case), rejects other values', () => {
  assert.equal(validateProductionEnv({ USE_POSTGRES_PRIMARY: 'true' }).ok, true);
  assert.equal(validateProductionEnv({ USE_POSTGRES_PRIMARY: 'FALSE' }).ok, true);
  const { ok, errors } = validateProductionEnv({ USE_POSTGRES_PRIMARY: 'yes' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.field === 'USE_POSTGRES_PRIMARY'));
});

test('productionEnvHasBlockingIssues mirrors validateProductionEnv().ok', () => {
  assert.equal(productionEnvHasBlockingIssues({}), false);
  assert.equal(productionEnvHasBlockingIssues({ STRIPE_SECRET_KEY: 'nope' }), true);
});
