import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLicense,
  maskLicenseKey,
  isWriteAllowed,
  licenseBanner,
  GRACE_WINDOW_DAYS,
} from '../lib/license.ts';

const DAY = 86_400_000;

test('maskLicenseKey formats sk-ds-••••••••1234 style masks', () => {
  assert.equal(maskLicenseKey('sk-ds-abcdefgh1234'), 'sk-ds-••••••••1234');
  assert.equal(maskLicenseKey('short'), 'sh•••');
  assert.equal(maskLicenseKey(''), '');
});

test('classifyLicense: missing key → MISSING + writes blocked', () => {
  const r = classifyLicense({ key: '', server: null });
  assert.equal(r.status, 'MISSING');
  assert.equal(r.writesAllowed, false);
  assert.equal(licenseBanner('MISSING')?.includes('Demo Mode'), true);
});

test('classifyLicense: server active verdict → ACTIVE + writes allowed', () => {
  const r = classifyLicense({ key: 'sk-ds-x', server: { status: 'active' } });
  assert.equal(r.status, 'ACTIVE');
  assert.equal(r.writesAllowed, true);
  assert.equal(licenseBanner('ACTIVE'), null);
});

test('classifyLicense: server grace verdict → GRACE + "License payment pending." banner', () => {
  const r = classifyLicense({ key: 'sk-ds-x', server: { status: 'grace', graceDays: 2 } });
  assert.equal(r.status, 'GRACE');
  assert.equal(r.graceDaysRemaining, 2);
  assert.equal(r.writesAllowed, true);
  assert.equal(licenseBanner('GRACE'), 'License payment pending.');
});

test('classifyLicense: server expired verdict → EXPIRED + writes blocked', () => {
  const r = classifyLicense({ key: 'sk-ds-x', server: { status: 'expired' } });
  assert.equal(r.status, 'EXPIRED');
  assert.equal(r.writesAllowed, false);
});

test('classifyLicense: derives GRACE then EXPIRED from expiresAt within the window', () => {
  const now = Date.UTC(2026, 7, 21);
  // 1 day past expiry → GRACE
  const grace = classifyLicense({ key: 'k', server: { expiresAt: new Date(now - 1 * DAY).toISOString() }, now });
  assert.equal(grace.status, 'GRACE');
  assert.ok(grace.graceDaysRemaining > 0);
  // beyond the grace window → EXPIRED
  const expired = classifyLicense({
    key: 'k',
    server: { expiresAt: new Date(now - (GRACE_WINDOW_DAYS + 1) * DAY).toISOString() },
    now,
  });
  assert.equal(expired.status, 'EXPIRED');
  // not yet expired → ACTIVE
  const active = classifyLicense({ key: 'k', server: { expiresAt: new Date(now + DAY).toISOString() }, now });
  assert.equal(active.status, 'ACTIVE');
});

test('classifyLicense: key present with no server verdict → ACTIVE (local trust)', () => {
  const r = classifyLicense({ key: 'sk-ds-local', server: null });
  assert.equal(r.status, 'ACTIVE');
  assert.equal(r.writesAllowed, true);
});

test('isWriteAllowed: ACTIVE and GRACE allow writes, EXPIRED/MISSING block', () => {
  assert.equal(isWriteAllowed('ACTIVE'), true);
  assert.equal(isWriteAllowed('GRACE'), true);
  assert.equal(isWriteAllowed('EXPIRED'), false);
  assert.equal(isWriteAllowed('MISSING'), false);
});
