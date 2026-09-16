import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCsrf, checkNoDestructiveActionsAllowed, checkCloudflareConfigured, checkPortalIsolation, checkNotificationDeadLetter } from '../lib/system-diagnostics-pure.ts';

test('checkCsrf always reports ok — it is unconditionally enforced, not configurable', () => {
  const check = checkCsrf();
  assert.equal(check.status, 'ok');
  assert.ok(check.detail.length > 0);
});

test('checkNoDestructiveActionsAllowed: outside production, the check does not apply (ok)', () => {
  assert.equal(checkNoDestructiveActionsAllowed({ NODE_ENV: 'development' }).status, 'ok');
});

test('checkNoDestructiveActionsAllowed: production + flag unset is ok (hard-blocked)', () => {
  const check = checkNoDestructiveActionsAllowed({ NODE_ENV: 'production' });
  assert.equal(check.status, 'ok');
});

test('checkNoDestructiveActionsAllowed: production + flag=true is a real error, not silently ok', () => {
  const check = checkNoDestructiveActionsAllowed({ NODE_ENV: 'production', ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN: 'true' });
  assert.equal(check.status, 'error');
  assert.match(check.detail, /ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN/);
});

test('checkNoDestructiveActionsAllowed: production + flag=false is still ok', () => {
  const check = checkNoDestructiveActionsAllowed({ NODE_ENV: 'production', ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN: 'false' });
  assert.equal(check.status, 'ok');
});

test('checkCloudflareConfigured: not_configured when credentials are missing', () => {
  assert.equal(checkCloudflareConfigured({}).status, 'not_configured');
  assert.equal(checkCloudflareConfigured({ CLOUDFLARE_API_TOKEN: 'token-only' }).status, 'not_configured');
  assert.equal(checkCloudflareConfigured({ CLOUDFLARE_ZONE_ID: 'zone-only' }).status, 'not_configured');
});

test('checkCloudflareConfigured: ok when both credentials are present', () => {
  const check = checkCloudflareConfigured({ CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ZONE_ID: 'test-zone' });
  assert.equal(check.status, 'ok');
});

test('checkPortalIsolation: production + unset PLATFORM_ROOT_DOMAIN is an ERROR, not a warning', () => {
  // This is the deploy gate — production-readiness-check.ts exits 1 on any
  // error-level check, so an unisolated production deploy cannot ship quietly.
  const check = checkPortalIsolation({ NODE_ENV: 'production' });
  assert.equal(check.status, 'error');
  assert.match(check.detail, /PLATFORM_ROOT_DOMAIN/);
});

test('checkPortalIsolation: configured root domain is ok', () => {
  assert.equal(checkPortalIsolation({ NODE_ENV: 'production', PLATFORM_ROOT_DOMAIN: 'goyunir.com' }).status, 'ok');
});

test('checkPortalIsolation: deliberate single-domain mode is not_configured, never an error', () => {
  assert.equal(
    checkPortalIsolation({ NODE_ENV: 'production', PLATFORM_SINGLE_DOMAIN_MODE: 'true' }).status,
    'not_configured',
  );
  assert.equal(checkPortalIsolation({ NODE_ENV: 'development' }).status, 'not_configured');
});

test('checkNotificationDeadLetter: zero undelivered is ok', () => {
  assert.equal(checkNotificationDeadLetter(0).status, 'ok');
});

test('checkNotificationDeadLetter: ANY dead-lettered notification is an ERROR', () => {
  // Not a warning. Someone was charged and never told; a warning gets ignored.
  const c = checkNotificationDeadLetter(3);
  assert.equal(c.status, 'error');
  assert.match(c.detail, /charged and never told/);
  assert.match(c.detail, /^3 notification/);
});

test('checkNotificationDeadLetter: negative or junk counts do not crash', () => {
  assert.equal(checkNotificationDeadLetter(-5).status, 'ok');
  assert.equal(checkNotificationDeadLetter(NaN).status, 'ok');
});
