import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  resolveCustomerId,
  getGlobalScheduleOverride,
  LAST_DRAW_KEY,
  POOL_STATS_KEY,
  poolStatField,
  emailBlockKey,
  cardBlockKey,
  getOrSeedLiveState,
  saveLiveState,
  archiveProductToCatalog,
  getProductOverride,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getProductPrice, getWinnerCount, shouldRunDraw } from '@/lib/storefront-config';
import { sendWinnerEmail, sendPromoterPayoutEmail } from '@/lib/email';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROMOS_KEY = 'config:promos';

function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!secret) return false;
  const auth = request.headers.get('authorization');
  const key = url.searchParams.get('key') || '';
  if (request.headers.get('x-vercel-cron') === '1') return true;
  if (auth === `Bearer ${secret}`) return true;
  if (key === secret) return true;
  return false;
}

async function runAutoDraw(request: Request) {
  try {
    if (!authorized(request)) {
      const url = new URL(request.url);
      if (url.searchParams.get('ping') === '1') {
        return NextResponse.json({
          ok: false,
          message: 'Draw runs via QStash cron with CRON_SECRET — not from the browser.',
        });
      }
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) return NextResponse.json({ error: 'System offline.' }, { status: 500 });

    let targetPoolSignature = 'ALL_POOLS';
    try {
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        targetPoolSignature = body.targetPool || 'ALL_POOLS';
      }
    } catch {}

    const processedWinners: any[] = [];
    let grandRevenueChargesCount = 0;
        let allPoolKeys = await redis.keys('*drop_pool*');
    if (targetPoolSignature !== 'ALL_POOLS') {
      allPoolKeys = allPoolKeys.filter((k: string) => k === targetPoolSignature);
    }
    if (!allPoolKeys?.length) {
      return NextResponse.json({ success: true, drawSummary: { totalSuccessfulCharges: 0, processedWinners: [] } });
    }

    for (const poolKey of allPoolKeys) {
      try {
        const listLength = await redis.llen(poolKey);
        const keyParts = poolKey.split(':');
        const productName = String(keyParts[1] || '');
        const productSize = String(keyParts[2] || '50ml');
        const productDefinition = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.name === productName);
        if (!productDefinition || listLength === 0) continue;

        const force = new URL(request.url).searchParams.get('force') === '1';
        const scheduleOverride = await getGlobalScheduleOverride(redis);
        const effectiveSchedule = { ...GOYUNIR_STORE_SUITE.dropSchedule, ...(scheduleOverride || {}) };
        const lastAuto = Number((await redis.get(`draw:last_auto:${productName}:${productSize}`)) || 0);
        if (!force && !shouldRunDraw(effectiveSchedule, lastAuto, Date.now())) continue;

        // Live price override (from /admin) takes priority over the static
        // config price. Prices now live in the product's `priceCategories`
        // (managed in the admin portal), so resolve the unit price from there
        // and fall back to the legacy override/config fields only if needed.
        const override = await getProductOverride(redis, productDefinition.id);
        const priceCat = (productDefinition.priceCategories || []).find(
          (c: any) => String(c?.size || '') === productSize,
        );
        const categoryPriceCents = priceCat && Number(priceCat.price) > 0
          ? Math.round(Number(priceCat.price) * 100)
          : 0;
        const overridePrice = productSize === '100ml' ? override?.price100ml : override?.price50ml;
        const legacyPriceCents = Math.round((overridePrice ?? getProductPrice(productDefinition, productSize)) * 100);
        const basePriceCents = legacyPriceCents > 0 ? legacyPriceCents : categoryPriceCents;
        if (!basePriceCents || basePriceCents <= 0) continue;

        const winnersPerDraw = getWinnerCount(GOYUNIR_STORE_SUITE, productSize);
        const live = await getOrSeedLiveState(redis, productDefinition, productSize, winnersPerDraw);
        if (live.inventoryRemaining <= 0) continue;

        const entries = await redis.lrange(poolKey, 0, -1);
        const shuffled = [...entries];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const rawWinners = live.winnersPerDraw ?? winnersPerDraw;
        const winnersThisDraw = Array.isArray(rawWinners)
          ? Math.max(1, Number(rawWinners[Math.min(live.drawsCompleted || 0, rawWinners.length - 1)]) || 1)
          : Math.max(1, Number(rawWinners) || 1);
        const inventoryLimit = Math.min(winnersThisDraw, live.inventoryRemaining);
        let successfulPoolCaptures = 0;
        const remainingEntries: string[] = [];

        for (const winnerStr of shuffled) {
          const rawWinnerData = safeParseRedisItem<any>(winnerStr);
          if (!rawWinnerData) continue;
          const winnerData = rawWinnerData.email && typeof rawWinnerData.email === 'object' ? rawWinnerData.email : rawWinnerData;
          const winnerEmail = String(winnerData.email || '').toLowerCase();
          const paymentMethod = winnerData.paymentMethodId || null;
          const customerId = resolveCustomerId(winnerData) || null;
          const shippingAddress = winnerData.shippingAddress || winnerData.address || 'No Address Logged';
          const promoCode = String(winnerData.promoCode || '').trim().toUpperCase();
          const orderRef = formatOrderRef(String(winnerData.orderRef || '')) || buildOrderRef(winnerEmail, productName, productSize);

          if (successfulPoolCaptures >= inventoryLimit) {
            remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
            await archiveEntry(redis, {
              email: winnerEmail, variant: productName, size: productSize, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'NOT_SELECTED', promoCode: promoCode || undefined,
            });
            continue;
          }

          try {
            if (paymentMethod && customerId) {
              let priceCents = basePriceCents;
              let promoForCharge: any = null;

              if (promoCode) {
                try {
                  const raw = await redis.hget(PROMOS_KEY, promoCode);
                  promoForCharge = safeParseRedisItem<any>(raw);
                  if (promoForCharge && promoForCharge.active !== false) {
                    const self = promoForCharge.promoterEmail && String(promoForCharge.promoterEmail).toLowerCase() === winnerEmail;
                    if (!self) {
                      const discount = Math.min(50, Math.max(0, Number(promoForCharge.customerDiscountPercent) || 0));
                      if (discount > 0) priceCents = Math.max(50, Math.round(basePriceCents * (1 - discount / 100)));
                    } else {
                      promoForCharge = null;
                    }
                  } else {
                    promoForCharge = null;
                  }
                } catch {
                  promoForCharge = null;
                }
              }

              await stripe.paymentIntents.create({
                amount: priceCents, currency: 'usd', customer: customerId, payment_method: paymentMethod,
                off_session: true, confirm: true, receipt_email: winnerEmail,
                description: `GOYUNIR: ${productName} (${productSize})`,
              });

              grandRevenueChargesCount++;
              successfulPoolCaptures++;
              live.inventoryRemaining = Math.max(0, live.inventoryRemaining - 1);
              live.salesCompleted = (live.salesCompleted || 0) + 1;

              let payoutAmountCents = 0;
              if (promoForCharge && promoCode) {
                try {
                  const payoutPct = Math.min(50, Math.max(0, Number(promoForCharge.promoterPayoutPercent) || 0));
                  payoutAmountCents = Math.round((priceCents * payoutPct) / 100);
                  promoForCharge.revenueAttributed = (Number(promoForCharge.revenueAttributed) || 0) + priceCents / 100;
                  promoForCharge.payoutOwedCents = (Number(promoForCharge.payoutOwedCents) || 0) + payoutAmountCents;
                  await redis.hset(PROMOS_KEY, { [promoCode]: JSON.stringify(promoForCharge) });

                  if (promoForCharge.promoterEmail) {
                    await sendPromoterPayoutEmail({
                      to: promoForCharge.promoterEmail,
                      promoterName: promoForCharge.promoterName || promoCode,
                      code: promoCode,
                      orderAmountLabel: `$${(priceCents / 100).toFixed(2)}`,
                      payoutAmountLabel: `$${(payoutAmountCents / 100).toFixed(2)}`,
                      payoutPercent: promoForCharge.promoterPayoutPercent,
                      product: productName,
                      size: productSize,
                    });
                  }
                } catch {}
              }

              await archiveEntry(redis, {
                email: winnerEmail, variant: productName, size: productSize, shippingAddress,
                id: customerId, registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
                shippingStatus: 'PENDING_FULFILLMENT', promoCode: promoCode || undefined, amountCents: priceCents, orderRef,
              });

              await sendWinnerEmail({ to: winnerEmail, product: productName, size: productSize, amountLabel: `$${(priceCents / 100).toFixed(0)}`, orderRef });

              processedWinners.push({
                email: winnerEmail, product: productName, size: productSize, shippingAddress,
                status: 'SUCCESS_CHARGED', shippingStatus: 'PENDING_FULFILLMENT',
                amountCents: priceCents, promoCode: promoCode || undefined,
              });
            } else {
              remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
              await archiveEntry(redis, {
                email: winnerEmail, variant: productName, size: productSize, shippingAddress,
                id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED', promoCode: promoCode || undefined,
              });
              processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: 'MISSING_PAYMENT_METHOD', orderRef });
            }
          } catch (err: any) {
            remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
            processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: `DECLINED: ${err.message}`, orderRef });
            await archiveEntry(redis, {
              email: winnerEmail, variant: productName, size: productSize, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED', promoCode: promoCode || undefined,
            });
          }
        }

        live.drawsCompleted = (live.drawsCompleted || 0) + 1;
        await saveLiveState(redis, live);

        await redis.del(poolKey);
        for (const entry of remainingEntries) await redis.rpush(poolKey, entry);

        await redis.del(emailBlockKey(productName, productSize));
        await redis.del(cardBlockKey(productName, productSize));
        for (const entry of remainingEntries) {
          const parsed = safeParseRedisItem<any>(entry);
          if (!parsed) continue;
          const em = String(parsed.email || '').toLowerCase();
          if (em) await redis.sadd(emailBlockKey(productName, productSize), em);
          if (parsed.cardFingerprint) await redis.sadd(cardBlockKey(productName, productSize), String(parsed.cardFingerprint));
        }

        const intentKey = `intent_pool:${productName}:${productSize}`;
        try {
          const remainingIntents = await redis.lrange(intentKey, 0, -1);
          for (const item of remainingIntents) {
            const parsed = safeParseRedisItem<any>(item);
            if (parsed) {
              await archiveEntry(redis, {
                email: String(parsed.email || 'Unknown'), variant: productName, size: productSize,
                shippingAddress: String(parsed.shippingAddress || parsed.address || 'Unknown'),
                id: 'n/a', registeredAt: new Date().toISOString(), type: 'INTENT_EXPIRED',
              });
            }
          }
        } catch {}
        await redis.del(intentKey);

        await redis.hset(POOL_STATS_KEY, {
          [poolStatField('sub', productName, productSize)]: String(remainingEntries.length),
          [poolStatField('int', productName, productSize)]: '0',
        });

        await redis.set(`draw:last_auto:${productName}:${productSize}`, String(Date.now()));

        if (live.inventoryRemaining <= 0) {
          await archiveProductToCatalog(redis, {
            productId: productDefinition.id,
            name: productDefinition.name,
            image: productDefinition.catalogImage || `/images/${productDefinition.prefix}/1.jpeg`,
            description: productDefinition.desc,
            availableFrom: 'Sold out',
            archivedAt: new Date().toISOString(),
            notes: 'Sold out — all inventory allocated.',
            soldOut: true,
          });
        }
      } catch {}
    }

    const drawSummary = { executionTime: new Date().toLocaleString(), processedWinners, totalSuccessfulCharges: grandRevenueChargesCount };
    try {
      await redis.set(LAST_DRAW_KEY, JSON.stringify(drawSummary));
    } catch {}

    return NextResponse.json({ success: true, drawSummary });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runAutoDraw(request);
}

export async function POST(request: Request) {
  return runAutoDraw(request);
}
