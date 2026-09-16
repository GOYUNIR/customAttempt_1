import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasPlatformAdminAccess, type AdminActorRole } from '@/lib/admin-actor';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/users — Role Management for the Platform Admin portal
 * (`components/admin/UserRoleManager.tsx`, admin.site.com only).
 *
 * Gated by `actorHasPlatformAdminAccess` (super_admin ONLY, never during
 * impersonation) — managing who holds which RBAC role is exactly the kind
 * of platform-operator action `lib/admin-actor.ts` reserves for that tier,
 * distinct from `actorHasFullAdminAccess` (which also admits `owner`) and
 * `actorHasMerchantAccess` (day-to-day merchant-hub actions).
 *
 *   GET   — list `users` (id/email/role) + the most recent audit-log rows.
 *   PATCH { userId, role } — update one user's role (migration 00015's
 *          allowed set); writes an audit-log entry for the change itself.
 */
const ALLOWED_ROLES: AdminActorRole[] = ['super_admin', 'owner', 'staff', 'sales', 'sales_rep', 'sales_admin', 'deal_desk'];

export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasPlatformAdminAccess(actor)) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Role management requires Supabase.' }, { status: 503 });
    }

    const [users, auditLogs] = await Promise.all([
      getDb().select('users', { select: ['id', 'email', 'role'], order: { column: 'email' }, limit: 500 }).catch(() => []),
      getDb()
        .select('audit_logs', {
          select: ['id', 'actor', 'action', 'detail', 'created_at'],
          order: { column: 'created_at', ascending: false },
          limit: 50,
        })
        .catch(() => []),
    ]);

    return NextResponse.json({ ok: true, users: users ?? [], auditLogs: auditLogs ?? [], allowedRoles: ALLOWED_ROLES });
  } catch (err: any) {
    console.error('[admin/users] list failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load users.' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const limited = await rateLimitedResponse('admin_users_role_update', request, 20, 60);
    if (limited) return limited;

    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasPlatformAdminAccess(actor)) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Role management requires Supabase.' }, { status: 503 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const userId = String(body?.userId || '').trim();
    const role = String(body?.role || '').trim() as AdminActorRole;
    if (!userId || !ALLOWED_ROLES.includes(role)) {
      return NextResponse.json({ error: `userId and a valid role are required (one of: ${ALLOWED_ROLES.join(', ')}).` }, { status: 400 });
    }
    const updated = await getDb().update<{ id: string; email: string; role: string }>(
      'users',
      { where: { id: eq(userId) } },
      { role },
    );
    if (!Array.isArray(updated) || updated.length === 0) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    await recordPlatformAudit({
      action: 'user_role_updated',
      actor: actor?.email || undefined,
      detail: { targetUserId: userId, targetEmail: updated[0].email, newRole: role },
    });

    return NextResponse.json({ ok: true, user: updated[0] });
  } catch (err: any) {
    console.error('[admin/users] role update failed', err?.message || err);
    return NextResponse.json({ error: 'Could not update role.' }, { status: 500 });
  }
}
