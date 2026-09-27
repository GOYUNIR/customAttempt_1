import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq, gt, gte } from '@/lib/db/query';
import { loadProducts } from '@/lib/server-config';
import { stockLevels } from '@/lib/stock';

export const dynamic = 'force-dynamic';

/**
 * THIS store's stock, per product and size: on hand, held by open checkouts
 * (or drawn winners), and available to sell. Plus any sale in the last 30
 * days that was paid for more units than were on hand ("oversold by N"), so
 * the merchant can decide what to do: never refunded automatically.
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const tenantId = gate.session.tenantId;
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
  return merchantJson({
    products: out,
    oversold: (oversold as any[]).map((m) => ({ variantId: m.variant_id, item: nameOf.get(String(m.variant_id)) || 'Removed item', shortfall: m.shortfall, reference: m.reference, at: m.created_at })),
  });
}
