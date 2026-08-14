import { NextResponse } from 'next/server';
import { appendAudit } from '@/app/api/admin/audit/route';
import {
  createRedisClient,
  findAllOpenOrders,
  adminCancelOrder,
  adminUpdateOrderAddress,
  loadProducts,
  getAdminPassword,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

function checkAuth(password: string) {
  const master = getAdminPassword() || '';
  return Boolean(master) && password === master;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!checkAuth(password)) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ orders: [] });

  const liveProducts = await loadProducts(redis);
  const productNames = Object.values(liveProducts).map((p: any) => p.name);
  const orders = await findAllOpenOrders(redis, productNames);

  return NextResponse.json({
    orders: orders.map((o) => ({
      variant: o.variant,
      size: o.size,
      index: o.index,
      email: o.parsed.email,
      shippingAddress: o.parsed.shippingAddress || o.parsed.address || '',
      registeredAt: o.parsed.registeredAt,
      cardLast4: o.parsed.cardLast4 || '',
      promoCode: o.parsed.promoCode || '',
      customerId: o.parsed.customerId || o.parsed.stripeCustomerId || '',
    })),
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!checkAuth(password)) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const action = String(body?.action || '');
  const variant = String(body?.variant || '');
  const size = String(body?.size || '');
  const email = String(body?.email || '').trim().toLowerCase();

  if (!variant || !size || !email) return NextResponse.json({ error: 'Missing order identification.' }, { status: 400 });

  const liveProducts = await loadProducts(redis);
  const productNames = Object.values(liveProducts).map((p: any) => p.name);
  const orders = await findAllOpenOrders(redis, productNames);
  const target = orders.find(
    (o) => o.variant === variant && o.size === size && String(o.parsed.email || '').toLowerCase() === email,
  );
  if (!target) return NextResponse.json({ error: 'Order not found — it may have already changed.' }, { status: 404 });

  if (action === 'cancel') {
    const reason = String(body?.reason || 'Cancelled by admin');
    await adminCancelOrder(redis, target, reason);
    try {
      await appendAudit(redis, { action: 'ENTRY_CANCELLED', detail: `${variant} / ${size} — ${email}${reason !== 'Cancelled by admin' ? ` (${reason})` : ''}`, actor: 'admin', email });
    } catch {}
    return NextResponse.json({ success: true, message: 'Order cancelled.' });
  }

  if (action === 'updateAddress') {
    const newAddress = String(body?.newAddress || '').trim();
    if (!newAddress) return NextResponse.json({ error: 'New address is required.' }, { status: 400 });
    await adminUpdateOrderAddress(redis, target, newAddress);
    try {
      await appendAudit(redis, { action: 'ORDER_ADDRESS_UPDATED', detail: `${variant} / ${size} — ${email} → ${newAddress}`, actor: 'admin', email });
    } catch {}
    return NextResponse.json({ success: true, message: 'Address updated.' });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
