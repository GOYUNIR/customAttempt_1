import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts, archiveEntry, getLiveProductState, saveLiveState } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

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
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
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
      const size = parts[2];

      const product = Object.values(allProducts).find((p: any) => p.name === productName);
      if (!product) continue;

      const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
      if (!priceCat || priceCat.price <= 0) continue;
      const priceCents = Math.round(priceCat.price * 100);
      const stripePriceId = priceCat.stripeId;
      if (!stripePriceId) continue;

      const entries = await redis.lrange(poolKey, 0, -1);
      if (entries.length === 0) continue;

      const shuffled = entries.sort(() => Math.random() - 0.5);
      const live = await getLiveProductState(redis, product, size);
      if (!live || live.inventoryRemaining <= 0) continue;

      // Determine winner count from winnerTiers (first number or 1)
      const winnerTiers = priceCat.winnerTiers ? priceCat.winnerTiers.split(',').map(Number) : [1];
      const winnerCount = Math.min(winnerTiers[0] || 1, live.inventoryRemaining);
      const winners = shuffled.slice(0, winnerCount);

      for (const winnerStr of winners) {
        const entry = JSON.parse(winnerStr);
        const customerId = entry.customerId || entry.stripeCustomerId;
        const paymentMethodId = entry.paymentMethodId;

        if (!customerId || !paymentMethodId) {
          await archiveEntry(redis, { ...entry, type: 'WINNER_DECLINED' });
          results.push({ email: entry.email, status: 'declined (no payment method)' });
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

          const orderRef = `GOY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
          await archiveEntry(redis, {
            ...entry,
            type: 'WINNER_CHARGED',
            amountCents: priceCents,
            orderRef,
            shippingStatus: 'PENDING_FULFILLMENT',
          });
          results.push({ email: entry.email, status: 'charged', amount: priceCents / 100, orderRef });
        } catch (err: any) {
          await archiveEntry(redis, { ...entry, type: 'WINNER_DECLINED' });
          results.push({ email: entry.email, status: 'declined', error: err.message });
        }
      }

      // Remove winners from pool, keep the rest
      const remaining = shuffled.slice(winnerCount);
      await redis.del(poolKey);
      for (const item of remaining) {
        await redis.rpush(poolKey, item);
      }
      await saveLiveState(redis, live);
    }

    return NextResponse.json({
      success: true,
      results,
      summary: { totalCharged, totalRevenueCents: totalRevenueCents },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}