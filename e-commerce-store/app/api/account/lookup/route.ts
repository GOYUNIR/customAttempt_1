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
    if (!email || last4.length !== 4) return NextResponse.json({ error: 'Enter your email and the last 4 digits of your card.' }, { status: 400 });

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const verified = matches.filter((m) => String(m.parsed.cardLast4 || '') === last4);
    if (verified.length === 0) return NextResponse.json({ error: 'No matching entry found. Double check your email and card digits.' }, { status: 404 });

    const entries = verified.map((m) => ({ variant: m.variant, size: m.size, shippingAddress: m.parsed.shippingAddress || m.parsed.address || '', registeredAt: m.parsed.registeredAt }));
    return NextResponse.json({ success: true, entries });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}