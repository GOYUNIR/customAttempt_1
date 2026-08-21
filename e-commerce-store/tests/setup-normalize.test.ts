/**
 * Setup wizard normalization — the AI engine is MANDATORY (primary) with an
 * OPTIONAL secondary fallback.
 *
 * `node --test` loads this with plain relative imports (no `@/` alias), the
 * same way `drivers.test.ts` does. The `platform-settings.ts` module it
 * imports is likewise free of `@/` aliases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatformSettingsInput } from '../services/config/platform-settings.ts';

const BASE = {
  mail_provider: 'resend',
  mail_api_key: 'x',
  payment_provider: 'stripe',
  payment_api_key: 'y',
  map_provider: 'open_street_map',
  ai_provider: 'deepseek',
  ai_api_key: 'x',
};

test('AI is mandatory — a missing / blank / "none" primary provider is rejected', () => {
  const omitted = normalizePlatformSettingsInput({ ...BASE, ai_provider: undefined, ai_api_key: undefined });
  assert.equal(omitted.ok, false);

  const explicitNone = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'none', ai_api_key: '' });
  assert.equal(explicitNone.ok, false);

  const blank = normalizePlatformSettingsInput({ ...BASE, ai_provider: '', ai_api_key: '' });
  assert.equal(blank.ok, false);
});

test('AI primary still requires a key when a real provider is selected', () => {
  const missingKey = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'deepseek', ai_api_key: '' });
  assert.equal(missingKey.ok, false);
});

test('AI primary accepts a valid provider + key (Workers AI needs none)', () => {
  const ok = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'deepseek', ai_api_key: 'sk-x' });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.input.ai_provider, 'deepseek');
    assert.equal(ok.input.ai_api_key, 'sk-x');
  }

  const workers = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'workers_ai', ai_api_key: '' });
  assert.ok(workers.ok);
  if (workers.ok) assert.equal(workers.input.ai_provider, 'workers_ai');
});

test('secondary AI fallback is optional (blank / none → null)', () => {
  const omitted = normalizePlatformSettingsInput(BASE);
  assert.ok(omitted.ok);
  if (omitted.ok) assert.equal(omitted.input.ai_provider_secondary, null);

  const explicitNone = normalizePlatformSettingsInput({ ...BASE, ai_provider_secondary: 'none', ai_api_key_secondary: '' });
  assert.ok(explicitNone.ok);
  if (explicitNone.ok) assert.equal(explicitNone.input.ai_provider_secondary, null);
});

test('secondary AI requires a key when a real provider is selected', () => {
  const missingKey = normalizePlatformSettingsInput({ ...BASE, ai_provider_secondary: 'deepseek_lite', ai_api_key_secondary: '' });
  assert.equal(missingKey.ok, false);
});

test('secondary AI accepts a valid provider + key', () => {
  const ok = normalizePlatformSettingsInput({ ...BASE, ai_provider_secondary: 'deepseek_lite', ai_api_key_secondary: 'sk-y' });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.input.ai_provider_secondary, 'deepseek_lite');
    assert.equal(ok.input.ai_api_key_secondary, 'sk-y');
  }
});

test('Payments are optional — missing / blank / "none" provider is accepted as "skip"', () => {
  const withAi = { mail_provider: 'resend', mail_api_key: 'x', map_provider: 'open_street_map', ai_provider: 'deepseek', ai_api_key: 'x' };
  const omitted = normalizePlatformSettingsInput(withAi);
  assert.ok(omitted.ok);
  if (omitted.ok) {
    assert.equal(omitted.input.payment_provider, null);
    assert.equal(omitted.input.payment_api_key, null);
  }

  const explicitNone = normalizePlatformSettingsInput({ ...withAi, payment_provider: 'none', payment_api_key: '' });
  assert.ok(explicitNone.ok);
  if (explicitNone.ok) assert.equal(explicitNone.input.payment_provider, null);

  const blank = normalizePlatformSettingsInput({ ...withAi, payment_provider: '', payment_api_key: '' });
  assert.ok(blank.ok);
  if (blank.ok) assert.equal(blank.input.payment_provider, null);
});

test('Payments still require a key when a real provider is selected', () => {
  const missingKey = normalizePlatformSettingsInput({ mail_provider: 'resend', mail_api_key: 'x', payment_provider: 'stripe', payment_api_key: '', map_provider: 'open_street_map', ai_provider: 'deepseek', ai_api_key: 'x' });
  assert.equal(missingKey.ok, false);
});
