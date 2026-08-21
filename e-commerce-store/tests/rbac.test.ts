import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeRole,
  tierFromPathname,
  portalPrefixForTier,
  roleTiers,
  roleCanAccessTier,
  roleCapabilities,
  roleHasCapability,
  canAccessTenant,
  normalizeHostname,
  isPlatformDomain,
  classifyRequest,
} from '../lib/rbac.ts';

test('sanitizeRole accepts known roles and rejects junk', () => {
  assert.equal(sanitizeRole('super_admin'), 'super_admin');
  assert.equal(sanitizeRole(' SALES '), 'sales');
  assert.equal(sanitizeRole('Owner'), 'owner');
  assert.equal(sanitizeRole('staff'), 'staff');
  assert.equal(sanitizeRole('customer'), 'customer');
  assert.equal(sanitizeRole('root'), null);
  assert.equal(sanitizeRole(''), null);
  assert.equal(sanitizeRole(null), null);
  assert.equal(sanitizeRole(123), null);
});

test('tierFromPathname maps prefixes to tiers and everything else to 4', () => {
  assert.equal(tierFromPathname('/a'), 1);
  assert.equal(tierFromPathname('/a/dashboard'), 1);
  assert.equal(tierFromPathname('/s'), 2);
  assert.equal(tierFromPathname('/s/clients/acme'), 2);
  assert.equal(tierFromPathname('/b'), 3);
  assert.equal(tierFromPathname('/b/items/new'), 3);
  assert.equal(tierFromPathname('/'), 4);
  assert.equal(tierFromPathname('/catalog'), 4);
  assert.equal(tierFromPathname('/admin'), 4); // legacy /admin is its own gate
  assert.equal(tierFromPathname('/api/store'), 4);
});

test('portalPrefixForTier returns the right prefix (null for tier 4)', () => {
  assert.equal(portalPrefixForTier(1), '/a');
  assert.equal(portalPrefixForTier(2), '/s');
  assert.equal(portalPrefixForTier(3), '/b');
  assert.equal(portalPrefixForTier(4), null);
});

test('roleTiers + roleCanAccessTier encode the 4-tier hierarchy', () => {
  assert.deepEqual(roleTiers('super_admin'), [1, 2, 3, 4]);
  assert.deepEqual(roleTiers('sales'), [2, 3, 4]);
  assert.deepEqual(roleTiers('owner'), [3, 4]);
  assert.deepEqual(roleTiers('staff'), [3, 4]);
  assert.deepEqual(roleTiers('customer'), [4]);

  assert.equal(roleCanAccessTier('super_admin', 1), true);
  assert.equal(roleCanAccessTier('sales', 1), false);
  assert.equal(roleCanAccessTier('sales', 2), true);
  assert.equal(roleCanAccessTier('owner', 3), true);
  assert.equal(roleCanAccessTier('owner', 2), false);
  assert.equal(roleCanAccessTier('staff', 3), true);
  assert.equal(roleCanAccessTier('customer', 3), false);
  assert.equal(roleCanAccessTier('customer', 4), true);
  // unauthenticated can only reach the public tier
  assert.equal(roleCanAccessTier(null, 4), true);
  assert.equal(roleCanAccessTier(null, 3), false);
});

test('roleCapabilities + roleHasCapability', () => {
  assert.equal(roleHasCapability('super_admin', 'platform.config.write'), true);
  assert.equal(roleHasCapability('sales', 'tenant.manage'), true);
  assert.equal(roleHasCapability('sales', 'platform.config.write'), false);
  assert.equal(roleHasCapability('owner', 'business.config.write'), true);
  assert.equal(roleHasCapability('owner', 'item.manage'), true);
  assert.equal(roleHasCapability('staff', 'order.manage'), true);
  assert.equal(roleHasCapability('staff', 'platform.metrics.read'), false);
  assert.equal(roleHasCapability('customer', 'customer.self'), true);
  assert.equal(roleHasCapability('customer', 'item.manage'), false);
  assert.equal(roleHasCapability(null, 'customer.self'), false);
  assert.deepEqual(roleCapabilities(null), []);
});

test('canAccessTenant enforces tenant isolation', () => {
  const tenantA = 'tenant-a';
  const tenantB = 'tenant-b';
  assert.equal(canAccessTenant({ role: 'super_admin', tenantId: null }, tenantB), true);
  assert.equal(canAccessTenant({ role: 'owner', tenantId: tenantA }, tenantA), true);
  assert.equal(canAccessTenant({ role: 'owner', tenantId: tenantA }, tenantB), false);
  assert.equal(canAccessTenant({ role: 'staff', tenantId: tenantA }, tenantA), true);
  assert.equal(canAccessTenant({ role: 'staff', tenantId: tenantA }, tenantB), false);
  assert.equal(canAccessTenant({ role: 'customer', tenantId: tenantA }, tenantA), true);
  assert.equal(canAccessTenant({ role: 'customer', tenantId: tenantA }, tenantB), false);
  assert.equal(
    canAccessTenant({ role: 'sales', tenantId: null, assignedTenantIds: [tenantB] }, tenantB),
    true,
  );
  assert.equal(
    canAccessTenant({ role: 'sales', tenantId: null, assignedTenantIds: [tenantB] }, tenantA),
    false,
  );
  assert.equal(canAccessTenant({ role: 'sales', tenantId: null }, tenantB), false); // unassigned → fail closed
  assert.equal(canAccessTenant({ role: 'owner', tenantId: tenantA }, null), false); // missing target → fail closed
  assert.equal(canAccessTenant({ role: null, tenantId: tenantA }, tenantA), false);
});

test('normalizeHostname strips protocol, port and trailing dot', () => {
  assert.equal(normalizeHostname('https://Shop.Example.com:3000'), 'shop.example.com');
  assert.equal(normalizeHostname('https://example.com'), 'example.com');
  assert.equal(normalizeHostname('EXAMPLE.COM.'), 'example.com');
  assert.equal(normalizeHostname(''), '');
});

test('isPlatformDomain treats apex as platform and subdomains as tenant sites', () => {
  const platform = ['https://maindomain.com'];
  assert.equal(isPlatformDomain('maindomain.com', platform), true);
  assert.equal(isPlatformDomain('https://maindomain.com/', platform), true);
  assert.equal(isPlatformDomain('shop.maindomain.com', platform), false); // subdomain = tenant storefront
  assert.equal(isPlatformDomain('acme.custom.com', platform), false);
  assert.equal(isPlatformDomain('acme.custom.com'), true); // no platform configured → fail safe
});

test('classifyRequest routes platform prefixes and custom domains', () => {
  const platform = ['maindomain.com'];
  assert.deepEqual(classifyRequest('maindomain.com', '/a/metrics', platform), {
    tier: 1,
    isCustomDomain: false,
    portalPrefix: '/a',
  });
  assert.deepEqual(classifyRequest('maindomain.com', '/s/clients', platform), {
    tier: 2,
    isCustomDomain: false,
    portalPrefix: '/s',
  });
  assert.deepEqual(classifyRequest('maindomain.com', '/b', platform), {
    tier: 3,
    isCustomDomain: false,
    portalPrefix: '/b',
  });
  assert.deepEqual(classifyRequest('maindomain.com', '/pricing', platform), {
    tier: 4,
    isCustomDomain: false,
    portalPrefix: null,
  });
  // custom domain always resolves to the Tier 4 storefront regardless of path
  assert.deepEqual(classifyRequest('shop.acme.com', '/b', platform), {
    tier: 4,
    isCustomDomain: true,
    portalPrefix: null,
  });
});

