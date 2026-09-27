import { NextResponse } from 'next/server';
import { stockAdmin, auditStock } from '@/lib/admin-stock';
import { setStock } from '@/lib/stock';
import { validateStockSet } from '@/lib/merchant-stock-input';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { notifyIfBackInStock } from '@/lib/growth/modules/back-in-stock';

export const dynamic = 'force-dynamic';

/** A physical count for one of the original store's sizes (held units stay held). */
export async function POST(request: Request) {
  const gate = await stockAdmin(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('admin_stock', request, 60, 60);
  if (limited) return limited;
  const check = validateStockSet(await request.json().catch(() => null));
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const { variantId, count, note } = check.value;
  const r = await setStock(gate.who.tenantId, variantId, count, gate.who.actor, note);
  if (!r.ok) return NextResponse.json({ error: 'Unknown size.' }, { status: r.reason === 'no_stock_row' ? 404 : 409 });
  if (!r.unchanged) {
    await auditStock(request, gate.who, 'STOCK_COUNTED', variantId + ': ' + r.before + ' -> ' + r.onHand + (note ? ' (' + note + ')' : ''));
    // Restock alerts for the original store, as its old restock path sent them.
    await notifyIfBackInStock(gate.who.tenantId, variantId, r.before, r.onHand).catch(() => {});
  }
  return NextResponse.json({ onHand: r.onHand, held: r.held, available: Math.max(0, r.onHand - r.held), before: r.before });
}
