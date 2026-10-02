import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The original store's admin writes its settings (and schedule/social
// overrides) to the KV settings key; every server reader but one read them
// there. The Postgres storefront path read tenant_store_config instead, a copy
// last synced by hand, so admin saves never reached the page (2026-09-29).
test("the Postgres storefront path takes the original store's settings from where the admin writes them", () => {
  const src = readFileSync('lib/store-payload.ts', 'utf8') // the payload builder (was in app/api/store/route.ts);
  const fn = src.slice(src.indexOf('async function tryBuildStorePayloadFromPostgres'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const kvRead = body.indexOf('readDefaultStoreSettingsFromKv()');
  const merge = body.indexOf('mergePublicConfig(');
  assert.ok(kvRead >= 0 && kvRead < merge, 'settings are read from KV before they are merged');
  assert.ok(/mergePublicConfig\(kv\?\.config \?\? pg\.config\)/.test(body), 'Postgres config is only the fallback');
  assert.ok(!/scheduleOverride: pg\.scheduleOverride|socialOverride: pg\.socialOverride/.test(body), 'overrides follow the same source');
});
