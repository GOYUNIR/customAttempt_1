/**
 * PLATFORM AUDIT LOG — writes to the immutable `public.audit_logs` table
 * (supabase/migrations/00008_platform_rbac_hardening.sql adds a trigger that
 * blocks UPDATE/DELETE on it unconditionally, even for the service-role key
 * this module writes with).
 *
 * This is DELIBERATELY separate from `app/api/admin/audit/route.ts`'s
 * `appendAudit()` (a bounded 200-entry Redis list used for the admin UI's
 * fast "recent activity" view, which the `wipe` action erases along with
 * everything else). That Redis list is a UI convenience and was never meant
 * to be tamper-resistant. This module is the real, permanent record —
 * required whenever Supabase is configured; best-effort (never throws, never
 * blocks the caller) when it isn't, since not every deployment runs Supabase
 * as its storage backend.
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

export type PlatformAuditEntry = {
  action: string;
  /** Free-form structured context — never put secrets in here, this table
   *  is permanent and (per its RLS policy) readable by super_admin/owner. */
  detail?: Record<string, unknown>;
  /** Who performed the action — an email or a stable identifier, never a
   *  password/token. */
  actor?: string;
  /** The tenant this action was scoped to, when known. Mirrored into BOTH
   *  `tenant_id` (the original 00001 column, used by every other RLS policy
   *  in this schema) and `target_tenant_id` (00009's enterprise-spec name —
   *  the tenant a STAFF IMPERSONATION session was acting on). For a normal
   *  (non-impersonated) admin action these are the same tenant; kept as two
   *  columns because the spec names `target_tenant_id` explicitly and a
   *  future platform-wide action (not scoped to any one tenant) may want
   *  `tenant_id` null while still recording who the target was. */
  tenantId?: string | null;
  /** The Supabase `public.users.id` of the acting operator, when known
   *  (super_admin / sales / owner / staff signed in via Supabase Auth —
   *  the env Basic-Auth password path has no such id, so this is often
   *  absent for legacy admin sessions; `actor` is the reliable identity
   *  field across every auth path). */
  staffId?: string | null;
  /** Structured payload for the action (e.g. the fields changed) — same
   *  data as `detail`, stored under the enterprise-spec column name too so
   *  either can be queried directly. */
  payload?: Record<string, unknown>;
  /** Caller's IP, when the route has it (rate-limiters already resolve this
   *  via lib/rate-limit.ts's `clientIp()` — pass the same value through). */
  ipAddress?: string | null;
};

/**
 * Best-effort write to the immutable platform audit trail. Never throws —
 * an audit-log outage must never block the action being audited (the same
 * fail-open discipline as every rate limiter in this codebase).
 */
export async function recordPlatformAudit(entry: PlatformAuditEntry): Promise<void> {
  if (!supabaseServiceConfigured()) return;
  try {
    const { serviceRoleKey } = readSupabaseEnv();
    await supabaseRestFetch('/audit_logs', {
      key: serviceRoleKey,
      method: 'POST',
      body: {
        tenant_id: entry.tenantId ?? null,
        target_tenant_id: entry.tenantId ?? null,
        actor: entry.actor || 'unknown',
        staff_id: entry.staffId ?? null,
        action: entry.action,
        detail: entry.detail ?? {},
        payload: entry.payload ?? entry.detail ?? {},
        ip_address: entry.ipAddress ?? null,
      },
    });
  } catch (err) {
    console.warn('[platform-audit] write failed (non-fatal)', (err as Error)?.message || err);
  }
}
