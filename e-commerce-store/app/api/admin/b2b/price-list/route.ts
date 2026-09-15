import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasSalesAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/b2b/price-list?companyId=… — backs
 * `components/sales/VolumeDiscountMatrix.tsx`: a company's net terms
 * (`companies.net_terms_days`, already a real column) and its contract
 * price-list entries (already modeled — variant × min_quantity ×
 * unit_price_cents, `lib/b2b/pricing.ts`'s `tiersForVariant` renders the
 * ladder). No new schema — this is a read-only view over what
 * `/api/admin/b2b/quotes` already prices against.
 */
export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasSalesAccess(actor)) {
      return NextResponse.json({ error: 'Sales Hub access required.' }, { status: 403 });
    }
    if (!supabaseServiceConfigured()) {
      return NextResponse.json({ error: 'The B2B engine requires Supabase.' }, { status: 503 });
    }

    const url = new URL(request.url);
    const companyId = String(url.searchParams.get('companyId') || '').trim();
    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
    }

    const tenantId = await resolveActingTenantId(actor);
    const { serviceRoleKey } = readSupabaseEnv();

    const companies = (await supabaseRestFetch(
      `/companies?id=eq.${encodeURIComponent(companyId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,name,net_terms_days,credit_limit_cents,credit_used_cents`,
      { key: serviceRoleKey },
    ).catch(() => [])) as Array<{ id: string; name: string; net_terms_days: number; credit_limit_cents: number; credit_used_cents: number }>;
    const company = companies?.[0];
    if (!company) {
      return NextResponse.json({ error: 'Company not found for this tenant.' }, { status: 404 });
    }

    const priceLists = (await supabaseRestFetch(
      `/price_lists?company_id=eq.${encodeURIComponent(companyId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=id&limit=1`,
      { key: serviceRoleKey },
    ).catch(() => [])) as Array<{ id: string }>;
    const priceListId = priceLists?.[0]?.id;

    let entries: Array<{ variant_id: string; unit_price_cents: number; min_quantity: number }> = [];
    if (priceListId) {
      entries = (await supabaseRestFetch(
        `/price_list_entries?price_list_id=eq.${encodeURIComponent(priceListId)}&select=variant_id,unit_price_cents,min_quantity&order=variant_id.asc,min_quantity.asc`,
        { key: serviceRoleKey },
      ).catch(() => [])) as typeof entries;
    }

    return NextResponse.json({ ok: true, company, entries });
  } catch (err: any) {
    console.error('[admin/b2b/price-list] failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load price list.' }, { status: 500 });
  }
}
