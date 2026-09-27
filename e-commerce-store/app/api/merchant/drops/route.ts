import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { loadProducts } from '@/lib/server-config';
import { getSizeCheckoutMode } from '@/lib/storefront-config';
import { resolveSizeReleaseEndsAt } from '@/lib/size-configs';

export const dynamic = 'force-dynamic';

/**
 * The signed-in merchant's raffles and waitlists: per size, its draw date and
 * how many entries are in each state, plus recent draws. Counts only; the
 * entries themselves are behind /entries, and no card detail is ever sent.
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const tenantId = gate.session.tenantId;
  const db = getDb();
  const [products, variants, entries, draws] = await Promise.all([
    loadProducts(null, { tenantId }),
    db.select<any>('product_variants', { where: { tenant_id: eq(tenantId) }, select: ['id', 'option_label', { relation: 'products', columns: ['external_id'] }] }),
    db.select<any>('raffle_entries', { where: { tenant_id: eq(tenantId) }, select: ['variant_id', 'status', 'entry_type'] }),
    db.select<any>('drop_draws', { where: { tenant_id: eq(tenantId) }, select: ['variant_id', 'winner_count', 'entries_count', 'executed_at'], order: { column: 'executed_at', ascending: false }, limit: 20 }),
  ]);
  const idOf = new Map<string, string>();
  for (const v of variants as any[]) idOf.set(String(v.products?.external_id) + '|' + String(v.option_label), String(v.id));
  const nameOf = new Map<string, string>();
  const drops: any[] = [];
  for (const p of Object.values(products) as any[]) {
    for (const c of (p.priceCategories || []) as any[]) {
      const size = String(c.size);
      const variantId = idOf.get(String(p.id) + '|' + size);
      if (!variantId) continue;
      nameOf.set(variantId, p.name + ' (' + size + ')');
      const mode = getSizeCheckoutMode(p, size);
      const mine = (entries as any[]).filter((e) => e.variant_id === variantId);
      const isWaitlist = mode === 'FCFS' && mine.some((e) => e.entry_type === 'waitlist');
      if (mode !== 'RAFFLE' && !isWaitlist && p.isUpcoming !== true) continue;
      const count = (status: string) => mine.filter((e) => e.status === status).length;
      drops.push({
        variantId, product: p.name, size, kind: mode === 'RAFFLE' ? 'raffle' : 'waitlist',
        drawAt: mode === 'RAFFLE' ? String(resolveSizeReleaseEndsAt(p, size) || '') : null,
        stock: c.liveStock ?? null,
        entries: { pending: count('pending'), winner: count('winner'), charged: count('charged'), declined: count('declined'), cancelled: count('cancelled') },
      });
    }
  }
  return merchantJson({
    drops,
    recentDraws: (draws as any[]).map((d) => ({ item: nameOf.get(String(d.variant_id)) || 'Removed item', winners: d.winner_count, entries: d.entries_count, at: d.executed_at })),
  });
}
