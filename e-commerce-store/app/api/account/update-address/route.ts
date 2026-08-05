import { NextResponse } from 'next/server';
import {
  createRedisClient,
  findPoolEntriesByEmail,
  safeParseRedisItem,
  archiveEntry,
  ARCHIVE_LEDGER_KEY,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { sendAccountUpdateEmail } from '@/lib/email';

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
    const target = matches.find(
      (m) => m.variant === variant && m.size === size && String(m.parsed.cardLast4 || '') === last4,
    );
    if (!target) return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });

    const updated = { ...target.parsed, shippingAddress: newAddress, address: newAddress };
    await redis.lset(target.poolKey, target.index, JSON.stringify(updated));

    try {
      const allRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (let i = 0; i < allRaw.length; i++) {
        const entry = safeParseRedisItem<any>(allRaw[i]);
        if (!entry) continue;
        if (
          String(entry.email || '').toLowerCase() === email &&
          String(entry.variant || '') === variant &&
          String(entry.size || '') === size
        ) {
          await redis.lset(ARCHIVE_LEDGER_KEY, i, JSON.stringify({ ...entry, shippingAddress: newAddress }));
        }
      }
    } catch {}

    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress: newAddress,
      id: String(target.parsed.customerId || target.parsed.stripeCustomerId || 'n/a'),
      registeredAt: new Date().toISOString(),
      type: 'ADDRESS_UPDATED',
    });

    try {
      await sendAccountUpdateEmail({ to: email, product: variant, size, changeType: 'address', newAddress });
    } catch (e) {
      console.error('[update-address] confirmation email failed', e);
    }

    return NextResponse.json({ success: true, message: 'Shipping address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}