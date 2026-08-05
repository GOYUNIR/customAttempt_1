import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  ARCHIVE_LEDGER_KEY,
  findPoolEntriesByEmail,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { sendAccountUpdateEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

function siteUrl(request: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  if (env) return env.replace(/\/$/, '');
  try {
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Offline' }, { status: 500 });

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '');
    const size = String(body?.size || '50ml');
    const newAddress = String(body?.newAddress || '').trim();

    if (!email || last4.length !== 4 || !newAddress) {
      return NextResponse.json({ error: 'Email, last 4, and new address required.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const target = matches.find(
      (m) =>
        m.variant === variant &&
        m.size === size &&
        (!m.parsed.cardLast4 || String(m.parsed.cardLast4) === last4),
    );

    if (!target) {
      return NextResponse.json({ error: 'Active entry not found.' }, { status: 404 });
    }

    const updated = {
      ...target.parsed,
      shippingAddress: newAddress,
      address: newAddress,
    };

    const poolKey = `drop_pool:${variant}:${size}`;
    const all = await redis.lrange(poolKey, 0, -1);
    for (let i = 0; i < all.length; i++) {
      const row = safeParseRedisItem<any>(all[i]);
      if (!row) continue;
      if (String(row.email || '').toLowerCase() !== email) continue;
      await redis.lset(poolKey, i, JSON.stringify(updated));
      break;
    }

    try {
      const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (let i = 0; i < ledger.length; i++) {
        const entry = safeParseRedisItem<any>(ledger[i]);
        if (!entry) continue;
        if (String(entry.email || '').toLowerCase() !== email) continue;
        if (entry.variant !== variant || entry.size !== size) continue;
        await redis.lset(
          ARCHIVE_LEDGER_KEY,
          i,
          JSON.stringify({ ...entry, shippingAddress: newAddress }),
        );
      }
    } catch {}

    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress: newAddress,
      id: target.parsed.customerId || 'n/a',
      registeredAt: new Date().toISOString(),
      type: 'ADDRESS_UPDATED',
    } as any);

    try {
      await sendAccountUpdateEmail({
        to: email,
        kind: 'address',
        product: variant,
        size,
        detail: newAddress,
        siteUrl: siteUrl(request),
      });
    } catch (e) {
      console.error('[update-address] email', e);
    }

    return NextResponse.json({ success: true, message: 'Shipping address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}