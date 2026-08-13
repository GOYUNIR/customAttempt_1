import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
  ARCHIVE_LEDGER_KEY,
  safeParseRedisItem,
  loadProducts,
} from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';

export const dynamic = 'force-dynamic';

const TERMINAL_TYPES = ['WINNER_CHARGED', 'WINNER_DECLINED', 'NOT_SELECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN'];

// Ledger rows that are bookkeeping, not actual entries. INTENT_STARTED means the
// customer opened card setup but never finished; INTENT_EXPIRED means they never
// completed it; DUPLICATE_BLOCKED is a rejected re-entry attempt; ADMIN_NOTE is
// internal. None of these should ever show up as "entries" in the account page.
const SKIP_TYPES = ['INTENT_STARTED', 'INTENT_EXPIRED', 'DUPLICATE_BLOCKED', 'ADMIN_NOTE'];

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Login required.' }, { status: 401 });
    }

    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });

    const body = await request.json();
    const email = sessionUser.email;
    const liveProducts = await loadProducts(redis);
    const allProducts = Object.values(liveProducts) as any[];
    const productNames = allProducts.map((p) => p.name);
    const poolMatches = await findPoolEntriesByEmail(redis, productNames, email);

    // Build a map of ALL statuses from the ledger
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
        orderRef?: string;
      }
    > = {};
    try {
      const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
      for (const raw of ledger) {
        const e = safeParseRedisItem<any>(raw);
        if (!e) continue;
        if (String(e.email || '').toLowerCase() !== email) continue;
        if (SKIP_TYPES.includes(String(e.type || ''))) continue;
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
            orderRef: e.orderRef,
          };
        }
      }
    } catch {}

    const entries: any[] = [];

    // Add active pool entries
    for (const m of poolMatches) {
      const key = `${m.variant}|${m.size}`;
      const settled = statusByKey[key];
      const product = allProducts.find((p) => p.name === m.variant || p.id === m.variant);
      const listPrice = product?.priceCategories?.find((category: any) => category.size === m.size)?.price;

      const promoCode = m.parsed.promoCode || settled?.promoCode || undefined;
      const discountPercent =
        Number(m.parsed.discountPercent) ||
        Number(settled?.discountPercent) ||
        0;
      const expectedCents =
        typeof listPrice === 'number' && listPrice > 0
          ? Math.max(
              50,
              Math.round(
                listPrice * 100 * (1 - Math.min(50, Math.max(0, discountPercent)) / 100),
              ),
            )
          : undefined;

      const status = settled && TERMINAL_TYPES.includes(settled.type) ? settled.type : 'ENTERED';

      entries.push({
        variant: m.variant,
        size: m.size,
        shippingAddress: m.parsed.shippingAddress || m.parsed.address || '',
        registeredAt: m.parsed.registeredAt || settled?.registeredAt || new Date().toISOString(),
        source: 'active_pool',
        status,
        shippingStatus: settled?.shippingStatus,
        amountCents: settled?.amountCents,
        promoCode,
        discountPercent: discountPercent || undefined,
        listPrice: listPrice && listPrice > 0 ? listPrice : undefined,
        expectedAmountCents: expectedCents,
        orderRef: settled?.orderRef,
      });
    }

    // Add ledger entries
    for (const [key, s] of Object.entries(statusByKey)) {
      const [variant, size] = key.split('|');
      const alreadyListed = entries.some((e) => e.variant === variant && e.size === size);
      if (alreadyListed) continue;

      const product = allProducts.find((p) => p.name === variant || p.id === variant);
      const listPrice = product?.priceCategories?.find((category: any) => category.size === size)?.price;

      entries.push({
        variant,
        size,
        shippingAddress: s.shippingAddress || '',
        registeredAt: s.registeredAt,
        source: 'ledger',
        status: s.type,
        shippingStatus: s.shippingStatus,
        amountCents: s.amountCents,
        promoCode: s.promoCode,
        discountPercent: s.discountPercent,
        listPrice: listPrice && listPrice > 0 ? listPrice : undefined,
        expectedAmountCents: s.amountCents,
        orderRef: s.orderRef,
      });
    }

    // Sort entries by registeredAt (newest first)
    entries.sort((a, b) => {
      const dateA = new Date(a.registeredAt || 0).getTime();
      const dateB = new Date(b.registeredAt || 0).getTime();
      return dateB - dateA;
    });

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });
    }
    return NextResponse.json({ entries });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}