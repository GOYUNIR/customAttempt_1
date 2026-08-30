/**
 * Partial provider-keys updates ("API Keys & Integrations" panel).
 *
 * API keys are write-only — the server never echoes the stored VALUES back to
 * the browser — so the admin re-save path must PRESERVE a key when its field is
 * left blank (and the provider is unchanged), while still requiring a key when
 * the operator switches to a NEW provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatformSettingsPatch } from '../services/config/platform-settings.ts';
import type { GlobalPlatformSettings } from '../services/config/types.ts';

const existing = (overrides: Partial<GlobalPlatformSettings> = {}): GlobalPlatformSettings => ({
  id: '00000000-0000-0000-0000-0000000000c0',
  is_configured: true,
  mail_provider: 'resend',
  mail_api_key: 're_old',
  payment_provider: 'stripe',
  payment_api_key: 'sk_old',
  payment_webhook_secret: 'whsec_old',
  stripe_price_id: 'price_old',
  map_provider: 'mapbox',
  map_api_key: 'pk_old',
  ai_provider: 'deepseek',
  ai_api_key: 'sk_ai_old',
  ai_provider_secondary: null,
  ai_api_key_secondary: null,
  ...overrides,
});

const FULL_PATCH = {
  mail_provider: 'resend',
  mail_api_key: '',
  payment_provider: 'stripe',
  payment_api_key: 'sk_new',
  payment_webhook_secret: '',
  stripe_price_id: '',
  map_provider: 'mapbox',
  map_api_key: '',
  ai_provider: 'deepseek',
  ai_api_key: '',
  ai_provider_secondary: '',
  ai_api_key_secondary: '',
};

test('preserves stored keys when their fields are left blank (partial update)', () => {
  const result = normalizePlatformSettingsPatch(FULL_PATCH, existing());
  assert.ok(result.ok);
  if (!result.ok) return;

  // Only the payment key was supplied — everything else is preserved/cleared.
  assert.equal(result.input.payment_api_key, 'sk_new');
  assert.equal(result.input.mail_api_key, 're_old');
  assert.equal(result.input.payment_webhook_secret, 'whsec_old');
  assert.equal(result.input.map_api_key, 'pk_old');
  assert.equal(result.input.ai_api_key, 'sk_ai_old');
  // stripe_price_id is NOT a secret (it is echoed back), so blank clears it.
  assert.equal(result.input.stripe_price_id, undefined);
});

test('clears a category when its provider is set to blank / none', () => {
  const none = normalizePlatformSettingsPatch({ ...FULL_PATCH, mail_provider: 'none', mail_api_key: '' }, existing());
  assert.ok(none.ok);
  if (none.ok) {
    assert.equal(none.input.mail_provider, null);
    assert.equal(none.input.mail_api_key, null);
  }

  const blank = normalizePlatformSettingsPatch({ ...FULL_PATCH, mail_provider: '', mail_api_key: '' }, existing());
  assert.ok(blank.ok);
  if (blank.ok) {
    assert.equal(blank.input.mail_provider, null);
    assert.equal(blank.input.mail_api_key, null);
  }
});

test('requires a key when switching to a different provider', () => {
  const result = normalizePlatformSettingsPatch({ ...FULL_PATCH, mail_provider: 'sendgrid', mail_api_key: '' }, existing());
  assert.equal(result.ok, false);
});

test('secondary DeepSeek reuses the primary key without writing the secondary column', () => {
  const result = normalizePlatformSettingsPatch(
    { ...FULL_PATCH, ai_provider_secondary: 'deepseek_lite', ai_api_key_secondary: '' },
    existing(),
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.input.ai_provider_secondary, 'deepseek_lite');
    assert.equal(result.input.ai_api_key_secondary, undefined);
  }
});

test('preserves a secondary key when left blank and the provider is unchanged', () => {
  const result = normalizePlatformSettingsPatch(
    { ...FULL_PATCH, ai_provider_secondary: 'openai', ai_api_key_secondary: '' },
    existing({ ai_provider_secondary: 'openai', ai_api_key_secondary: 'sk_sec_old' }),
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.input.ai_provider_secondary, 'openai');
    assert.equal(result.input.ai_api_key_secondary, 'sk_sec_old');
  }
});

test('requires a key on a fresh store when a provider is selected with no key', () => {
  const result = normalizePlatformSettingsPatch({ payment_provider: 'stripe', payment_api_key: '' }, null);
  assert.equal(result.ok, false);
});
