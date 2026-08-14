import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
  ARCHIVE_LEDGER_KEY,
  STORE_CONFIG_KEY,
  safeParseRedisItem,
  loadProducts,
} from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';

export const dynamic = 'force-dynamic';

const TERMINAL_TYPES = ['WINNER_CHARGED', 'WINNER_DECLINED', 'NOT_SELECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN'];

// Ledger rows that are bookkeeping, not actual entries. INTENT_STARTED means the
// customer opened card setup but never finished; INTENT_EXPIRED means they never
// completed it; DUPLICATE_BLOCKED is a rejected re-entry attempt; ADMIN_NOTE is
// internal; ADDRESS_UPDATED is a pure address-change audit row (the real entry
// row itself is edited in place) and must NEVER overwrite the entry's status —
// without it, changing your address on a won order would flip "Won & charged"
// into "Address updated" in Manage My Entry.
const SKIP_TYPES = ['INTENT_STARTED', 'INTENT_EXPIRED', 'DUPLICATE_BLOCKED', 'ADMIN_NOTE', 'ADDRESS_UPDATED'];

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

    // ── Account-bound promos (welcome credit + anything issued to this email) ──
    // The user record carries the welcome code; the promo records live in
    // config:promos. We surface every promo the customer can actually use so the
    // /account "Your credits & codes" section can render them with a used/available
    // badge without the admin portal.
    let userRecord: any = null;
    try {
      const rawUsers = await redis.hgetall('store:users');
      if (rawUsers) {
        for (const [k, v] of Object.entries(rawUsers)) {
          const u = safeParseRedisItem<any>(v);
          if (u && String(u.email || '').toLowerCase() === email) {
            userRecord = u;
            break;
          }
        }
      }
    } catch {}

    const welcomePromoCode =
      typeof userRecord?.welcomePromoCode === 'string' && userRecord.welcomePromoCode
        ? userRecord.welcomePromoCode
        : null;

    const promos: any[] = [];
    try {
      const rawPromos = await redis.hgetall('config:promos');
      if (rawPromos) {
        for (const [code, raw] of Object.entries(rawPromos)) {
          const p = safeParseRedisItem<any>(raw);
          if (!p) continue;
          const issuedToMe = String(p.issuedForEmail || '').toLowerCase() === email;
          const isWelcome = welcomePromoCode ? code === welcomePromoCode : false;
          if (!issuedToMe && !isWelcome) continue;

          let used = false;
          try {
            const inSet = await redis.sismember(`promo:used_emails:${code}`, email);
            const maxTotal = Number(p.maxUsesTotal || 0);
            used = inSet === 1 || (maxTotal > 0 && Number(p.uses || 0) >= maxTotal);
          } catch {}

          promos.push({
            code,
            fixedDiscountCents: Number(p.fixedDiscountCents || 0),
            customerDiscountPercent: Number(p.customerDiscountPercent || 0),
            welcome: p.welcome === true,
            active: p.active !== false,
            uses: Number(p.uses || 0),
            maxUsesTotal: Number(p.maxUsesTotal || 0),
            createdAt: p.createdAt || '',
            used,
          });
        }
      }
    } catch {}

    promos.sort(
      (a, b) =>
        (b.welcome ? 1 : 0) - (a.welcome ? 1 : 0) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    );

    // ── Rewards config (conversion rate + gifting toggle) so /account can show
    // the points→credit rate and explain gifting without hardcoding numbers.
    let rewardsConfig: { pointsPerDollar?: number; minRedeemPoints?: number; giftingEnabled?: boolean; giftDiscountPercent?: number; redemptionInfoMessage?: string } = {};
    try {
      const rawConfig = await redis.get(STORE_CONFIG_KEY);
      const config = safeParseRedisItem<any>(rawConfig) || {};
      rewardsConfig = {
        pointsPerDollar: Math.max(1, Number(config?.rewards?.pointsPerDollar) || 100),
        minRedeemPoints: Math.max(1, Number(config?.rewards?.minRedeemPoints) || 500),
        giftingEnabled: config?.rewards?.giftingEnabled !== false,
        giftDiscountPercent: Math.max(0, Number(config?.rewards?.giftDiscountPercent) || 10),
        redemptionInfoMessage: typeof config?.rewards?.redemptionInfoMessage === 'string' ? config.rewards.redemptionInfoMessage : undefined,
      };
    } catch {}

    if (entries.length === 0) {
      // 200 + empty array (not 404) — a signed-in user with no entries yet is a
      // perfectly normal state. 404 here just flooded the console with
      // "Failed to load resource: the server responded with a status of 404".
      return NextResponse.json({ entries: [], promos, welcomePromoCode, rewards: rewardsConfig });
    }
    return NextResponse.json({ entries, promos, welcomePromoCode, rewards: rewardsConfig });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}