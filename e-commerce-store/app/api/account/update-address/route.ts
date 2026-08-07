import { NextResponse } from 'next/server';
import { createRedisClient, findAllOpenOrders, adminUpdateOrderAddress, loadProducts } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Login required.' }, { status: 401 });

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const email = sessionUser.email;
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();
    const newAddress = String(body?.newAddress || '').trim();

    if (!email || !variant || !size || !newAddress) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    const liveProducts = await loadProducts(redis);
    const productNames = Object.values(liveProducts).map((p: any) => p.name);
    const orders = await findAllOpenOrders(redis, productNames);
    const target = orders.find(
      (o) => o.variant === variant && o.size === size && String(o.parsed.email || '').toLowerCase() === email
    );
    if (!target) {
      return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
    }

    // Also verify last4 if provided (optional)
    if (last4 && String(target.parsed.cardLast4 || '') !== last4) {
      return NextResponse.json({ error: 'Card last4 does not match.' }, { status: 403 });
    }

    await adminUpdateOrderAddress(redis, target, newAddress);
    return NextResponse.json({ success: true, message: 'Address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}