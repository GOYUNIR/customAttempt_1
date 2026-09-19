import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasPlatformAdminAccess } from '@/lib/admin-actor';
import { getDb } from '@/lib/db/client';

import { recordPlatformAudit } from '@/lib/platform-audit';
import { createInvite, INVITE_TTL_DAYS } from '@/lib/staff-invites';
import { sendStaffInviteEmail } from '@/lib/email';
import { acceptInviteUrl } from '@/lib/staff-realms';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/tenants — backs `components/admin/TenantOnboardingWizard.tsx`.
 * Honestly scoped to what the schema supports today: creating a `tenants`
 * row (name/slug/business_type). This is NOT a full multi-tenant SaaS
 * onboarding flow (billing, DNS, storefront provisioning) — that doesn't
 * map to anything real in this single-tenant-by-default template yet; see
 * DEPLOYMENT.md's Known Gaps. Platform-admin-only — tenant creation is a
 * platform capability, not a merchant one.
 */
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
      return NextResponse.json({ ok: true, tenants: [], notConfigured: true });
    }
    const tenants = await getDb()
      .select('tenants', {
        select: ['id', 'name', 'slug', 'business_type', 'created_at'],
        order: { column: 'created_at', ascending: false },
        limit: 200,
      })
      .catch(() => []);
    return NextResponse.json({ ok: true, tenants: tenants ?? [], notConfigured: false });
  } catch (err: any) {
    console.error('[admin/tenants] list failed', err?.message || err);
    return NextResponse.json({ error: 'Could not list tenants.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasPlatformAdminAccess(actor)) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ error: 'Tenant onboarding requires Supabase.' }, { status: 503 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const name = String(body?.name || '').trim().slice(0, 200);
    const slug = String(body?.slug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
    const businessType = typeof body?.businessType === 'string' ? body.businessType.trim().slice(0, 100) : null;
    if (!name || !slug) {
      return NextResponse.json({ error: 'name and slug are required.' }, { status: 400 });
    }

    const created = (await getDb().insert('tenants', {
      name,
      slug,
      business_type: businessType,
      license_status: 'active',
    }).catch((err) => {
      throw err;
    })) as Array<{ id: string; name: string; slug: string }>;
    if (!created?.[0]) {
      return NextResponse.json({ error: 'Could not create tenant (slug may already be in use).' }, { status: 409 });
    }

    await recordPlatformAudit({
      action: 'tenant_created',
      actor: actor?.email || undefined,
      detail: { tenantId: created[0].id, name, slug },
    });

    // PROVISION AN OWNER. A tenant with no owner is a store nobody can sign in
    // to — which is exactly what this route produced before: creating the row
    // was the whole operation, and no code path anywhere created a staff
    // identity to go with it.
    //
    // An INVITE rather than a password chosen here on the operator's behalf:
    // the owner picks their own credential, the platform admin never handles
    // it, and the address is proven by the fact that the link arrives in it.
    let ownerInvite: { email: string; emailed: boolean; acceptUrl?: string } | null = null;
    const ownerEmail = String(body?.ownerEmail || '').trim().toLowerCase();
    if (ownerEmail) {
      const invite = await createInvite({
        email: ownerEmail,
        role: 'owner',
        tenantId: created[0].id,
        invitedByEmail: actor?.email || 'platform-admin',
      });
      if (invite.ok) {
        // Absolute, staff-host URL — see acceptInviteUrl's doc for why
        // getSiteUrl() shipped a bare relative path here.
        const acceptUrl = acceptInviteUrl('owner', invite.token, process.env.PLATFORM_ROOT_DOMAIN);
        const sent = await sendStaffInviteEmail({
          to: ownerEmail,
          role: 'owner',
          invitedBy: actor?.email || 'the platform team',
          acceptUrl,
          expiresInDays: INVITE_TTL_DAYS,
        });
        ownerInvite = {
          email: ownerEmail,
          emailed: sent.ok === true,
          // Returned only when the email could not go out, so the operator can
          // pass the link on by hand. The tenant exists either way; a missing
          // email provider must not leave a store permanently unreachable.
          acceptUrl: sent.ok ? undefined : acceptUrl,
        };
        await recordPlatformAudit({
          action: 'tenant_owner_invited',
          actor: actor?.email || undefined,
          tenantId: created[0].id,
          detail: { tenantId: created[0].id, ownerEmail, emailed: sent.ok === true },
        });
      } else {
        // The tenant is real and already created, so this reports rather than
        // fails: rolling back a tenant over a failed invitation would be a
        // bigger surprise than a store awaiting its owner.
        console.error('[admin/tenants] owner invite failed for ' + ownerEmail + ': ' + invite.message);
        ownerInvite = { email: ownerEmail, emailed: false };
      }
    }

    return NextResponse.json({
      ok: true,
      tenant: created[0],
      ownerInvite,
      // Said plainly rather than left for someone to discover: a tenant with no
      // owner cannot be signed in to by anyone except a platform admin.
      warning: ownerInvite ? undefined : 'No ownerEmail was supplied, so nobody can sign in to this store yet. Invite an owner to finish provisioning it.',
    });
  } catch (err: any) {
    console.error('[admin/tenants] create failed', err?.message || err);
    return NextResponse.json({ error: 'Could not create tenant.' }, { status: 500 });
  }
}
