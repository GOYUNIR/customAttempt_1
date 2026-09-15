import { NextResponse } from 'next/server';
import { createRedisClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { issueAdminDevice, IMPERSONATION_TTL_SECONDS } from '@/lib/admin-verify';
import { verifyPortalSignIn } from '@/services/config/supabase-client';
import { supabaseRestFetch, readSupabaseEnv, supabaseServiceConfigured } from '@/services/config/supabase-client';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { appendAudit } from '@/app/api/admin/audit/route';
import { portalCookieAttrs } from '@/lib/portal-cookies';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/impersonate — Staff Impersonation sign-in.
 *
 * Lets a Tier 2 (Agency/Sales) platform account enter a tenant's store to
 * help with setup/troubleshooting WITHOUT the tenant's own admin password
 * and WITHOUT exposing that tenant's payment/storage credentials — the
 * resulting session is marked `impersonating: true` and every high-risk
 * admin route (provider-keys, wipe, users, webhooks — see
 * `actorHasFullAdminAccess()` in lib/admin-verify.ts) explicitly refuses it.
 *
 * Every impersonation start is written to the immutable platform audit log
 * (lib/platform-audit.ts via appendAudit), and because appendAudit now fans
 * out to that table automatically, every WRITE the impersonated session goes
 * on to make is logged the same way with zero extra wiring.
 *
 *   Body:    { email, password }
 *   Header:  X-Staff-Impersonate-Tenant-ID  — which tenant to act on
 *
 * Requires Supabase (the `tenants` / `sales_tenant_assignments` tables from
 * supabase/migrations/00003 + 00008) — this is inherently a platform-level,
 * multi-tenant capability and has no meaning on a storage backend that
 * doesn't model tenants at all.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('admin_impersonate', request, 10, 60);
    if (limited) return limited;

    if (!supabaseServiceConfigured()) {
      return NextResponse.json(
        { error: 'Staff Impersonation requires Supabase (tenants/sales_tenant_assignments tables).' },
        { status: 503 },
      );
    }

    const targetTenantId = request.headers.get('x-staff-impersonate-tenant-id') || '';
    if (!targetTenantId) {
      return NextResponse.json({ error: 'X-Staff-Impersonate-Tenant-ID header is required.' }, { status: 400 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!isValidEmail(email) || !isValidPassword(password)) {
      return NextResponse.json({ error: 'Enter a valid email and password.' }, { status: 400 });
    }

    const account = await verifyPortalSignIn(email, password);
    // Generic message on every failure branch below — never reveal WHICH
    // check failed (credentials vs role vs tenant assignment), matching the
    // account-enumeration discipline the rest of the auth surface uses.
    const deny = () => NextResponse.json({ error: 'Invalid credentials or not authorized to impersonate this tenant.' }, { status: 401 });

    if (!account) return deny();
    // Impersonation is a PLATFORM capability (Tier 1/2), never something a
    // tenant's own owner/staff/customer grants themselves.
    if (account.role !== 'sales' && account.role !== 'super_admin') return deny();

    const { serviceRoleKey } = readSupabaseEnv();
    const tenantRows = (await supabaseRestFetch(
      `/tenants?id=eq.${encodeURIComponent(targetTenantId)}&select=id,name`,
      { key: serviceRoleKey },
    ).catch(() => null)) as Array<{ id: string; name: string }> | null;
    const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    if (!tenant) return deny();

    if (account.role === 'sales') {
      const assignmentRows = (await supabaseRestFetch(
        `/sales_tenant_assignments?sales_user_id=eq.${encodeURIComponent(account.id)}&tenant_id=eq.${encodeURIComponent(targetTenantId)}&select=tenant_id`,
        { key: serviceRoleKey },
      ).catch(() => null)) as Array<{ tenant_id: string }> | null;
      if (!Array.isArray(assignmentRows) || assignmentRows.length === 0) return deny();
    }
    // super_admin bypasses the assignment check (unrestricted, same as every
    // other super_admin gate in this codebase) but the session is STILL
    // marked `impersonating` and still excluded from the full-admin routes —
    // even a super_admin explicitly entering impersonation mode gets the
    // reduced, audited capability set, not a silent full-access bypass.

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'System offline.' }, { status: 500 });

    const { token, maxAgeSeconds } = await issueAdminDevice(
      redis,
      account.email,
      false,
      { role: account.role, impersonating: true, tenantId: targetTenantId },
      IMPERSONATION_TTL_SECONDS,
    );

    await appendAudit(
      redis,
      {
        action: 'STAFF_IMPERSONATION_STARTED',
        detail: `${account.email} (${account.role}) entered tenant ${tenant.name} (${tenant.id})`,
        actor: account.email,
        email: account.email,
        staffId: account.id,
        tenantId: tenant.id,
      },
      request,
    );

    const response = NextResponse.json({
      ok: true,
      tenant: { id: tenant.id, name: tenant.name },
      expiresInSeconds: maxAgeSeconds,
    });
    response.cookies.set(ADMIN_DEVICE_COOKIE, token, portalCookieAttrs(request, 'admin', maxAgeSeconds));
    return response;
  } catch (err: any) {
    console.error('[admin/impersonate] failed', err?.message || err);
    return NextResponse.json({ error: 'Could not start impersonation.' }, { status: 500 });
  }
}
