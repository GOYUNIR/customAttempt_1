import { NextResponse } from 'next/server';
import {
  createRedisClient,
  findPoolEntriesByEmail,
  removeListEntryAtIndex,
  archiveEntry,
  poolStatField,
  POOL_STATS_KEY,
  emailBlockKey,
  cardBlockKey,
} from '@/lib/server-config';
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

    if (!email || last4.length !== 4 || !variant || !size) {
      return NextResponse.json({ error: 'Missing verification details.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const target = matches.find((m) => m.variant === variant && m.size === size && String(m.parsed.cardLast4 || '') === last4);

    if (!target) {
      return NextResponse.json({ error: 'No matching entry found to cancel.' }, { status: 404 });
    }

    await removeListEntryAtIndex(redis, target.poolKey, target.index);
    await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), -1);

    // Freeing the email/card slot means this person CAN re-enter later if
    // they change their mind before the next draw.
    await redis.srem(emailBlockKey(variant, size), email);
    if (target.parsed.cardFingerprint) {
      await redis.srem(cardBlockKey(variant, size), target.parsed.cardFingerprint);
    }

    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress: target.parsed.shippingAddress || target.parsed.address || 'Unknown',
      id: target.parsed.customerId || target.parsed.stripeCustomerId || 'n/a',
      registeredAt: new Date().toISOString(),
      type: 'CANCELLED_BY_USER',
    });

    return NextResponse.json({ success: true, message: 'Your entry has been cancelled.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}