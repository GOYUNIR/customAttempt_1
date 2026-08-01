import { NextResponse } from 'next/server';
import { createRedisClient, ARCHIVE_LEDGER_KEY, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const ALLOWED = ['PENDING_FULFILLMENT', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'];

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (password !== process.env.ADMIN_BASIC_AUTH_PASSWORD) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const email = String(body?.email || '').toLowerCase();
    const variant = String(body?.variant || '');
    const size = String(body?.size || '');
    const shippingStatus = String(body?.shippingStatus || '');
    if (!email || !variant || !ALLOWED.includes(shippingStatus)) {
      return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
    }

    const all = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    let updated = 0;
    for (let i = 0; i < all.length; i++) {
      const e = safeParseRedisItem<any>(all[i]);
      if (!e) continue;
      if (
        e.type === 'WINNER_CHARGED' &&
        String(e.email || '').toLowerCase() === email &&
        e.variant === variant &&
        (!size || e.size === size)
      ) {
        await redis.lset(ARCHIVE_LEDGER_KEY, i, JSON.stringify({ ...e, shippingStatus }));
        updated++;
      }
    }

    return NextResponse.json({ success: true, updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}