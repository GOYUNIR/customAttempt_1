import { NextResponse } from 'next/server';
import { createRedisClient, findAllOpenOrders, adminUpdateOrderAddress, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const variant = String(body?.variant || '');
    const size = String(body?.size || '');
    const email = String(body?.email || '').trim().toLowerCase();
    const newAddress = String(body?.newAddress || '').trim();

    if (!variant || !size || !email || !newAddress) {
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

    await adminUpdateOrderAddress(redis, target, newAddress);
    return NextResponse.json({ success: true, message: 'Address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}