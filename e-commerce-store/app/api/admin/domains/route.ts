import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor, actorHasFullAdminAccess } from '@/lib/admin-verify';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { cloudflareConfigured, syncTenantDomainStatus, deleteCustomHostname } from '@/lib/cloudflare-saas';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { appendAudit } from '@/app/api/admin/audit/route';
import { createKvClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/domains — custom-domain status for the acting tenant
 * (Phase 4: Cloudflare for SaaS). See lib/cloudflare-saas.ts's header for
 * why this never throws when Cloudflare isn't configured — `GET` reports
 * `{ configured: false }` instead, so the admin panel can render a setup
 * prompt rather than an error screen.
 */
export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!cloudflareConfigured()) {
    return NextResponse.json({ ok: true, configured: false });
  }
  if (!getDb().configured) {
    return NextResponse.json({ ok: true, configured: true, error: 'Supabase is not configured.' });
  }

  const actor = await resolveAdminActor(request);
  const tenantId = await resolveActingTenantId(actor);
  const rows = (await getDb()
    .select<Record<string, unknown>>('tenants', {
      where: { id: eq(tenantId) },
      select: ['custom_domain', 'domain_status', 'ssl_status', 'domain_verification', 'domain_checked_at'],
      limit: 1,
    })
    .catch(() => [])) as Array<Record<string, unknown>>;

  return NextResponse.json({ ok: true, configured: true, tenantId, domain: rows?.[0] || null });
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('admin_domain_sync', request, 10, 60);
    if (limited) return limited;

    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // RBAC: attaching a custom domain changes where customer traffic (and
    // therefore checkout) resolves to — a Staff Impersonation session
    // never reaches it, same bar as provider-keys/wipe/webhooks.
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Not permitted for an impersonation session.' }, { status: 403 });
    }
    if (!cloudflareConfigured()) {
      return NextResponse.json(
        { error: 'Cloudflare for SaaS is not configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.' },
        { status: 503 },
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const hostname = String(body?.hostname || '').trim().toLowerCase();
    if (!hostname || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
      return NextResponse.json({ error: 'Enter a valid domain (e.g. store.yourbrand.com).' }, { status: 400 });
    }

    const tenantId = await resolveActingTenantId(actor);
    const result = await syncTenantDomainStatus(tenantId, hostname);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.notConfigured ? 503 : 502 });
    }

    const redis = createKvClient();
    if (redis) {
      await appendAudit(
        redis,
        { action: 'CUSTOM_DOMAIN_LINKED', detail: `${hostname} → ${result.data.domainStatus}/${result.data.sslStatus}`, actor: actor?.email || 'admin', tenantId },
        request,
      );
    }

    return NextResponse.json({ ok: true, hostname, ...result.data });
  } catch (err: any) {
    console.error('[admin/domains] sync failed', err?.message || err);
    return NextResponse.json({ error: 'Could not sync domain status.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Not permitted for an impersonation session.' }, { status: 403 });
    }
    if (!cloudflareConfigured() || !getDb().configured) {
      return NextResponse.json({ error: 'Cloudflare/Supabase not configured.' }, { status: 503 });
    }

    const tenantId = await resolveActingTenantId(actor);
    const rows = (await getDb()
      .select<{ cloudflare_hostname_id: string | null }>('tenants', {
        where: { id: eq(tenantId) },
        select: ['cloudflare_hostname_id'],
        limit: 1,
      })
      .catch(() => [])) as Array<{ cloudflare_hostname_id: string | null }>;
    const hostnameId = rows?.[0]?.cloudflare_hostname_id;
    if (hostnameId) {
      const deleted = await deleteCustomHostname(hostnameId);
      if (!deleted.ok) return NextResponse.json({ error: deleted.error }, { status: 502 });
    }

    // returning: 'default' — the legacy PATCH sent no Prefer header.
    await getDb().update('tenants', { where: { id: eq(tenantId) } }, {
        custom_domain: null,
        cloudflare_hostname_id: null,
        domain_status: 'unconfigured',
        ssl_status: 'unconfigured',
        domain_verification: {},
      },
      { returning: 'default' },
    );

    const redis = createKvClient();
    if (redis) {
      await appendAudit(redis, { action: 'CUSTOM_DOMAIN_REMOVED', actor: actor?.email || 'admin', tenantId }, request);
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[admin/domains] delete failed', err?.message || err);
    return NextResponse.json({ error: 'Could not remove domain.' }, { status: 500 });
  }
}
