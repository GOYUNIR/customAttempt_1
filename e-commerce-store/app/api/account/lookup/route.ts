import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
  ARCHIVE_LEDGER_KEY,
  safeParseRedisItem,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis) {
      return NextResponse.json({ error: 'Database offline.' }, { status: 500 });
    }

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    if (!email || last4.length !== 4) {
      return NextResponse.json({ error: 'Email and last 4 required.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const poolMatches = await findPoolEntriesByEmail(redis, productNames, email);

    const entries: any[] = [];

    for (const m of poolMatches) {
      const cardLast4 = String(m.parsed.cardLast4 || '');
      if (cardLast4 && cardLast4 !== last4) continue;
      entries.push({
        variant: m.variant,
        size: m.size,
        shippingAddress: m.parsed.shippingAddress || m.parsed.address || '',
        registeredAt: m.parsed.registeredAt,
        source: 'active_pool',
        cardLast4: cardLast4 || last4,
      });
    }

    // Also scan ledger for ENTERED / ADDRESS_UPDATED
    try {
      const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (const raw of ledger) {
        const e = safeParseRedisItem<any>(raw);
        if (!e) continue;
        if (String(e.email || '').toLowerCase() !== email) continue;
        if (e.type !== 'ENTERED' && e.type !== 'ADDRESS_UPDATED' && e.type !== 'WINNER_CHARGED') continue;
        const exists = entries.some((x) => x.variant === e.variant && x.size === e.size);
        if (!exists) {
          entries.push({
            variant: e.variant,
            size: e.size,
            shippingAddress: e.shippingAddress || '',
            registeredAt: e.registeredAt,
            source: 'ledger',
            cardLast4: last4,
          });
        }
      }
    } catch {}

    // Stripe fallback: customer exists even if pool write failed
    if (entries.length === 0 && stripe) {
      const customers = await stripe.customers.list({ email, limit: 3 });
      for (const c of customers.data) {
        const pms = await stripe.paymentMethods.list({ customer: c.id, type: 'card' });
        const matchPm = pms.data.find((pm) => pm.card?.last4 === last4);
        if (matchPm) {
          entries.push({
            variant: '(saved in Stripe — complete entry on site if missing)',
            size: '—',
            shippingAddress: c.metadata?.initialShippingAddress || c.address?.line1 || '',
            registeredAt: new Date(c.created * 1000).toISOString(),
            source: 'stripe_only',
            cardLast4: last4,
          });
        }
      }
    }

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });
    }

    return NextResponse.json({ entries });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}