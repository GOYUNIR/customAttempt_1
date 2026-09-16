import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasPlatformAdminAccess } from '@/lib/admin-actor';
import { getDb } from '@/lib/db/client';

import { recordPlatformAudit } from '@/lib/platform-audit';

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

    return NextResponse.json({ ok: true, tenant: created[0] });
  } catch (err: any) {
    console.error('[admin/tenants] create failed', err?.message || err);
    return NextResponse.json({ error: 'Could not create tenant.' }, { status: 500 });
  }
}
