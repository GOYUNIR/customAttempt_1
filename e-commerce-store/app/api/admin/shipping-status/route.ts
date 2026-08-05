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
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
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
        
        // Send email notification for shipping updates
        try {
          let notificationType = 'shipping';
          let message = `Status updated to: ${shippingStatus.replace(/_/g, ' ')}`;
          if (trackingNumber) {
            message += `\nTracking Number: ${trackingNumber}`;
          }
          if (shippingStatus === 'DELIVERED') {
            notificationType = 'delivered';
            message = 'Your order has been delivered!';
            if (trackingNumber) {
              message += `\nTracking Number: ${trackingNumber}`;
            }
          }
          
          await sendAccountUpdateEmail({
            to: email,
            product: variant,
            size: size || undefined,
            changeType: notificationType === 'delivered' ? 'shipping' : 'shipping',
            newAddress: message,
          });
        } catch (e) {
          console.error('[shipping-status] email failed', e);
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

    return NextResponse.json({ 
      success: true, 
      updated,
      message: `Updated ${updated} record(s) to ${shippingStatus}`
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const email = url.searchParams.get('email')?.toLowerCase() || '';
    const variant = url.searchParams.get('variant') || '';
    const size = url.searchParams.get('size') || '';

    if (!email || !variant) {
      return NextResponse.json({ error: 'Missing email or variant' }, { status: 400 });
    }

    const all = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    const entries = all
      .map((item) => safeParseRedisItem<any>(item))
      .filter((e) => 
        e && 
        e.type === 'WINNER_CHARGED' &&
        String(e.email || '').toLowerCase() === email &&
        e.variant === variant &&
        (!size || e.size === size)
      )
      .sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());

    const latest = entries[0] || null;

    return NextResponse.json({
      shippingStatus: latest?.shippingStatus || 'PENDING_FULFILLMENT',
      trackingNumber: latest?.trackingNumber || null,
      entries: entries.slice(0, 10),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}