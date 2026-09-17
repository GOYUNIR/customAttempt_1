import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasFullAdminAccess, actorHasPlatformAdminAccess } from '@/lib/admin-actor';
import { getDb } from '@/lib/db/client';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { appendAudit } from '@/app/api/admin/audit/route';
import { createKvClient } from '@/lib/server-config';
import { createInvite, listInvites, revokeInvite, INVITE_TTL_DAYS } from '@/lib/staff-invites';
import { sendStaffInviteEmail } from '@/lib/email';
import { getSiteUrl } from '@/lib/env';
import { ensureDefaultTenant } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/staff-invites — invite people to become staff.
 *
 *   GET    — pending + historical invites for the actor's scope
 *   POST   { email, role, tenantId? }  — issue one, and email it
 *   DELETE { id }                      — revoke a pending one
 *
 * PRIVILEGE MODEL, two tiers, because "can invite" is not one permission:
 *
 *   - Issuing any invite at all needs full admin access (super_admin or owner).
 *     `staff` deliberately cannot: the merchant hub's day-to-day operators
 *     should not be able to mint colleagues.
 *   - Issuing a SUPER_ADMIN invite, or a PLATFORM-LEVEL one (no tenant), needs
 *     platform admin access — super_admin only. Otherwise an owner could invite
 *     a super_admin and escalate straight past their own ceiling, which is the
 *     classic invite-flow privilege bug.
 *
 * A non-super-admin is also pinned to their OWN tenant, so an owner cannot
 * invite staff into somebody else's store.
 */

function actorTenantOr(actor: { tenantId?: string | null } | null, fallback: string | null): string | null {
  return actor?.tenantId ?? fallback;
}

export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Staff invitations require Supabase.' }, { status: 503 });
    }

    // A super_admin sees every invite; anyone else sees only their tenant's.
    const scope = actorHasPlatformAdminAccess(actor) ? null : actorTenantOr(actor, await ensureDefaultTenant());
    const invites = await listInvites(scope);
    return NextResponse.json({ invites, ttlDays: INVITE_TTL_DAYS });
  } catch (err: any) {
    console.error('[staff-invites] list failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load invitations.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Staff invitations require Supabase.' }, { status: 503 });
    }

    // An invite is a grant of privilege sent to an arbitrary address — rate
    // limited so a compromised admin session cannot spray them.
    const limited = await rateLimitedResponse('staff_invite_create', request, 20, 300);
    if (limited) return limited;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const email = String(body?.email || '').trim().toLowerCase();
    const role = String(body?.role || '').trim();
    const isPlatform = actorHasPlatformAdminAccess(actor);

    // ESCALATION GATE. Without this an owner could invite a super_admin and
    // hand themselves a higher ceiling than they hold.
    if ((role === 'super_admin' || body?.tenantId === null) && !isPlatform) {
      return NextResponse.json(
        { error: 'Only a platform admin can issue super-admin or platform-level invitations.' },
        { status: 403 },
      );
    }

    // A non-platform actor is pinned to their own tenant, whatever they asked
    // for. A platform admin may target any tenant, or none.
    const requestedTenant = body?.tenantId === null ? null : (body?.tenantId ? String(body.tenantId) : undefined);
    const tenantId = isPlatform
      ? (requestedTenant === undefined ? await ensureDefaultTenant() : requestedTenant)
      : actorTenantOr(actor, await ensureDefaultTenant());

    const result = await createInvite({
      email,
      role,
      tenantId,
      invitedByEmail: actor?.email || 'admin',
    });
    if (!result.ok) {
      const status = result.reason === 'already_invited' || result.reason === 'already_staff' ? 409 : 400;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }

    // The token exists in exactly one place from here on: this link.
    const acceptUrl = `${getSiteUrl().replace(/\/$/, '')}/admin/accept-invite?token=${encodeURIComponent(result.token)}`;
    const sent = await sendStaffInviteEmail({
      to: email,
      role: result.invite.role,
      invitedBy: result.invite.invitedByEmail,
      acceptUrl,
      expiresInDays: INVITE_TTL_DAYS,
    });

    const redis = createKvClient();
    if (redis) {
      await appendAudit(redis, {
        action: 'STAFF_INVITE_CREATED',
        detail: `${email} invited as ${result.invite.role}`,
        email: actor?.email || undefined,
        tenantId,
      }, request).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      invite: result.invite,
      emailed: sent.ok === true,
      // When no email provider is configured the invite is still valid — the
      // link is returned so the operator can pass it on by hand rather than
      // being told the invitation "failed" when the account grant is real.
      acceptUrl: sent.ok ? undefined : acceptUrl,
      emailError: sent.ok ? undefined : sent.error,
    });
  } catch (err: any) {
    console.error('[staff-invites] create failed', err?.message || err);
    return NextResponse.json({ error: 'Could not send the invitation.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body?.id || '').trim();
    if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 });

    const revoked = await revokeInvite(id);
    if (!revoked) {
      return NextResponse.json(
        { error: 'That invitation is not pending — it may already be accepted or revoked.' },
        { status: 409 },
      );
    }

    const redis = createKvClient();
    if (redis) {
      await appendAudit(redis, {
        action: 'STAFF_INVITE_REVOKED',
        detail: `invite ${id}`,
        email: actor?.email || undefined,
      }, request).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[staff-invites] revoke failed', err?.message || err);
    return NextResponse.json({ error: 'Could not revoke the invitation.' }, { status: 500 });
  }
}
