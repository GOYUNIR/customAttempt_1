import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
  ARCHIVE_LEDGER_KEY,
  safeParseRedisItem,
  getProductOverride,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getProductPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

const TERMINAL_TYPES = ['WINNER_CHARGED', 'WINNER_DECLINED', 'NOT_SELECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN'];

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

    const statusByKey: Record<
      string,
      {
        type: string;
        shippingStatus?: string;
        amountCents?: number;
        registeredAt: string;
        promoCode?: string;
        discountPercent?: number;
        shippingAddress?: string;
      }
    > = {};
    try {
      const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (const raw of ledger) {
        const e = safeParseRedisItem<any>(raw);
        if (!e) continue;
        if (String(e.email || '').toLowerCase() !== email) continue;
        const key = `${e.variant}|${e.size}`;
        const existing = statusByKey[key];
        if (!existing || new Date(e.registeredAt).getTime() >= new Date(existing.registeredAt).getTime()) {
          statusByKey[key] = {
            type: e.type,
            shippingStatus: e.shippingStatus,
            amountCents: e.amountCents,
            registeredAt: e.registeredAt,
            promoCode: e.promoCode,
            discountPercent: e.discountPercent,
            shippingAddress: e.shippingAddress || e.address,
          };
        }
      }
    } catch {}

    const entries: any[] = [];

    for (const m of poolMatches) {
      const cardLast4 = String(m.parsed.cardLast4 || '');
      if (cardLast4 && cardLast4 !== last4) continue;
      const key = `${m.variant}|${m.size}`;
      const settled = statusByKey[key];
      const product = GOYUNIR_STORE_SUITE.productCatalog.find(
        (p) => p.name === m.variant || p.id === m.variant,
      );
      let listPrice: number | undefined;
      if (product) {
        try {
          const override = await getProductOverride(redis, product.id);
          const ov =
            m.size === '100ml' ? override?.price100ml : override?.price50ml;
          listPrice = typeof ov === 'number' ? ov : getProductPrice(product, m.size);
        } catch {
          listPrice = getProductPrice(product, m.size);
        }
      }

      const promoCode = m.parsed.promoCode || settled?.promoCode || undefined;
      const discountPercent =
        Number(m.parsed.discountPercent) ||
        Number(settled?.discountPercent) ||
        0;
      const expectedCents =
        typeof listPrice === 'number'
          ? Math.max(
              50,
              Math.round(
                listPrice * 100 * (1 - Math.min(50, Math.max(0, discountPercent)) / 100),
              ),
            )
          : undefined;

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
        promoCode,
        discountPercent: discountPercent || undefined,
        listPrice,
        expectedAmountCents: expectedCents,
      });
    }

    for (const [key, s] of Object.entries(statusByKey)) {
      if (!TERMINAL_TYPES.includes(s.type)) continue;
      const [variant, size] = key.split('|');
      const alreadyListed = entries.some((e) => e.variant === variant && e.size === size);
      if (alreadyListed) continue;

      const product = GOYUNIR_STORE_SUITE.productCatalog.find(
        (p) => p.name === variant || p.id === variant,
      );
      const listPrice = product ? getProductPrice(product, size) : undefined;

      entries.push({
        variant,
        size,
        shippingAddress: s.shippingAddress || '',
        registeredAt: s.registeredAt,
        source: 'ledger',
        cardLast4: last4,
        status: s.type,
        shippingStatus: s.shippingStatus,
        amountCents: s.amountCents,
        promoCode: s.promoCode,
        discountPercent: s.discountPercent,
        listPrice,
        expectedAmountCents: s.amountCents,
      });
    }

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
            status: 'ENTERED',
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