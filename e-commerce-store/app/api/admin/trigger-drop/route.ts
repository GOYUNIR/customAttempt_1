import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts, archiveEntry, getLiveProductState, saveLiveState, safeParseRedisItem, getAdminPassword, POOL_STATS_KEY, poolStatField, LAST_DRAW_KEY, resolveStripePriceId } from '@/lib/server-config';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';
import { isConfiguredPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

const DRAW_HISTORY_KEY = 'admin:draw_history';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System offline' }, { status: 500 });
    }

    const body = await request.json();
    const targetPool = body.targetPool || 'ALL_POOLS';
    const password = body.verificationKey || body.password || '';
    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    let poolKeys = await redis.keys('drop_pool:*');
    if (targetPool !== 'ALL_POOLS') {
      poolKeys = poolKeys.filter(k => k === targetPool);
    }

        const allProducts = await loadProducts(redis);
    const results: any[] = [];
    let totalCharged = 0;
    let totalRevenueCents = 0;

    for (const poolKey of poolKeys) {
      const parts = poolKey.split(':');
      const productName = parts[1];
      const size = parts.slice(2).join(':') || 'Standard';

      const product = Object.values(allProducts).find((p: any) => p.name === productName);
      if (!product) continue;

      const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
      if (!priceCat || !isConfiguredPrice(priceCat.price)) continue;
      const priceCents = Math.round(priceCat.price * 100);
      const stripePriceId = resolveStripePriceId(priceCat.stripeId);
      if (!stripePriceId) continue;

      const entries = await redis.lrange(poolKey, 0, -1);
      if (entries.length === 0) continue;

      const shuffled = entries.sort(() => Math.random() - 0.5);
      const live = await getLiveProductState(redis, product, size);
      if (!live || live.inventoryRemaining <= 0) continue;

      const liveWinnerCount = Math.max(1, Number(live.winnersPerDraw || 1));
      const winnerCount = Math.min(liveWinnerCount, live.inventoryRemaining, shuffled.length);
      const winners = shuffled.slice(0, winnerCount);

      // Winners whose card can't be charged are NOT removed from the pool —
      // they keep their slot and enter the next draw, matching the auto-draw
      // cron behavior so a declined charge never silently loses an entry.
      const declinedEntries: string[] = [];

      for (const winnerStr of winners) {
        const entry = safeParseRedisItem<any>(winnerStr);
        if (!entry) continue;
        const customerId = entry.customerId || entry.stripeCustomerId;
        const paymentMethodId = entry.paymentMethodId;
        const orderRef = formatOrderRef(String(entry.orderRef || '')) || buildOrderRef(entry.email, product.name, size);

        if (!customerId || !paymentMethodId) {
          declinedEntries.push(winnerStr);
          await archiveEntry(redis, { ...entry, type: 'WINNER_DECLINED' });
          results.push({ email: entry.email, status: 'declined (no payment method)', product: productName, size });
          continue;
        }

        try {
          await stripe.paymentIntents.create({
            amount: priceCents,
            currency: 'usd',
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
            receipt_email: entry.email,
            description: `${product.name} (${size})`,
          });

          live.inventoryRemaining -= 1;
          live.salesCompleted = (live.salesCompleted || 0) + 1;
          totalCharged++;
          totalRevenueCents += priceCents;

          await archiveEntry(redis, {
            ...entry,
            type: 'WINNER_CHARGED',
            amountCents: priceCents,
            orderRef,
            shippingStatus: 'PENDING_FULFILLMENT',
          });
          results.push({ email: entry.email, status: 'charged', amount: priceCents / 100, orderRef, product: productName, size, amountCents: priceCents });
        } catch (err: any) {
          declinedEntries.push(winnerStr);
          await archiveEntry(redis, { ...entry, type: 'WINNER_DECLINED' });
          results.push({ email: entry.email, status: 'declined', error: err.message, product: productName, size });
        }
      }

      const waitlistKey = `waitlist:${product.name}:${size}`;
      const waitlistEntries = await redis.lrange(waitlistKey, 0, -1);
      if (waitlistEntries.length > 0 && !product.isRaffle) {
        const available = Math.max(0, live.inventoryRemaining);
        const pendingWaitlist = waitlistEntries.slice(0, available);
        for (const waitlistStr of pendingWaitlist) {
          const entry = safeParseRedisItem<any>(waitlistStr);
          if (!entry) continue;
          const customerId = entry.customerId || entry.stripeCustomerId;
          const paymentMethodId = entry.paymentMethodId;
          if (!customerId || !paymentMethodId) continue;
          try {
            await stripe.paymentIntents.create({
              amount: priceCents,
              currency: 'usd',
              customer: customerId,
              payment_method: paymentMethodId,
              off_session: true,
              confirm: true,
              receipt_email: entry.email,
                            description: `${product.name} (${size})`,
            });
            live.inventoryRemaining -= 1;
            live.salesCompleted = (live.salesCompleted || 0) + 1;
            totalCharged++;
            totalRevenueCents += priceCents;
            await archiveEntry(redis, { ...entry, type: 'WAITLIST_CHARGED', amountCents: priceCents, shippingStatus: 'PENDING_FULFILLMENT' });
            results.push({ email: entry.email, status: 'charged', amount: priceCents / 100, product: productName, size, amountCents: priceCents });
          } catch (err: any) {
            await archiveEntry(redis, { ...entry, type: 'WAITLIST_DECLINED' });
            results.push({ email: entry.email, status: 'declined', error: err.message, product: productName, size });
          }
        }
        const remainingWaitlist = waitlistEntries.slice(pendingWaitlist.length);
        await redis.del(waitlistKey);
        for (const item of remainingWaitlist) await redis.rpush(waitlistKey, item);
      }

      // Remove winners from pool, keep the rest (including declared winners,
      // who keep their entry for the next draw).
      const remaining = [...shuffled.slice(winnerCount), ...declinedEntries];
      await redis.del(poolKey);
      for (const item of remaining) {
        await redis.rpush(poolKey, item);
      }
      await saveLiveState(redis, live);

      // Recompute pool stats so the Overview no longer shows stale "entered"
      // counts after the draw (the old code never reset POOL_STATS_KEY here).
      try {
        const remainingList = await redis.lrange(poolKey, 0, -1);
        const intentList = await redis.lrange(`intent_pool:${productName}:${size}`, 0, -1);
        await redis.hset(POOL_STATS_KEY, {
          [poolStatField('sub', productName, size)]: String(remainingList.length),
          [poolStatField('int', productName, size)]: String(intentList.length),
        });
      } catch {}
    }

    // Build a summary that both the admin UI (drawSummary.processedWinners) and
    // the draw-history screen can consume.
    const processedWinners = results.map((r: any) => ({
      email: r.email,
      product: r.product,
      size: r.size,
      status: r.status === 'charged' ? 'SUCCESS_CHARGED' : r.status,
      amountCents: r.amountCents || Math.round((Number(r.amount) || 0) * 100),
      orderRef: r.orderRef,
      promoCode: r.promoCode,
    }));
    const drawSummary = {
      executionTime: new Date().toLocaleString(),
      processedWinners,
      totalSuccessfulCharges: totalCharged,
      totalRevenueCents,
    };

    try {
      await redis.rpush(DRAW_HISTORY_KEY, JSON.stringify({ ...drawSummary, timestamp: new Date().toISOString() }));
      const historyLen = await redis.llen(DRAW_HISTORY_KEY);
      if (historyLen > 100) await redis.ltrim(DRAW_HISTORY_KEY, historyLen - 100, -1);
      await redis.set(LAST_DRAW_KEY, JSON.stringify(drawSummary));
    } catch {}

    return NextResponse.json({
      success: true,
      results,
      summary: { totalCharged, totalRevenueCents },
      drawSummary,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}