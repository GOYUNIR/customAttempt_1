/**
 * One store's stock, per product and size (on hand / held / available), plus
 * sales in the last 30 days that were paid for more units than were on hand
 * ("oversold by N"). Shared by the merchant dashboard (/api/merchant/stock)
 * and the original store's admin (/api/admin/stock): same numbers, same
 * shape, whichever store's screen shows them. The caller decides the store.
 */
import { getDb } from '@/lib/db/client';
import { eq, gt, gte } from '@/lib/db/query';
import { loadProducts } from '@/lib/server-config';
import { stockLevels } from '@/lib/stock';

export type StockOverview = {
  products: Array<{ productId: string; name: string; sizes: Array<{ size: string; variantId: string | null; onHand: number; held: number; available: number; tracked: boolean }> }>;
  oversold: Array<{ variantId: string; item: string; shortfall: number; reference: string; at: string }>;
};

export async function stockOverview(tenantId: string): Promise<StockOverview> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [products, variants, levels, oversold] = await Promise.all([
    loadProducts(null, { tenantId }),
    getDb().select<any>('product_variants', { where: { tenant_id: eq(tenantId) }, select: ['id', 'option_label', { relation: 'products', columns: ['external_id'] }] as any }),
    stockLevels(tenantId),
    getDb().select<any>('stock_movements', {
      where: { tenant_id: eq(tenantId), shortfall: gt(0), created_at: gte(since) },
      select: ['variant_id', 'shortfall', 'reference', 'created_at'], order: { column: 'created_at', ascending: false }, limit: 50,
    }),
  ]);
  const idOf = new Map<string, string>();
  for (const v of variants as any[]) idOf.set(String(v.products?.external_id) + '|' + String(v.option_label), String(v.id));
  const nameOf = new Map<string, string>();
  const out = (Object.values(products) as any[]).map((p) => ({
    productId: String(p.id),
    name: String(p.name || ''),
    sizes: ((p.priceCategories || []) as any[]).map((c) => {
      const variantId = idOf.get(String(p.id) + '|' + String(c.size)) || null;
      if (variantId) nameOf.set(variantId, p.name + ' (' + c.size + ')');
      const l = variantId ? levels.get(variantId) : undefined;
      return { size: String(c.size), variantId, onHand: l?.onHand ?? 0, held: l?.held ?? 0, available: l?.available ?? 0, tracked: Boolean(l) };
    }),
  }));
  return {
    products: out,
    oversold: (oversold as any[]).map((m) => ({ variantId: m.variant_id, item: nameOf.get(String(m.variant_id)) || 'Removed item', shortfall: m.shortfall, reference: m.reference, at: m.created_at })),
  };
}

/** The last 50 stock changes of one size of one store (store AND size both filter). */
export async function stockHistory(tenantId: string, variantId: string) {
  const rows = (await getDb().select<any>('stock_movements', {
    where: { tenant_id: eq(tenantId), variant_id: eq(variantId) },
    select: ['reason', 'delta', 'quantity_after', 'shortfall', 'reference', 'actor', 'note', 'created_at'],
    order: { column: 'id', ascending: false }, limit: 50,
  })) as any[];
  return rows.map((m) => ({ reason: m.reason, change: m.delta, after: m.quantity_after, shortfall: m.shortfall, by: m.actor, note: m.note, reference: m.reference, at: m.created_at }));
}
