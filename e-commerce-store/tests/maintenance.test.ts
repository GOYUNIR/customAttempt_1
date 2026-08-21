import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaintenanceFlag, isMaintenanceExemptPath } from '../lib/maintenance.ts';

test('parseMaintenanceFlag accepts true/1/on/yes (case-insensitive)', () => {
  assert.equal(parseMaintenanceFlag('true'), true);
  assert.equal(parseMaintenanceFlag('TRUE'), true);
  assert.equal(parseMaintenanceFlag('1'), true);
  assert.equal(parseMaintenanceFlag('on'), true);
  assert.equal(parseMaintenanceFlag('yes'), true);
  assert.equal(parseMaintenanceFlag('false'), false);
  assert.equal(parseMaintenanceFlag(''), false);
  assert.equal(parseMaintenanceFlag(undefined), false);
});

test('isMaintenanceExemptPath exempts admin, auth, assets and the screen itself', () => {
  assert.equal(isMaintenanceExemptPath('/maintenance'), true);
  assert.equal(isMaintenanceExemptPath('/admin'), true);
  assert.equal(isMaintenanceExemptPath('/api/admin/license'), true);
  assert.equal(isMaintenanceExemptPath('/api/auth/login'), true);
  assert.equal(isMaintenanceExemptPath('/og'), true);
  assert.equal(isMaintenanceExemptPath('/media/logo?v=abc'), true);
  assert.equal(isMaintenanceExemptPath('/_next/static/chunk.js'), true);
  assert.equal(isMaintenanceExemptPath('/favicon.ico'), true);
  assert.equal(isMaintenanceExemptPath('/'), false);
  assert.equal(isMaintenanceExemptPath('/catalog'), false);
});
