import { NextResponse } from 'next/server';
import { createRedisClient, findPoolEntriesByEmail } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();
    const newAddress = String(body?.newAddress || '').trim();

    if (!email || last4.length !== 4 || !variant || !size || !newAddress) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const target = matches.find((m) => m.variant === variant && m.size === size && String(m.parsed.cardLast4 || '') === last4);

    if (!target) {
      return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });
    }

    const updated = { ...target.parsed, shippingAddress: newAddress, address: newAddress };
    await redis.lset(target.poolKey, target.index, JSON.stringify(updated));

    return NextResponse.json({ success: true, message: 'Shipping address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}