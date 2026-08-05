import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  resolveCustomerId,
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
import { getProductPrice, getWinnerCount } from '@/lib/storefront-config';
import { sendWinnerEmail, sendPromoterPayoutEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROMOS_KEY = 'config:promos';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) return NextResponse.json({ error: 'System offline.' }, { status: 500 });

    let targetPoolSignature = 'ALL_POOLS';
    let inputPassword = '';
    try {
      const body = await request.json();
      targetPoolSignature = body.targetPool || 'ALL_POOLS';
      inputPassword = body.verificationKey || body.password || '';
    } catch {}

    const masterPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD;
    if (!masterPassword || inputPassword !== masterPassword) {
      return NextResponse.json({ error: 'Invalid password.' }, { status: 403 });
    }

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

        const override = await getProductOverride(redis, productDefinition.id);
        const overridePrice = productSize === '100ml' ? override?.price100ml : override?.price50ml;
        const basePriceCents = Math.round((overridePrice ?? getProductPrice(productDefinition, productSize)) * 100);

        const winnersPerDraw = getWinnerCount(GOYUNIR_STORE_SUITE, productSize);
        const live = await getOrSeedLiveState(redis, productDefinition, productSize, winnersPerDraw);
        if (live.inventoryRemaining <= 0) continue;

        const entries = await redis.lrange(poolKey, 0, -1);
        const shuffled = [...entries];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const inventoryLimit = Math.min(live.winnersPerDraw || winnersPerDraw, live.inventoryRemaining);
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
              const entryDiscount = Math.min(50, Math.max(0, Number(winnerData.discountPercent) || 0));
              if (entryDiscount > 0) {
                priceCents = Math.max(50, Math.round(basePriceCents * (1 - entryDiscount / 100)));
              }

              if (promoCode) {
                try {
                  const raw = await redis.hget(PROMOS_KEY, promoCode);
                  promoForCharge = safeParseRedisItem<any>(raw);
                  if (promoForCharge && promoForCharge.active !== false) {
                    const self =
                      promoForCharge.promoterEmail &&
                      String(promoForCharge.promoterEmail).toLowerCase() === winnerEmail;
                    if (!self) {
                      if (entryDiscount <= 0) {
                        const discount = Math.min(
                          50,
                          Math.max(0, Number(promoForCharge.customerDiscountPercent ?? promoForCharge.discountPercent ?? 0) || 0),
                        );
                        if (discount > 0) {
                          priceCents = Math.max(50, Math.round(basePriceCents * (1 - discount / 100)));
                        }
                      }
                    } else {
                      promoForCharge = null;
                      if (entryDiscount > 0) priceCents = basePriceCents;
                    }
                  } else {
                    promoForCharge = null;
                  }
                } catch {
                  promoForCharge = null;
                }
              }

              console.log('[trigger-drop] charge', {
                email: winnerEmail, promoCode: promoCode || null, entryDiscount, basePriceCents, priceCents,
              });

              await stripe.paymentIntents.create({
                amount: priceCents, currency: 'usd', customer: customerId, payment_method: paymentMethod,
                off_session: true, confirm: true, receipt_email: winnerEmail,
                description: `GOYUNIR: ${productName} (${productSize})`,
              });

              grandRevenueChargesCount++;
              successfulPoolCaptures++;
              live.inventoryRemaining = Math.max(0, live.inventoryRemaining - 1);
              live.salesCompleted = (live.salesCompleted || 0) + 1;

              if (promoForCharge && promoCode) {
                try {
                  const payoutPct = Math.min(50, Math.max(0, Number(promoForCharge.promoterPayoutPercent) || 0));
                  const payoutAmountCents = Math.round((priceCents * payoutPct) / 100);
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
                shippingStatus: 'PENDING_FULFILLMENT', promoCode: promoCode || undefined, amountCents: priceCents,
              });

              await sendWinnerEmail({
                to: winnerEmail, product: productName, size: productSize,
                amountLabel: `$${(priceCents / 100).toFixed(2)}`, promoCode: promoCode || undefined,
              });

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
              processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: 'MISSING_PAYMENT_METHOD' });
            }
          } catch (err: any) {
            remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
            processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: `DECLINED: ${err.message}` });
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

    const tz = GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles';
    const executionTime = new Date().toLocaleString('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short',
    });
    const drawSummary = {
      executionTime,
      timezone: tz,
      processedWinners,
      totalSuccessfulCharges: grandRevenueChargesCount,
      totalRevenueCents: processedWinners
        .filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged')
        .reduce((s: number, w: any) => s + (Number(w.amountCents) || 0), 0),
    };
    try {
      await redis.set(LAST_DRAW_KEY, JSON.stringify(drawSummary));
    } catch {}

    return NextResponse.json({ success: true, drawSummary });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}