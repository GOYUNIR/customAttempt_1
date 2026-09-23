import { recordOrder } from '@/lib/order-write';
import type { NextRequest } from 'next/server';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { decrementForSale } from '@/lib/inventory';

import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  buildAbsoluteUrl,
  createKvClient,
  safeParseKvItem,
  archiveEntry,
  resolveCustomerId,
  resetPoolAndBlocks,
  LAST_DRAW_KEY,
  loadProducts,
  getLiveProductState,
  saveLiveState,
} from '@/lib/server-config';
import { resolveStripeClient } from '@/services/payment/factory';
import { getWinnerCount, isConfiguredPrice } from '@/lib/storefront-config';
import { poolKey, intentPoolKey } from '@/lib/redis-keys';
import { buildOrderRef } from '@/lib/order-ref';
import { withRedisLock } from '@/lib/redis-lock';
import { boundIdempotencyKey } from '@/lib/idempotency-key';

export interface DrawResult {
  email: string;
  scent: string;
  size: string;
  checkout?: string;
  status: 'charged' | 'checkout' | 'skipped';
  message?: string;
}

export async function runDropDraw(request: Request | NextRequest) {
  const redis = createKvClient();
  const stripe = await resolveStripeClient();
  const resultsSummary: DrawResult[] = [];

  if (!redis) {
    return { success: true, processedWinners: [], message: 'Redis is not configured. No draw was processed.' };
  }

  const products = Object.values(await loadProducts(redis));

  for (const product of products as any[]) {
    const priceCategories = Array.isArray(product.priceCategories) ? product.priceCategories : [];
    for (const category of priceCategories) {
            const size = String(category?.size || 'Standard');
      const categoryPriceCents = category && isConfiguredPrice(category.price)
        ? Math.round(Number(category.price) * 100)
        : 0;
      if (categoryPriceCents <= 0) continue;
      const pool = poolKey(product.name, size);
      const totalEntries = await redis.llen(pool);
      if (totalEntries === 0) continue;

      const allRegistrations = await redis.lrange(pool, 0, -1);
      const parsedPool = allRegistrations
        .map((entry) => safeParseKvItem<Record<string, unknown>>(entry))
        .filter(Boolean) as Record<string, unknown>[];

      for (let index = parsedPool.length - 1; index > 0; index -= 1) {
        const j = Math.floor(Math.random() * (index + 1));
        [parsedPool[index], parsedPool[j]] = [parsedPool[j], parsedPool[index]];
      }

      const parsedWinnerTiers = String(category?.winnerTiers || '0')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item >= 0);
      const configuredLimit = Math.max(0, parsedWinnerTiers[0] ?? getWinnerCount(GOYUNIR_STORE_SUITE, size));
      // The draw must never charge more winners than physical stock, even if
      // `winnerTiers` is misconfigured (e.g. stale after a partial sell-through
      // on another channel) — every other checkout path treats
      // `inventoryRemaining` as the source of truth, the draw was the one
      // path that didn't.
      const live = await getLiveProductState(redis, product, size);
      const targetLimit = Math.max(0, Math.min(configuredLimit, Number(live.inventoryRemaining) || 0));
      let successCount = 0;

      for (const entry of parsedPool) {
        const email = String(entry.email ?? '');
        const customerId = resolveCustomerId(entry) || '';
        const paymentMethodId = String(entry.paymentMethodId ?? '');
        const shippingAddress = String(entry.shippingAddress ?? entry.address ?? 'No Address Logged');
        const promoCode = String(entry.promoCode ?? '').trim().toUpperCase();
        // Apply the promo stored on the entry at signup time ("X% off if
        // selected") so winners always pay the discounted amount.
        const entryDiscount = Math.min(50, Math.max(0, Number(entry.discountPercent) || 0));
        const priceCents = entryDiscount > 0
          ? Math.max(50, Math.round(categoryPriceCents * (1 - entryDiscount / 100)))
          : categoryPriceCents;

        if (successCount >= targetLimit) {
          await archiveEntry(redis, {
            email, variant: product.name, size, shippingAddress,
            id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'NOT_SELECTED',
          });
          continue;
        }

        let directChargeCompleted = false;
        if (stripe && customerId && paymentMethodId) {
          try {
            // Idempotency key so a re-triggered/overlapping draw run (manual
            // retrigger racing the cron, or `force=1`) can never charge the
            // same winner's card twice — Stripe dedupes retries of this key.
            const idempotencyKey = boundIdempotencyKey(`draw:${product.id}:${size}:${email}:${customerId}`);
            const paymentIntent = await stripe.paymentIntents.create(
              {
                amount: priceCents,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethodId,
                off_session: true,
                confirm: true,
                metadata: { product: product.name, size, email },
                statement_descriptor_suffix: size.slice(0, 10),
              },
              { idempotencyKey },
            );
            resultsSummary.push({ email, scent: product.name, size, checkout: `charged:${paymentIntent.id}`, status: 'charged', message: 'Auto-charge succeeded.' });
            successCount += 1;
            directChargeCompleted = true;
            const decrementInventory = async () => {
              const inner = await getLiveProductState(redis, product, size);
              inner.inventoryRemaining = Math.max(0, Number(inner.inventoryRemaining || 0) - 1);
              inner.salesCompleted = (inner.salesCompleted || 0) + 1;
              await saveLiveState(redis, inner);
              return inner;
            };
            // Captured once and reused by the order write below.
            // ensureDefaultTenant() upserts on every call, so calling it twice
            // per winner is a needless write on the hot path of a draw run.
            const drawTenantId = await ensureDefaultTenant();
            await decrementForSale({
              tenantId: drawTenantId,
              externalProductId: String(product.id),
              size: String(size),
              context: 'draw',
            });
            const lockResult = await withRedisLock(redis, `inventory:${product.id}:${size}`, decrementInventory);
            // KV live-state mirror ONLY. Postgres inventory_levels is
            // authoritative (decrementForSale above). The old
            // "if (!lockResult.ok) await decrementInventory()" unlocked
            // fallback is GONE -- with a lock that genuinely excludes, that
            // branch would have become a live oversell path.
            if (!lockResult.ok) {
              console.error('[draw] KV live-state mirror skipped (lock contended) — Postgres already decremented', product.id, size);
            }
            const winnerOrderRef = String(entry.orderRef || '') || buildOrderRef(email, product.name, size);
            await archiveEntry(redis, {
              email, variant: product.name, size, shippingAddress,
              id: customerId, registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
              ...(promoCode ? { promoCode, discountPercent: entryDiscount || undefined } : {}),
              orderRef: winnerOrderRef,
              amountCents: priceCents,
            });

            // RECORD THE SALE IN POSTGRES. A raffle winner's charge is the
            // moment a raffle becomes a sale, and until now it produced only
            // the Redis archive entry above. The Stripe webhook does not cover
            // it either: the winner's card was saved by a `mode: 'setup'`
            // session weeks earlier, so the only `checkout.session.completed`
            // for this buyer fired when nothing had been charged yet. The
            // actual money moves here, off-session, with no session behind it.
            //
            // Idempotent on (tenant_id, order_ref), which matters more here
            // than anywhere else: a re-triggered draw run reuses the same
            // winnerOrderRef, so a retry updates one order rather than
            // inventing a second sale for one charge.
            const recordedWinner = await recordOrder({
              tenantId: drawTenantId,
              orderRef: winnerOrderRef,
              email,
              externalProductId: String(product.id),
              productName: product.name,
              size: String(size),
              quantity: 1,
              amountCents: priceCents,
              checkoutMode: 'raffle',
              promoCode: promoCode || null,
              stripeCustomerId: customerId,
              stripePaymentIntentId: paymentIntent.id,
            });
            if (!recordedWinner.ok) {
              console.error('[draw] CHARGED BUT NOT RECORDED — ref=' + winnerOrderRef +
                ' pi=' + paymentIntent.id + ': ' + recordedWinner.message);
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Charge failed.';
            resultsSummary.push({ email, scent: product.name, size, status: 'skipped', message: `Auto-charge failed: ${message}` });

            if (stripe) {
              const fallbackSession = await stripe.checkout.sessions.create({
                customer: customerId,
                payment_method_types: ['card'],
                // Use the DISCOUNTED unit amount so winners who applied a promo
                // never get a full-price fallback invoice.
                line_items: [{
                  price_data: {
                    currency: 'usd',
                    unit_amount: priceCents,
                    product_data: {
                      name: `${product.name} - ${size}`,
                      description: product.tagline || product.desc || undefined,
                    },
                  },
                  quantity: 1,
                }],
                mode: 'payment',
                expires_at: Math.floor(Date.now() / 1000) + 1800,
                success_url: `${buildAbsoluteUrl(request as Request, '/')}?session=success`,
                cancel_url: `${buildAbsoluteUrl(request as Request, '/')}?session=cancel`,
                metadata: {
                  productId: String(product.id),
                  variant: String(product.name),
                  size,
                  email,
                  address: shippingAddress,
                  checkoutType: 'single',
                  ...(promoCode ? { promoCode, ref: promoCode } : {}),
                  orderRef: String(entry.orderRef || '') || buildOrderRef(email, product.name, size),
                },
              });
              resultsSummary.push({ email, scent: product.name, size, checkout: fallbackSession.url ?? undefined, status: 'checkout', message: 'Card declined/error - Failover checkout session created.' });
              successCount += 1;
            }
            directChargeCompleted = true;
            await archiveEntry(redis, {
              email, variant: product.name, size, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED',
              ...(promoCode ? { promoCode, discountPercent: entryDiscount || undefined } : {}),
              orderRef: String(entry.orderRef || '') || buildOrderRef(email, product.name, size),
            });
          }
        }

        if (!directChargeCompleted && stripe) {
          const fallbackSession = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{
              price_data: {
                currency: 'usd',
                unit_amount: priceCents,
                product_data: {
                  name: `${product.name} - ${size}`,
                  description: product.tagline || product.desc || undefined,
                },
              },
              quantity: 1,
            }],
            mode: 'payment',
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            success_url: `${buildAbsoluteUrl(request as Request, '/')}?session=success`,
            cancel_url: `${buildAbsoluteUrl(request as Request, '/')}?session=cancel`,
            metadata: {
              productId: String(product.id),
              variant: String(product.name),
              size,
              email,
              address: shippingAddress,
              checkoutType: 'single',
              ...(promoCode ? { promoCode, ref: promoCode } : {}),
              orderRef: String(entry.orderRef || '') || buildOrderRef(email, product.name, size),
            },
          });
          resultsSummary.push({ email, scent: product.name, size, checkout: fallbackSession.url ?? undefined, status: 'checkout', message: 'Fallback checkout session created.' });
          successCount += 1;
          await archiveEntry(redis, {
            email, variant: product.name, size, shippingAddress,
            id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
            ...(promoCode ? { promoCode, discountPercent: entryDiscount || undefined } : {}),
            orderRef: String(entry.orderRef || '') || buildOrderRef(email, product.name, size),
            amountCents: priceCents,
          });
        }
      }

      const intentKey = intentPoolKey(product.name, size);
      try {
        const remainingIntents = await redis.lrange(intentKey, 0, -1);
        for (const item of remainingIntents) {
          const parsed = safeParseKvItem<any>(item);
          if (parsed) {
            await archiveEntry(redis, {
              email: String(parsed.email || 'Unknown'), variant: product.name, size,
              shippingAddress: String(parsed.shippingAddress || parsed.address || 'Unknown'),
              id: 'n/a', registeredAt: new Date().toISOString(), type: 'INTENT_EXPIRED',
            });
          }
        }
      } catch {}

      await resetPoolAndBlocks(redis, product.name, size);
    }
  }

  const summary = { success: true, processedWinners: resultsSummary };
  try {
    await redis.set(LAST_DRAW_KEY, JSON.stringify({
      executionTime: new Date().toLocaleString(),
      processedWinners: resultsSummary,
      totalSuccessfulCharges: resultsSummary.filter((r) => r.status === 'charged').length,
    }));
  } catch {}

  return summary;
}