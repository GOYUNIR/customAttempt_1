/**
 * Setup wizard normalization — the AI engine is OPTIONAL.
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
};

test('AI is optional — a missing / blank / "none" provider is accepted as "skip"', () => {
  const omitted = normalizePlatformSettingsInput(BASE);
  assert.ok(omitted.ok);
  if (omitted.ok) {
    assert.equal(omitted.input.ai_provider, null);
    assert.equal(omitted.input.ai_api_key, undefined);
  }

  const explicitNone = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'none', ai_api_key: '' });
  assert.ok(explicitNone.ok);
  if (explicitNone.ok) assert.equal(explicitNone.input.ai_provider, null);

  const blank = normalizePlatformSettingsInput({ ...BASE, ai_provider: '', ai_api_key: '' });
  assert.ok(blank.ok);
  if (blank.ok) assert.equal(blank.input.ai_provider, null);
});

test('AI still requires a key when a real provider is selected', () => {
  const missingKey = normalizePlatformSettingsInput({ ...BASE, ai_provider: 'deepseek', ai_api_key: '' });
  assert.equal(missingKey.ok, false);
});
