import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIDY_REDIS_ACTION_LABEL,
  API_KEYS_INTEGRATIONS_LABEL,
  dataStoreDisplayName,
  tidyDataStoreActionLabel,
} from '../lib/admin-action-labels.ts';

test('legacy canonical labels stay stable', () => {
  assert.equal(TIDY_REDIS_ACTION_LABEL, 'Tidy & Migrate Redis Schema');
  assert.equal(API_KEYS_INTEGRATIONS_LABEL, 'API Keys & Integrations');
});

test('dataStoreDisplayName maps every supported storage provider', () => {
  assert.equal(dataStoreDisplayName('supabase'), 'Supabase');
  assert.equal(dataStoreDisplayName('postgres'), 'Supabase');
  assert.equal(dataStoreDisplayName('upstash'), 'Redis');
  assert.equal(dataStoreDisplayName('redis'), 'Redis');
  assert.equal(dataStoreDisplayName('cloudflare-kv'), 'Cloudflare KV');
  assert.equal(dataStoreDisplayName('d1'), 'Cloudflare KV');
  assert.equal(dataStoreDisplayName(''), 'Data Store');
  assert.equal(dataStoreDisplayName(null), 'Data Store');
});

test('tidyDataStoreActionLabel is parameterised by the active store', () => {
  assert.equal(tidyDataStoreActionLabel('supabase'), 'Tidy & Migrate Supabase Schema');
  assert.equal(tidyDataStoreActionLabel('upstash'), 'Tidy & Migrate Redis Schema');
  assert.equal(tidyDataStoreActionLabel('cloudflare-kv'), 'Tidy & Migrate Cloudflare KV Schema');
  assert.equal(tidyDataStoreActionLabel(undefined), 'Tidy & Migrate Data Store Schema');
});
