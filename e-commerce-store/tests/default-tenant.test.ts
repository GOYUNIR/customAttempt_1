import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_ID, isForeignTenantSession } from '../lib/default-tenant.ts';

test('CROSS-TENANT GUARD: a session for another store is foreign; the default store\'s and legacy sessions are not', () => {
  // Proven 2026-09-26: test4's owner session read the original store's admin catalog.
  assert.equal(isForeignTenantSession('13591c9e-82e4-4c23-8d94-249cef6fa775'), true);
  assert.equal(isForeignTenantSession(DEFAULT_TENANT_ID), false);
  for (const legacy of [null, undefined, '', '  ']) assert.equal(isForeignTenantSession(legacy), false);
});
