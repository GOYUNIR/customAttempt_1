import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { validateVariantParam } from '@/lib/merchant-stock-input';
import { stockHistory } from '@/lib/stock-overview';

export const dynamic = 'force-dynamic';

/** The last 50 stock changes of one of THIS store's sizes (store AND size both filter). */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const variantId = validateVariantParam(new URL(request.url).searchParams.get('variantId'));
  if (!variantId) return merchantJson({ error: 'Unknown size.' }, 400);
  return merchantJson({ history: await stockHistory(gate.session.tenantId, variantId) });
}
