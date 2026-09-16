import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasMerchantAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/inventory-matrix — backs
 * `components/admin/InventoryAllocationMatrix.tsx`: a real table over
 * `product_variants` + `inventory_levels` (+ `shared_inventory_pools` where
 * a variant draws from a shared pool instead of its own row). Read-only,
 * gated by `actorHasMerchantAccess` — inventory visibility is a day-to-day
 * merchant action.
 */
export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasMerchantAccess(actor)) {
      return NextResponse.json({ error: 'Merchant Hub access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ ok: true, rows: [], notConfigured: true });
    }

    const tenantId = await resolveActingTenantId(actor);

    const variants = (await getDb()
      .select<{ id: string; option_label: string; shared_pool_id: string | null; products: { name: string } | null }>('product_variants', {
        where: { tenant_id: eq(tenantId) },
        select: ['id', 'option_label', 'shared_pool_id', { relation: 'products', columns: ['name'] }],
      })
      .catch(() => [])) as Array<{ id: string; option_label: string; shared_pool_id: string | null; products: { name: string } | null }>;

    const variantIds = variants.map((v) => v.id);
    const inventoryRows = variantIds.length
      ? ((await getDb()
          .select<{ variant_id: string; quantity_available: number; quantity_reserved: number }>('inventory_levels', {
            where: { variant_id: inList(variantIds) },
            select: ['variant_id', 'quantity_available', 'quantity_reserved'],
          })
          .catch(() => [])) as Array<{ variant_id: string; quantity_available: number; quantity_reserved: number }>)
      : [];
    const inventoryByVariant = new Map(inventoryRows.map((r) => [r.variant_id, r]));

    const poolIds = [...new Set(variants.map((v) => v.shared_pool_id).filter((id): id is string => Boolean(id)))];
    const pools = poolIds.length
      ? ((await getDb()
          .select<{ id: string; slug: string; quantity_available: number; quantity_reserved: number }>('shared_inventory_pools', {
            where: { id: inList(poolIds) },
            select: ['id', 'slug', 'quantity_available', 'quantity_reserved'],
          })
          .catch(() => [])) as Array<{ id: string; slug: string; quantity_available: number; quantity_reserved: number }>)
      : [];
    const poolById = new Map(pools.map((p) => [p.id, p]));

    const rows = variants.map((v) => {
      const pool = v.shared_pool_id ? poolById.get(v.shared_pool_id) : null;
      const inv = pool
        ? { quantity_available: pool.quantity_available, quantity_reserved: pool.quantity_reserved }
        : inventoryByVariant.get(v.id);
      return {
        variantId: v.id,
        productName: v.products?.name || 'Unknown',
        size: v.option_label,
        pooled: pool ? pool.slug : null,
        available: inv ? Number(inv.quantity_available) || 0 : 0,
        reserved: inv ? Number(inv.quantity_reserved) || 0 : 0,
        hasRow: Boolean(inv),
      };
    });
    rows.sort((a, b) => a.available - b.available);

    return NextResponse.json({ ok: true, rows, notConfigured: false });
  } catch (err: any) {
    console.error('[admin/inventory-matrix] failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load inventory matrix.' }, { status: 500 });
  }
}
