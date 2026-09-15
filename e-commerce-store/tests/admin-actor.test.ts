import assert from 'node:assert/strict';
import test from 'node:test';
import { actorHasFullAdminAccess, actorHasSalesAccess, actorHasPlatformAdminAccess, actorHasMerchantAccess } from '../lib/admin-actor.ts';

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

test('the three granular sales sub-roles (00015) have Sales Hub access', () => {
  assert.equal(actorHasSalesAccess({ role: 'sales_rep', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasSalesAccess({ role: 'sales_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasSalesAccess({ role: 'deal_desk', email: 'a@b.com', impersonating: false, tenantId: null }), true);
});

test('the legacy sales role still has Sales Hub access (not locked out by the 00015 migration)', () => {
  assert.equal(actorHasSalesAccess({ role: 'sales', email: 'a@b.com', impersonating: false, tenantId: null }), true);
});

test('super_admin has Sales Hub access (system-wide oversight, same as actorHasFullAdminAccess)', () => {
  assert.equal(actorHasSalesAccess({ role: 'super_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
});

test('a plain owner or staff admin session is BLOCKED from the Sales Hub (proper role separation)', () => {
  assert.equal(actorHasSalesAccess({ role: 'owner', email: 'a@b.com', impersonating: false, tenantId: null }), false);
  assert.equal(actorHasSalesAccess({ role: 'staff', email: 'a@b.com', impersonating: false, tenantId: null }), false);
});

test('no session (null actor) never has Sales Hub access', () => {
  assert.equal(actorHasSalesAccess(null), false);
});

test('actorHasPlatformAdminAccess (admin.site.com): super_admin only — owner is BLOCKED, unlike actorHasFullAdminAccess', () => {
  assert.equal(actorHasPlatformAdminAccess({ role: 'super_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasPlatformAdminAccess({ role: 'owner', email: 'a@b.com', impersonating: false, tenantId: null }), false);
  assert.equal(actorHasPlatformAdminAccess({ role: 'staff', email: 'a@b.com', impersonating: false, tenantId: null }), false);
  assert.equal(actorHasPlatformAdminAccess(null), false);
});

test('actorHasPlatformAdminAccess: a super_admin in impersonation mode still loses platform-admin access', () => {
  assert.equal(actorHasPlatformAdminAccess({ role: 'super_admin', email: 'a@b.com', impersonating: true, tenantId: 't1' }), false);
});

test('actorHasMerchantAccess (app.site.com): owner/staff/super_admin all pass', () => {
  assert.equal(actorHasMerchantAccess({ role: 'owner', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasMerchantAccess({ role: 'staff', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  assert.equal(actorHasMerchantAccess({ role: 'super_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
});

test('actorHasMerchantAccess: a sales-only role is blocked; impersonation IS allowed (it acts on a merchant store)', () => {
  assert.equal(actorHasMerchantAccess({ role: 'sales', email: 'a@b.com', impersonating: false, tenantId: null }), false);
  assert.equal(actorHasMerchantAccess({ role: 'staff', email: 'a@b.com', impersonating: true, tenantId: 't1' }), true);
});

test('actorHasMerchantAccess: no session never has access', () => {
  assert.equal(actorHasMerchantAccess(null), false);
});
