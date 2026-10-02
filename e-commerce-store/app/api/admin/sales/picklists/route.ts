import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasSalesAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/sales/picklists: what the Sales Hub's pickers choose from,
 * BY NAME, instead of pasting raw ids (DEFERRED-11 #6):
 *   - stores: the rep's ASSIGNED stores (sales_tenant_assignments), or every
 *     active store for a super-admin, the same rule /api/admin/impersonate
 *     enforces (this list is a convenience; the route still checks);
 *   - companies: the acting store's B2B companies;
 *   - email: who is signed in (so impersonation asks only for the password).
 * Read-only; sales access required.
 */
export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const actor = await resolveAdminActor(request);
  if (!actorHasSalesAccess(actor)) return NextResponse.json({ error: 'Sales Hub access required.' }, { status: 403 });
  const db = getDb();
  let stores: Array<{ id: string; name: string; slug: string }> = [];
  try {
    let ids: string[] | null = null;
    if (actor && actor.role !== 'super_admin') {
      const me = ((await db.select<any>('users', { where: { email: eq(String(actor.email || '').toLowerCase()) }, select: ['id'], limit: 1 })) as any[])[0];
      ids = me ? ((await db.select<any>('sales_tenant_assignments', { where: { sales_user_id: eq(me.id) }, select: ['tenant_id'], limit: 500 })) as any[]).map((r) => String(r.tenant_id)) : [];
    }
    const rows = ids === null
      ? (await db.select<any>('tenants', { where: { license_status: eq('active') }, select: ['id', 'name', 'slug'], limit: 500 })) as any[]
      : ids.length ? (await db.select<any>('tenants', { where: { id: inList(ids) }, select: ['id', 'name', 'slug'], limit: 500 })) as any[] : [];
    stores = rows.filter((t) => !String(t.slug || '').startsWith('x--')).map((t) => ({ id: String(t.id), name: String(t.name || t.slug), slug: String(t.slug || '') })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { stores = []; }
  let companies: Array<{ id: string; name: string }> = [];
  try {
    const tenantId = await resolveActingTenantId(actor);
    companies = ((await db.select<any>('companies', { where: { tenant_id: eq(tenantId) }, select: ['id', 'name'], limit: 500 })) as any[])
      .map((c) => ({ id: String(c.id), name: String(c.name || c.id) })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { companies = []; }
  return NextResponse.json({ email: actor?.email || null, stores, companies }, { headers: { 'cache-control': 'no-store' } });
}
