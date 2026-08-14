import { NextResponse } from 'next/server';
import { createRedisClient, ARCHIVE_LEDGER_KEY, loadProducts, safeParseRedisItem, verifyAdminPassword, PROMO_CODES_KEY, promoCreditKey, poolKey } from '@/lib/server-config';
import { sendAccountUpdateEmail, sendDeliveryIncentiveEmail } from '@/lib/email';
import { appendAudit } from '@/app/api/admin/audit/route';

export const dynamic = 'force-dynamic';

const ALLOWED = ['PENDING_FULFILLMENT', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'];

function generatePromoCode(prefix: string) {
  const root = (prefix || 'GOY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'GOY';
  return `${root}-${Math.random().toString(36).slice(2, 7).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

/** Human-friendly status line for the customer email. */
function statusMessage(shippingStatus: string, trackingNumber?: string) {
  const tracking = trackingNumber ? ` Tracking number: ${trackingNumber}.` : '';
  switch (shippingStatus) {
    case 'LABEL_CREATED':
      return `Your shipping label has been created and your order is being prepared for dispatch.${tracking}`;
    case 'SHIPPED':
      return `Your order is on the way!${tracking}`;
    case 'DELIVERED':
      return `Your order has been delivered!${tracking}`;
    default:
      return `Your order status was updated to ${shippingStatus.replace(/_/g, ' ').toLowerCase()}.${tracking}`;
  }
}


export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (!verifyAdminPassword(password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const email = String(body?.email || '').toLowerCase();
    const variant = String(body?.variant || '');
    const size = String(body?.size || '');
    const shippingStatus = String(body?.shippingStatus || '');
    const trackingNumber = String(body?.trackingNumber || '').trim();

    if (!email || !variant || !ALLOWED.includes(shippingStatus)) {
      return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
    }

    const all = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    const liveProducts = await loadProducts(redis);
    let updated = 0;
    let notified = false;

    for (let i = 0; i < all.length; i++) {
      const e = safeParseRedisItem<any>(all[i]);
      if (!e) continue;
      if (
        e.type === 'WINNER_CHARGED' &&
        String(e.email || '').toLowerCase() === email &&
        e.variant === variant &&
        (!size || e.size === size)
      ) {
        const updatedEntryData = {
          ...e,
          shippingStatus,
          ...(trackingNumber ? { trackingNumber } : {}),
        };
        await redis.lset(ARCHIVE_LEDGER_KEY, i, JSON.stringify(updatedEntryData));
        updated++;

        // Email the customer on any meaningful fulfilment movement. The initial
        // PENDING_FULFILLMENT state is set automatically at charge time, so we
        // only notify when the status actually moves forward (or when an admin
        // explicitly saves a label/shipped/delivered update).
        if (shippingStatus !== 'PENDING_FULFILLMENT') {
          try {
            await sendAccountUpdateEmail({
              to: email,
              product: variant,
              size: size || undefined,
              changeType: 'shipping',
              newAddress: statusMessage(shippingStatus, trackingNumber),
            });
            notified = true;
          } catch (emailErr) {
            console.error('[shipping] customer email failed', emailErr);
          }
        }

        // Issue the post-delivery incentive credit once per order.
        if (shippingStatus === 'DELIVERED') {
          try {
            const product = Object.values(liveProducts).find((p: any) => p.name === variant || p.id === e.productId) as any;
            const triggerSizes = Array.isArray(product?.deliveryIncentiveTriggerSizes) ? product.deliveryIncentiveTriggerSizes.map(String) : [];
            const shouldIssue = product?.deliveryIncentiveEnabled === true && (triggerSizes.length === 0 || triggerSizes.includes(String(e.size || size)));
            const ref = String(e.orderRef || `${email}:${variant}:${size}`);
            const alreadyIssued = await redis.get(promoCreditKey(ref));
            if (shouldIssue && !alreadyIssued) {
              const fixedDiscountCents = Math.max(0, Number(product.deliveryIncentiveCreditCents || 0));
              if (fixedDiscountCents > 0) {
                const promoCode = generatePromoCode(product.deliveryIncentiveCodePrefix || product.slug || 'GOY');
                const record = {
                  code: promoCode,
                  promoterName: 'Delivery Credit',
                  promoterEmail: '',
                  customerDiscountPercent: 0,
                  fixedDiscountCents,
                  minimumOrderSubtotalCents: Math.max(0, Number(product.deliveryIncentiveMinOrderSubtotalCents || 0)),
                  eligibleProductSlugs: Array.isArray(product.deliveryIncentiveEligibleProductSlugs) ? product.deliveryIncentiveEligibleProductSlugs : [],
                  eligibleSizes: Array.isArray(product.deliveryIncentiveEligibleSizes) ? product.deliveryIncentiveEligibleSizes : [],
                  issuedForEmail: email,
                  autoGenerated: true,
                  incentiveSourceProductId: product.id,
                  promoterPayoutPercent: 0,
                  maxUsesPerEmail: 1,
                  maxUsesTotal: 1,
                  timeLimited: false,
                  startAt: new Date().toISOString(),
                  endAt: null,
                  firstXWinnersDiscount: 0,
                  active: true,
                  uses: 0,
                  clicks: 0,
                  revenueAttributed: 0,
                  payoutOwedCents: 0,
                  payoutPaidCents: 0,
                  createdAt: new Date().toISOString(),
                };
                await redis.hset(PROMO_CODES_KEY, { [promoCode]: JSON.stringify(record) });
                await redis.set(promoCreditKey(ref), promoCode);
                await sendDeliveryIncentiveEmail({
                  to: email,
                  product: variant,
                  size: size || undefined,
                  code: promoCode,
                  creditAmountCents: fixedDiscountCents,
                  minimumOrderSubtotalCents: record.minimumOrderSubtotalCents,
                  eligibleProductSlugs: record.eligibleProductSlugs,
                  eligibleSizes: record.eligibleSizes,
                });
              }
            }
          } catch (e) {
            console.error('[shipping] incentive issue failed', e);
          }
        }
      }
    }

    // Also update the live pool entry if it exists
    try {
      const pool = poolKey(variant, size);
      const items = await redis.lrange(pool, 0, -1);
      for (let i = 0; i < items.length; i++) {
        const parsed = safeParseRedisItem<any>(items[i]);
        if (parsed && String(parsed.email || '').toLowerCase() === email) {
          const updated = { ...parsed, shippingStatus, trackingNumber: trackingNumber || parsed.trackingNumber };
          await redis.lset(pool, i, JSON.stringify(updated));
          break;
        }
      }
    } catch {}

    try {
      await appendAudit(redis, {
        action: 'SHIPPING_UPDATED',
        detail: `${variant} ${size ? `/ ${size}` : ''} — ${email} → ${shippingStatus}${trackingNumber ? ` · tracking ${trackingNumber}` : ''}${updated > 0 ? ` (${updated} record${updated === 1 ? '' : 's'})` : ''}`,
        actor: 'admin',
        email,
      });
    } catch {}

    return NextResponse.json({ success: true, updated, notified });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

