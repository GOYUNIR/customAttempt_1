import { NextResponse } from 'next/server';
import { createRedisClient, loadProducts, archiveEntry, getLiveProductState, saveLiveState, safeParseRedisItem, verifyAdminPassword, POOL_STATS_KEY, poolStatField, LAST_DRAW_KEY, resolveStripePriceId, DRAW_HISTORY_KEY, POOL_KEY_PREFIX, intentPoolKey, waitlistPoolKey, STORE_CONFIG_KEY, USERS_KEY } from '@/lib/server-config';
import { resolveStripeClient } from '@/services/payment/factory';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { isConfiguredPrice } from '@/lib/storefront-config';
import { sendWinnerEmail } from '@/lib/email';
import { appendAudit } from '@/app/api/admin/audit/route';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';

export const dynamic = 'force-dynamic';

function siteUrlFromEnv() {
  return getSiteUrl() || fallbackSiteUrl();
}

/** Read the admin-configured order-ref prefix (`store:config.refPrefix`,
 * fallback 'GU') so refs built here match what the admin portal shows. */
async function getRefPrefix(redis: any): Promise<string> {
  try {
    const rawCfg = await redis.get(STORE_CONFIG_KEY);
    const cfg = safeParseRedisItem<any>(rawCfg) || {};
    return normalizeRefPrefix(cfg?.refPrefix || 'GU');
  } catch {
    return 'GU';
  }
}

/** Look up whether an email has a store account and its current rewards balance
 * (same store:users scan the checkout routes use) so winner emails always
 * reflect the CURRENT account state, never a stale guest snapshot. */
async function lookupUserRewards(redis: any, email: string): Promise<{ hasAccount: boolean; rewardsBalance: number }> {
  try {
    if (!email) return { hasAccount: false, rewardsBalance: 0 };
    const raw = await redis.hgetall(USERS_KEY);
    if (!raw) return { hasAccount: false, rewardsBalance: 0 };
    for (const [, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) {
        return { hasAccount: true, rewardsBalance: Math.max(0, Number(u.rewards || 0)) };
      }
    }
    return { hasAccount: false, rewardsBalance: 0 };
  } catch {
    return { hasAccount: false, rewardsBalance: 0 };
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = await resolveStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System offline' }, { status: 500 });
    }

    const refPrefix = await getRefPrefix(redis);

    const body = await request.json();
    const targetPool = body.targetPool || 'ALL_POOLS';
    const password = body.verificationKey || body.password || '';
    if (!verifyAdminPassword(password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    let poolKeys = await redis.keys(`${POOL_KEY_PREFIX}*`);
    if (targetPool !== 'ALL_POOLS') {
      poolKeys = poolKeys.filter(k => k === targetPool);
    }

        const allProducts = await loadProducts(redis);
    const results: any[] = [];
    let totalCharged = 0;
    let totalRevenueCents = 0;

    for (const poolKey of poolKeys) {
      const parts = poolKey.split(':');
      const productName = parts[2];
      const size = parts.slice(3).join(':') || 'Standard';

      const product = Object.values(allProducts).find((p: any) => p.name === productName);
      if (!product) continue;

      const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
      if (!priceCat || !isConfiguredPrice(priceCat.price)) continue;
      const basePriceCents = Math.round(priceCat.price * 100);
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
        const orderRef = formatOrderRef(String(entry.orderRef || ''), refPrefix) || buildOrderRef(entry.email, product.name, size, refPrefix);
        // Apply the promo stored on the entry at signup time ("X% off if
        // selected") so admin-triggered draws never charge winners full price.
        const entryDiscount = Math.min(50, Math.max(0, Number(entry.discountPercent) || 0));
        const priceCents = entryDiscount > 0
          ? Math.max(50, Math.round(basePriceCents * (1 - entryDiscount / 100)))
          : basePriceCents;

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

          // Notify the winner. This is the primary channel for telling
          // customers they won — without it, an admin-triggered draw is silent.
          try {
            const userRewards = await lookupUserRewards(redis, entry.email);
            await sendWinnerEmail({
              to: entry.email,
              product: product.name,
              size,
              amountLabel: `$${(priceCents / 100).toFixed(2)}`,
              promoCode: entry.promoCode || undefined,
              originalPrice: `$${(basePriceCents / 100).toFixed(2)}`,
              discountPercent: entryDiscount > 0 ? entryDiscount : undefined,
              shippingAddress: entry.shippingAddress || entry.address || undefined,
              orderRef,
              siteUrl: siteUrlFromEnv(),
              hasAccount: userRewards.hasAccount || undefined,
              rewardsBalance: userRewards.hasAccount ? userRewards.rewardsBalance : undefined,
            });
          } catch (emailErr) {
            console.error('[trigger-drop] winner email failed', emailErr);
          }
        } catch (err: any) {
          declinedEntries.push(winnerStr);
          await archiveEntry(redis, { ...entry, type: 'WINNER_DECLINED' });
          results.push({ email: entry.email, status: 'declined', error: err.message, product: productName, size });
        }
      }

      const waitlistKey = waitlistPoolKey(product.name, size);
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
              amount: basePriceCents,
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
            totalRevenueCents += basePriceCents;
            await archiveEntry(redis, { ...entry, type: 'WAITLIST_CHARGED', amountCents: basePriceCents, shippingStatus: 'PENDING_FULFILLMENT' });
            results.push({ email: entry.email, status: 'charged', amount: basePriceCents / 100, product: productName, size, amountCents: basePriceCents });
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
        const intentList = await redis.lrange(intentPoolKey(productName, size), 0, -1);
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

    try {
      await appendAudit(redis, {
        action: 'DRAW_TRIGGERED',
        detail: `${targetPool} · ${totalCharged} charged · $${(totalRevenueCents / 100).toFixed(2)}`,
        actor: 'admin',
      });
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