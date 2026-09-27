import { NextResponse } from 'next/server';
import { stockAdmin, auditStock } from '@/lib/admin-stock';
import { adjustStock } from '@/lib/stock';
import { validateStockAdjust } from '@/lib/merchant-stock-input';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { notifyIfBackInStock } from '@/lib/growth/modules/back-in-stock';

export const dynamic = 'force-dynamic';

/** Add or remove units on one of the original store's sizes. Never below zero. */
export async function POST(request: Request) {
  const gate = await stockAdmin(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('admin_stock', request, 60, 60);
  if (limited) return limited;
  const check = validateStockAdjust(await request.json().catch(() => null));
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  const { variantId, delta, reason, note } = check.value;
  const r = await adjustStock(gate.who.tenantId, variantId, delta, reason, gate.who.actor, note);
  if (!r.ok) {
    if (r.reason === 'no_stock_row') return NextResponse.json({ error: 'Unknown size.' }, { status: 404 });
    if (r.reason === 'below_zero') return NextResponse.json({ error: 'That would take stock below zero (' + r.onHand + ' on hand).' }, { status: 409 });
    return NextResponse.json({ error: 'Stock could not be changed.' }, { status: 409 });
  }
  await auditStock(request, gate.who, 'STOCK_ADJUSTED', variantId + ': ' + (delta > 0 ? '+' : '') + delta + ' ' + reason + ', ' + r.before + ' -> ' + r.onHand + (note ? ' (' + note + ')' : ''));
  await notifyIfBackInStock(gate.who.tenantId, variantId, r.before, r.onHand).catch(() => {});
  return NextResponse.json({ onHand: r.onHand, held: r.held, available: Math.max(0, r.onHand - r.held), before: r.before });
}
