import { NextResponse } from 'next/server';
import { stockAdmin } from '@/lib/admin-stock';
import { validateVariantParam } from '@/lib/merchant-stock-input';
import { stockHistory } from '@/lib/stock-overview';

export const dynamic = 'force-dynamic';

/** The last 50 stock changes of one of the original store's sizes. */
export async function GET(request: Request) {
  const gate = await stockAdmin(request);
  if (!gate.ok) return gate.response;
  const variantId = validateVariantParam(new URL(request.url).searchParams.get('variantId'));
  if (!variantId) return NextResponse.json({ error: 'Unknown size.' }, { status: 400 });
  return NextResponse.json({ history: await stockHistory(gate.who.tenantId, variantId) }, { headers: { 'cache-control': 'no-store' } });
}
