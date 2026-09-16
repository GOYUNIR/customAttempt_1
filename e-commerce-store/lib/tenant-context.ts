/**
 * TENANT CONTEXT — resolves "which tenant is this admin action scoped to"
 * for the B2B/commerce Postgres schema (supabase/migrations/00009).
 *
 * This store runs single-tenant today (see lib/admin-actor.ts's design
 * notes) — there is no per-deployment tenant onboarding flow, and the admin
 * session system (env password / device cookie) carries no tenant id at
 * all for an ordinary full-admin session. Only a Staff Impersonation
 * session (app/api/admin/impersonate) carries a REAL target tenant id,
 * because impersonation is inherently a multi-tenant concept.
 *
 * So a full-admin session acting on "this store's own" B2B data needs a
 * stable tenant id to scope its writes to, without requiring any extra
 * setup — the same "stupid-proof, works on a fresh clone" bar every other
 * bootstrap concern in this codebase holds itself to (global_platform_settings
 * uses an identical fixed-singleton-id pattern). `ensureDefaultTenant()`
 * lazily upserts ONE `tenants` row under a fixed id the first time any B2B
 * route needs one; every subsequent call is a no-op merge.
 */

import { getDb } from '@/lib/db/client';
import { neutralBrandName } from '@/lib/env';
import type { AdminActor } from '@/lib/admin-actor';

/** Fixed id for "this store" when running single-tenant. Never reused for a
 *  real onboarded tenant (a real Cloudflare-for-SaaS / multi-tenant
 *  onboarding flow would mint its own uuid per tenant, same as any other
 *  row in this table). */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-00000000000d';
const DEFAULT_TENANT_SLUG = 'default';

/** Idempotently ensure the single-tenant deployment's `tenants` row exists,
 *  returning its id. Throws only when Supabase isn't configured at all —
 *  callers that need a tenant id for a Postgres write have nothing useful
 *  to do without one. */
export async function ensureDefaultTenant(): Promise<string> {
  if (!getDb().configured) {
    throw new Error('Supabase is not configured — the B2B engine requires SUPABASE_SERVICE_ROLE_KEY.');
  }
  // returning: 'default' reproduces the pre-port request exactly — the legacy
  // call sent Prefer: resolution=merge-duplicates with no return directive.
  await getDb().insert(
    'tenants',
    {
      id: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
      name: neutralBrandName(),
      license_status: 'active',
    },
    { mergeDuplicates: true, returning: 'default' },
  );
  return DEFAULT_TENANT_ID;
}

/**
 * Resolve the tenant id an admin actor's B2B action is scoped to:
 *   - an impersonation session acts on its target tenant (never "this
 *     store" — that's the entire point of impersonation being tenant-scoped),
 *   - a full-admin session acts on "this store's own" tenant (lazily
 *     created on first use).
 */
export async function resolveActingTenantId(actor: AdminActor | null): Promise<string> {
  if (actor?.impersonating && actor.tenantId) {
    return actor.tenantId;
  }
  return ensureDefaultTenant();
}
