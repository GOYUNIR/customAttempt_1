import { NextResponse } from 'next/server';
import { createRedisClient, ARCHIVE_LEDGER_KEY, safeParseRedisItem } from '@/lib/server-config';
import { sendAccountUpdateEmail } from '@/lib/email';

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
    const trackingNumber = String(body?.trackingNumber || '').trim();
    
    if (!email || !variant || !ALLOWED.includes(shippingStatus)) {
      return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
    }

    const all = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    let updated = 0;
    let updatedEntry: any = null;
    
    for (let i = 0; i < all.length; i++) {
      const e = safeParseRedisItem<any>(all[i]);
      if (!e) continue;
      if (
        e.type === 'WINNER_CHARGED' &&
        String(e.email || '').toLowerCase() === email &&
        e.variant === variant &&
        (!size || e.size === size)
      ) {
        const updatedEntryData = { 
          ...e, 
          shippingStatus,
          ...(trackingNumber ? { trackingNumber } : {}),
        };
        await redis.lset(ARCHIVE_LEDGER_KEY, i, JSON.stringify(updatedEntryData));
        updated++;
        updatedEntry = updatedEntryData;
        
        // If status is DELIVERED, send final delivery email
        if (shippingStatus === 'DELIVERED') {
          try {
            await sendAccountUpdateEmail({
              to: email,
              product: variant,
              size: size || undefined,
              changeType: 'shipping',
              newAddress: `Delivered!${trackingNumber ? ` Tracking: ${trackingNumber}` : ''}`,
            });
          } catch (e) {
            console.error('[shipping] delivery email failed', e);
          }
        }
      }
    }

    // Also update the live pool entry if it exists
    try {
      const poolKey = `drop_pool:${variant}:${size}`;
      const items = await redis.lrange(poolKey, 0, -1);
      for (let i = 0; i < items.length; i++) {
        const parsed = safeParseRedisItem<any>(items[i]);
        if (parsed && String(parsed.email || '').toLowerCase() === email) {
          const updated = { ...parsed, shippingStatus, trackingNumber: trackingNumber || parsed.trackingNumber };
          await redis.lset(poolKey, i, JSON.stringify(updated));
          break;
        }
      }
    } catch {}

    return NextResponse.json({ success: true, updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}