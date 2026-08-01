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

const TERMINAL_TYPES = ['WINNER_CHARGED', 'WINNER_DECLINED', 'NOT_SELECTED', 'CANCELLED_BY_USER'];

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    if (!email || last4.length !== 4) {
      return NextResponse.json({ error: 'Email and last 4 required.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const poolMatches = await findPoolEntriesByEmail(redis, productNames, email);

    // Find each variant/size's MOST RECENT ledger status, so we know if
    // it's still an open entry or already settled (won/lost/cancelled).
    const statusByKey: Record<string, { type: string; shippingStatus?: string; amountCents?: number; registeredAt: string }> = {};
    try {
      const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (const raw of ledger) {
        const e = safeParseRedisItem<any>(raw);
        if (!e) continue;
        if (String(e.email || '').toLowerCase() !== email) continue;
        const key = `${e.variant}|${e.size}`;
        const existing = statusByKey[key];
        if (!existing || new Date(e.registeredAt).getTime() >= new Date(existing.registeredAt).getTime()) {
          statusByKey[key] = { type: e.type, shippingStatus: e.shippingStatus, amountCents: e.amountCents, registeredAt: e.registeredAt };
        }
      }
    } catch {}

    const entries: any[] = [];

    for (const m of poolMatches) {
      const cardLast4 = String(m.parsed.cardLast4 || '');
      if (cardLast4 && cardLast4 !== last4) continue;
      const key = `${m.variant}|${m.size}`;
      const settled = statusByKey[key];
      entries.push({
        variant: m.variant,
        size: m.size,
        shippingAddress: m.parsed.shippingAddress || m.parsed.address || '',
        registeredAt: m.parsed.registeredAt,
        source: 'active_pool',
        cardLast4: cardLast4 || last4,
        status: settled && TERMINAL_TYPES.includes(settled.type) ? settled.type : 'ENTERED',
        shippingStatus: settled?.shippingStatus,
        amountCents: settled?.amountCents,
      });
    }

    // Also surface settled entries that are no longer in the live pool
    // (winners get removed from the pool by trigger-drop).
    for (const [key, s] of Object.entries(statusByKey)) {
      if (!TERMINAL_TYPES.includes(s.type)) continue;
      const [variant, size] = key.split('|');
      const alreadyListed = entries.some((e) => e.variant === variant && e.size === size);
      if (alreadyListed) continue;
      entries.push({
        variant, size, shippingAddress: '', registeredAt: s.registeredAt,
        source: 'ledger', cardLast4: last4, status: s.type, shippingStatus: s.shippingStatus, amountCents: s.amountCents,
      });
    }

    if (entries.length === 0 && stripe) {
      const customers = await stripe.customers.list({ email, limit: 3 });
      for (const c of customers.data) {
        const pms = await stripe.paymentMethods.list({ customer: c.id, type: 'card' });
        const matchPm = pms.data.find((pm) => pm.card?.last4 === last4);
        if (matchPm) {
          entries.push({
            variant: '(saved in Stripe — complete entry on site if missing)', size: '—',
            shippingAddress: c.metadata?.initialShippingAddress || c.address?.line1 || '',
            registeredAt: new Date(c.created * 1000).toISOString(), source: 'stripe_only', cardLast4: last4, status: 'ENTERED',
          });
        }
      }
    }

    if (entries.length === 0) return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });
    return NextResponse.json({ entries });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}