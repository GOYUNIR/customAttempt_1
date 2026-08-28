import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseOperationalSettings,
  hasOperationalSettings,
  OPERATIONAL_SETTING_KEYS,
} from '../services/config/types.ts';
import { normalizeOperationalSettingsInput } from '../services/config/platform-settings.ts';

test('parseOperationalSettings keeps only whitelisted non-blank keys', () => {
  const out = parseOperationalSettings({
    site_url: 'https://example.com',
    brand_name: '  My Brand  ',
    stripe_secret_key: 'sk_abc',
    evil_key: 'nope',
    blank: '',
    supabase_url: '   ',
    nested: { a: 1 },
    count: 42,
  });
  assert.equal(out.site_url, 'https://example.com');
  assert.equal(out.brand_name, 'My Brand');
  assert.equal(out.stripe_secret_key, 'sk_abc');
  assert.equal('evil_key' in out, false);
  assert.equal('blank' in out, false);
  assert.equal('supabase_url' in out, false); // blank → dropped
  assert.equal('nested' in out, false);
});

test('parseOperationalSettings returns {} for null / array / garbage', () => {
  assert.deepEqual(parseOperationalSettings(null), {});
  assert.deepEqual(parseOperationalSettings(undefined), {});
  assert.deepEqual(parseOperationalSettings([1, 2]), {});
  assert.deepEqual(parseOperationalSettings('nope'), {});
});

test('hasOperationalSettings detects a populated blob', () => {
  assert.equal(hasOperationalSettings(null), false);
  assert.equal(hasOperationalSettings(undefined), false);
  assert.equal(hasOperationalSettings({}), false);
  assert.equal(hasOperationalSettings({ admin_basic_auth_password: 'x' }), true);
});

test('normalizeOperationalSettingsInput round-trips a wizard payload', () => {
  const normalized = normalizeOperationalSettingsInput({
    storage_provider: 'upstash',
    upstash_redis_rest_url: 'https://x.upstash.io',
    cron_secret: 'secret',
    stripe_secret_key: 'sk_live_x',
    openai_api_key: 'sk-openai',
    site_url: 'https://shop.example.com',
    unrelated: 'drop-me',
  });
  assert.equal(normalized.storage_provider, 'upstash');
  assert.equal(normalized.upstash_redis_rest_url, 'https://x.upstash.io');
  assert.equal(normalized.cron_secret, 'secret');
  assert.equal(normalized.stripe_secret_key, 'sk_live_x');
  assert.equal(normalized.openai_api_key, 'sk-openai');
  assert.equal('unrelated' in normalized, false);
});

test('OPERATIONAL_SETTING_KEYS covers the full provider matrix', () => {
  const required = [
    'storage_provider',
    'storage_replicas',
    'upstash_redis_rest_url',
    'cloudflare_kv_binding',
    'admin_basic_auth_password',
    'cron_secret',
    'stripe_secret_key',
    'deepseek_api_key',
    'replicate_api_token',
    'site_url',
    'support_email',
  ];
  for (const k of required) assert.ok(OPERATIONAL_SETTING_KEYS.includes(k), k);
});

test('OPERATIONAL_SETTING_KEYS never persists Supabase database credentials', () => {
  // The Supabase trio is verified as a TRANSIENT runtime check only — it must
  // never be written to the site's persistent settings row.
  assert.equal(OPERATIONAL_SETTING_KEYS.includes('supabase_url'), false);
  assert.equal(OPERATIONAL_SETTING_KEYS.includes('supabase_anon_key'), false);
  assert.equal(OPERATIONAL_SETTING_KEYS.includes('supabase_service_role_key'), false);
});
