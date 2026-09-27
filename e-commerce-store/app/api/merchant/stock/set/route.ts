import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { setStock } from '@/lib/stock';
import { validateStockSet } from '@/lib/merchant-stock-input';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * A physical count for one of THIS store's sizes ("there are N"). Units held
 * by open checkouts are still on the shelf, so they stay held: what can be
 * sold is N minus them. The database refuses a size of another store.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_stock', request, 60, 60);
  if (limited) return limited;
  const check = validateStockSet(await request.json().catch(() => null));
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const { variantId, count, note } = check.value;
  const r = await setStock(gate.session.tenantId, variantId, count, gate.session.email, note);
  if (!r.ok) return merchantJson({ error: 'Unknown size.' }, r.reason === 'no_stock_row' ? 404 : 409);
  if (!r.unchanged) await auditMerchant(gate.session, request, 'STOCK_COUNTED', variantId + ': ' + r.before + ' -> ' + r.onHand + (note ? ' (' + note + ')' : ''));
  return merchantJson({ onHand: r.onHand, held: r.held, available: Math.max(0, r.onHand - r.held), before: r.before });
}
