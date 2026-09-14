import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCloudflareDomainStatus, mapCloudflareSslStatus, isTerminalDomainStatus } from '../lib/cloudflare-status.ts';

test('mapCloudflareDomainStatus: active variants map to active', () => {
  assert.equal(mapCloudflareDomainStatus('active'), 'active');
  assert.equal(mapCloudflareDomainStatus('active_redeploying'), 'active');
  assert.equal(mapCloudflareDomainStatus('test_active'), 'active');
  assert.equal(mapCloudflareDomainStatus('test_active_apex'), 'active');
});

test('mapCloudflareDomainStatus: blocked/failed variants map to error', () => {
  assert.equal(mapCloudflareDomainStatus('blocked'), 'error');
  assert.equal(mapCloudflareDomainStatus('test_blocked'), 'error');
  assert.equal(mapCloudflareDomainStatus('test_failed'), 'error');
  assert.equal(mapCloudflareDomainStatus('pending_blocked'), 'error');
  assert.equal(mapCloudflareDomainStatus('deleted'), 'error');
});

test('mapCloudflareDomainStatus: everything else in-progress maps to pending', () => {
  assert.equal(mapCloudflareDomainStatus('pending'), 'pending');
  assert.equal(mapCloudflareDomainStatus('moved'), 'pending');
  assert.equal(mapCloudflareDomainStatus('pending_provisioned'), 'pending');
  assert.equal(mapCloudflareDomainStatus('test_pending'), 'pending');
});

test('mapCloudflareDomainStatus: null/empty/unknown never crashes, defaults sanely', () => {
  assert.equal(mapCloudflareDomainStatus(null), 'unconfigured');
  assert.equal(mapCloudflareDomainStatus(undefined), 'unconfigured');
  assert.equal(mapCloudflareDomainStatus(''), 'unconfigured');
  assert.equal(mapCloudflareDomainStatus('some_future_cloudflare_status'), 'pending');
});

test('mapCloudflareSslStatus: active variants map to active', () => {
  assert.equal(mapCloudflareSslStatus('active'), 'active');
  assert.equal(mapCloudflareSslStatus('staging_active'), 'active');
});

test('mapCloudflareSslStatus: validation-phase statuses map to pending_validation', () => {
  assert.equal(mapCloudflareSslStatus('pending_validation'), 'pending_validation');
  assert.equal(mapCloudflareSslStatus('initializing'), 'pending_validation');
});

test('mapCloudflareSslStatus: issuance-phase statuses map to pending_issuance', () => {
  assert.equal(mapCloudflareSslStatus('pending_issuance'), 'pending_issuance');
  assert.equal(mapCloudflareSslStatus('pending_deployment'), 'pending_issuance');
  assert.equal(mapCloudflareSslStatus('staging_deployment'), 'pending_issuance');
});

test('mapCloudflareSslStatus: timed-out/expired/deleted map to error', () => {
  assert.equal(mapCloudflareSslStatus('initializing_timed_out'), 'error');
  assert.equal(mapCloudflareSslStatus('validation_timed_out'), 'error');
  assert.equal(mapCloudflareSslStatus('expired'), 'error');
  assert.equal(mapCloudflareSslStatus('deleted'), 'error');
  assert.equal(mapCloudflareSslStatus('inactive'), 'error');
});

test('mapCloudflareSslStatus: null/empty never crashes', () => {
  assert.equal(mapCloudflareSslStatus(null), 'unconfigured');
  assert.equal(mapCloudflareSslStatus(''), 'unconfigured');
});

test('isTerminalDomainStatus: only active/error are terminal', () => {
  assert.equal(isTerminalDomainStatus('active'), true);
  assert.equal(isTerminalDomainStatus('error'), true);
  assert.equal(isTerminalDomainStatus('pending'), false);
  assert.equal(isTerminalDomainStatus('unconfigured'), false);
});
