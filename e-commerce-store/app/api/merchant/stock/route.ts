import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { stockOverview } from '@/lib/stock-overview';

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
  return merchantJson(await stockOverview(gate.session.tenantId));
}
