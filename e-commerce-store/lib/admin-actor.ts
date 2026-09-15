/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMIN ACTOR — the pure RBAC decision for /api/admin routes.
 *
 * ZERO imports (mirrors lib/rbac.ts / lib/lockdown.ts / lib/csrf.ts) so this
 * loads under `node --test` with no bundler — the `@/` path alias lib/admin-
 * verify.ts uses internally only resolves through Next.js's own bundler, so
 * a file that needs direct unit coverage can't have any `@/` import at all,
 * transitively or otherwise. lib/admin-verify.ts (Redis-backed session
 * resolution) imports this file for the actual decision.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The RBAC role this app's admin routes gate on (lib/rbac.ts's
 *  `PortalRole`, minus 'customer' which never reaches /api/admin).
 *  `sales_rep` / `sales_admin` / `deal_desk` (migration 00015) are the
 *  granular Sales Hub sub-roles — `sales` is kept as a legacy alias so an
 *  existing session isn't locked out by the migration; see
 *  `actorHasSalesAccess()` below. */
export type AdminActorRole = 'super_admin' | 'sales' | 'sales_rep' | 'sales_admin' | 'deal_desk' | 'owner' | 'staff';

export interface AdminActor {
  role: AdminActorRole;
  email: string;
  /** True for a Staff Impersonation session (Tier 2 sales/support acting on
   *  a tenant they don't own) — see /api/admin/impersonate. */
  impersonating: boolean;
  /** The Postgres `tenants.id` this session is scoped to, when known — set
   *  for an impersonation session (its target tenant); null for a legacy
   *  full-admin session, which has no tenant concept of its own (see
   *  lib/tenant-context.ts's `resolveActingTenantId()` for how callers that
   *  need a tenant id anyway resolve one for a single-tenant deployment). */
  tenantId: string | null;
}

/** Staff Impersonation sessions self-expire fast — a support session left
 *  open is a live liability, and there's no "remember this device" option
 *  for impersonation. */
export const IMPERSONATION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

/**
 * Whether an actor may reach the highest-risk admin routes (payment/storage
 * credentials, full data wipe, user role management, webhook config, a
 * whole-keyspace migration). Staff Impersonation sessions ('sales'/'staff')
 * are ALWAYS excluded — that's the entire point of impersonation being safe
 * to hand out ("assist with setup or troubleshooting without exposing
 * financial credentials"). This holds even for a super_admin who has
 * explicitly entered impersonation mode: once `impersonating` is true, the
 * session gets the reduced capability set, never a silent full-access
 * bypass just because the underlying account could have unrestricted access
 * outside of impersonation.
 */
export function actorHasFullAdminAccess(actor: AdminActor | null): boolean {
  if (!actor) return false;
  if (actor.impersonating) return false;
  return actor.role === 'super_admin' || actor.role === 'owner';
}

/**
 * Whether an actor may reach the Sales Hub (`/sales`, `/api/admin/b2b/*`) —
 * the "proper enterprise role separation" the Sales Hub RBAC pass asked for:
 * a plain `owner` or `staff` admin session is blocked (this app's generic
 * admin access does NOT imply sales-deal-desk access), while `super_admin`
 * keeps its system-wide oversight, same as `actorHasFullAdminAccess()`
 * above. `sales` is the pre-00015 role, kept working as a legacy alias
 * alongside the three granular sub-roles that migration adds.
 */
export function actorHasSalesAccess(actor: AdminActor | null): boolean {
  if (!actor) return false;
  return (
    actor.role === 'super_admin' ||
    actor.role === 'sales' ||
    actor.role === 'sales_rep' ||
    actor.role === 'sales_admin' ||
    actor.role === 'deal_desk'
  );
}
