import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCKED_PARAMETER_KEYS,
  isLockedParameter,
  requiresStepUp,
  evaluateLock,
  STEP_UP_TTL_MS,
  isStepUpFresh,
  lockStateStepUpActive,
} from '../lib/lockdown.ts';

test('LOCKED_PARAMETER_KEYS covers the critical system knobs', () => {
  const required = [
    'storage_provider',
    'supabase_url',
    'upstash_redis_rest_url',
    'admin_basic_auth_password',
    'cron_secret',
    'payment_api_key',
    'payment_webhook_secret',
    'license_key',
  ];
  for (const k of required) assert.ok(LOCKED_PARAMETER_KEYS.includes(k), k);
});

test('isLockedParameter matches the protected keys only', () => {
  assert.equal(isLockedParameter('storage_provider'), true);
  assert.equal(isLockedParameter('  cron_secret  '), true);
  assert.equal(isLockedParameter('payment_webhook_secret'), true);
  assert.equal(isLockedParameter('theme_colors'), false);
  assert.equal(isLockedParameter('copy.heroTitle'), false);
  assert.equal(isLockedParameter(''), false);
});

test('evaluateLock allows everything during the setup phase', () => {
  const ctx = { isConfigured: false };
  assert.deepEqual(evaluateLock('cron_secret', { role: null, stepUpVerified: false }, ctx), {
    allowed: true,
    reason: 'setup_phase',
  });
  assert.deepEqual(evaluateLock('theme_colors', { role: 'owner', stepUpVerified: false }, ctx), {
    allowed: true,
    reason: 'setup_phase',
  });
});

test('evaluateLock leaves non-locked keys editable after setup', () => {
  const ctx = { isConfigured: true };
  assert.deepEqual(evaluateLock('theme_colors', { role: 'owner', stepUpVerified: false }, ctx), {
    allowed: true,
    reason: 'not_locked',
  });
  assert.deepEqual(evaluateLock('copy.heroTitle', { role: null, stepUpVerified: false }, ctx), {
    allowed: true,
    reason: 'not_locked',
  });
});

test('evaluateLock blocks locked keys for non-super-admins after setup', () => {
  const ctx = { isConfigured: true };
  assert.deepEqual(evaluateLock('cron_secret', { role: 'owner', stepUpVerified: false }, ctx), {
    allowed: false,
    reason: 'forbidden',
  });
  assert.deepEqual(evaluateLock('admin_basic_auth_password', { role: 'sales', stepUpVerified: true }, ctx), {
    allowed: false,
    reason: 'forbidden',
  });
  assert.deepEqual(evaluateLock('storage_provider', { role: null, stepUpVerified: false }, ctx), {
    allowed: false,
    reason: 'forbidden',
  });
});

test('evaluateLock requires step-up for super-admins on locked keys', () => {
  const ctx = { isConfigured: true };
  assert.deepEqual(evaluateLock('cron_secret', { role: 'super_admin', stepUpVerified: false }, ctx), {
    allowed: false,
    reason: 'requires_step_up',
  });
  assert.deepEqual(evaluateLock('cron_secret', { role: 'super_admin', stepUpVerified: true }, ctx), {
    allowed: true,
    reason: 'allowed',
  });
});

test('requiresStepUp is only true for super-admins on locked keys', () => {
  assert.equal(requiresStepUp('super_admin', 'cron_secret'), true);
  assert.equal(requiresStepUp('super_admin', 'theme_colors'), false);
  assert.equal(requiresStepUp('owner', 'cron_secret'), false);
  assert.equal(requiresStepUp(null, 'cron_secret'), false);
});

test('isStepUpFresh enforces the 5-minute window', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now, now), true);
  assert.equal(isStepUpFresh(now - STEP_UP_TTL_MS + 1, now), true);
  assert.equal(isStepUpFresh(now - STEP_UP_TTL_MS, now), false);
  assert.equal(isStepUpFresh(now - STEP_UP_TTL_MS - 1, now), false);
  assert.equal(isStepUpFresh(undefined, now), false);
  assert.equal(isStepUpFresh(null, now), false);
  assert.equal(isStepUpFresh(Number.NaN, now), false);
});

test('lockStateStepUpActive reads the persisted step-up timestamp', () => {
  const fresh = new Date(Date.now() - 1000).toISOString();
  const stale = new Date(Date.now() - STEP_UP_TTL_MS - 1000).toISOString();
  assert.equal(lockStateStepUpActive({ key: 'cron_secret', locked: true, lockedAt: fresh, lockedBy: 'u', stepUpVerifiedAt: fresh }), true);
  assert.equal(lockStateStepUpActive({ key: 'cron_secret', locked: true, lockedAt: stale, lockedBy: 'u', stepUpVerifiedAt: stale }), false);
  assert.equal(lockStateStepUpActive(null), false);
  assert.equal(lockStateStepUpActive({ key: 'cron_secret', locked: true, lockedAt: null, lockedBy: null, stepUpVerifiedAt: null }), false);
  assert.equal(lockStateStepUpActive({ key: 'cron_secret', locked: true, lockedAt: null, lockedBy: null, stepUpVerifiedAt: 'garbage' }), false);
});
