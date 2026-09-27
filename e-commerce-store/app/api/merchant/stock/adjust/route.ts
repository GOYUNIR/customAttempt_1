import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { adjustStock } from '@/lib/stock';
import { validateStockAdjust } from '@/lib/merchant-stock-input';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Add or remove units on one of THIS store's sizes (restock, damaged, correction). Never below zero. */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_stock', request, 60, 60);
  if (limited) return limited;
  const check = validateStockAdjust(await request.json().catch(() => null));
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const { variantId, delta, reason, note } = check.value;
  const r = await adjustStock(gate.session.tenantId, variantId, delta, reason, gate.session.email, note);
  if (!r.ok) {
    if (r.reason === 'no_stock_row') return merchantJson({ error: 'Unknown size.' }, 404);
    if (r.reason === 'below_zero') return merchantJson({ error: 'That would take stock below zero (' + r.onHand + ' on hand).' }, 409);
    return merchantJson({ error: 'Stock could not be changed.' }, 409);
  }
  await auditMerchant(gate.session, request, 'STOCK_ADJUSTED', variantId + ': ' + (delta > 0 ? '+' : '') + delta + ' ' + reason + ', ' + r.before + ' -> ' + r.onHand + (note ? ' (' + note + ')' : ''));
  return merchantJson({ onHand: r.onHand, held: r.held, available: Math.max(0, r.onHand - r.held), before: r.before });
}
