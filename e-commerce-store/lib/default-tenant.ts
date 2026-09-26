/**
 * The original (default) store's tenant id, and the rule that a session scoped
 * to ANY OTHER store may not use the admin tree. Import-free, so middleware
 * (edge) and node code share it.
 *
 * Why the rule exists (2026-09-26, proven read-only on production): the admin
 * routes act on the DEFAULT store (ensureDefaultTenant(), the KV settings),
 * and authorize by "is this a valid admin session" — never by whose store the
 * session belongs to. A merchant owner (public signup is open) who signed in
 * to app.<root> got HTTP 200 on /api/admin/products listing the ORIGINAL
 * store's products; writes go through the same check. Until the admin tree
 * resolves its tenant from the session, a session for another store is
 * refused there. The merchant loses nothing: every admin screen was acting on
 * the original store, never theirs.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-00000000000d';

/** A session scoped to a store other than the default one. */
export function isForeignTenantSession(tenantId: unknown): boolean {
  const t = String(tenantId ?? '').trim();
  return t !== '' && t !== DEFAULT_TENANT_ID;
}
