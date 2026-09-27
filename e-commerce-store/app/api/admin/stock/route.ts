import { NextResponse } from 'next/server';
import { stockAdmin } from '@/lib/admin-stock';
import { stockOverview } from '@/lib/stock-overview';

export const dynamic = 'force-dynamic';

/** The original store's stock per product and size, plus recent oversells. */
export async function GET(request: Request) {
  const gate = await stockAdmin(request);
  if (!gate.ok) return gate.response;
  return NextResponse.json(await stockOverview(gate.who.tenantId), { headers: { 'cache-control': 'no-store' } });
}
