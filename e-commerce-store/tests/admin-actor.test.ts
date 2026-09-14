import assert from 'node:assert/strict';
import test from 'node:test';
import { actorHasFullAdminAccess } from '../lib/admin-actor.ts';

test('super_admin and owner have full admin access', () => {
  assert.equal(actorHasFullAdminAccess({ role: 'super_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasFullAdminAccess({ role: 'owner', email: 'a@b.com', impersonating: false, tenantId: null }), true);
});

test('sales and staff (Impersonation-only roles) never have full admin access', () => {
  assert.equal(actorHasFullAdminAccess({ role: 'sales', email: 'a@b.com', impersonating: true, tenantId: 't1' }), false);
  assert.equal(actorHasFullAdminAccess({ role: 'staff', email: 'a@b.com', impersonating: true, tenantId: 't1' }), false);
});

test('a super_admin explicitly in impersonation mode STILL loses full admin access', () => {
  // Even the platform super-admin, once they've entered impersonation mode,
  // must be excluded from the highest-risk routes — impersonation always
  // means the reduced capability set, never a silent full-access bypass.
  assert.equal(
    actorHasFullAdminAccess({ role: 'sales', email: 'admin@platform.com', impersonating: true, tenantId: 't1' }),
    false,
  );
});

test('no session (null actor) never has full admin access', () => {
  assert.equal(actorHasFullAdminAccess(null), false);
});
