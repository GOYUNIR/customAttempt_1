import { NextResponse } from 'next/server';
import { createRedisClient, findPoolEntriesByEmail, removeListEntryAtIndex, archiveEntry, poolStatField, POOL_STATS_KEY, emailBlockKey, cardBlockKey, ArchiveRecord } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { sendAccountUpdateEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });
    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();
    if (!email || last4.length !== 4 || !variant || !size) return NextResponse.json({ error: 'Missing verification details.' }, { status: 400 });

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const target = matches.find((m) => m.variant === variant && m.size === size && String(m.parsed.cardLast4 || '') === last4);
    if (!target) return NextResponse.json({ error: 'No matching entry found to cancel.' }, { status: 404 });

    // Get the promo code before removing
    const promoCode = target.parsed.promoCode || null;

    await removeListEntryAtIndex(redis, target.poolKey, target.index);
    await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), -1);
    await redis.srem(emailBlockKey(variant, size), email);
    if (target.parsed.cardFingerprint) await redis.srem(cardBlockKey(variant, size), target.parsed.cardFingerprint);

    // Release the promo code if it was used
    if (promoCode) {
      try {
        await redis.srem(usedEmailsKey(promoCode), email);
        const raw = await redis.hget(PROMOS_KEY, promoCode);
        const promo = JSON.parse(typeof raw === 'string' ? raw : 'null');
        if (promo && promo.uses > 0) {
          promo.uses = Math.max(0, promo.uses - 1);
          await redis.hset(PROMOS_KEY, { [promoCode]: JSON.stringify(promo) });
        }
      } catch {}
    }

    const archiveRecord: ArchiveRecord = {
      email,
      variant,
      size,
      shippingAddress: target.parsed.shippingAddress || target.parsed.address || 'Unknown',
      id: target.parsed.customerId || 'n/a',
      registeredAt: new Date().toISOString(),
      type: 'CANCELLED_BY_USER',
      promoCode: promoCode || undefined,
    };
    await archiveEntry(redis, archiveRecord);
    
    // Send cancellation email
    try {
      await sendAccountUpdateEmail({
        to: email,
        product: variant,
        size: size,
        changeType: 'cancelled',
        newAddress: promoCode ? `Promo ${promoCode} released` : undefined,
      });
    } catch (e) {
      console.error('[cancel] email failed', e);
    }
    
    return NextResponse.json({ success: true, message: 'Your entry has been cancelled.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}