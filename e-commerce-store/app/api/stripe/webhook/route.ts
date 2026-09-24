import { ensureCustomer } from '@/lib/customers';
import { adjustRewards, readProfile } from '@/lib/customer-profile';
import { mirrorRewardsToKv } from '@/lib/customer-profile-bridge';
import { NextResponse } from 'next/server';
import {
  createKvClient,
  archiveEntry,
  archiveEntries,
  cleanupMatchingIntent,
  emailBlockKey,
  cardBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  safeParseKvItem,
  loadProducts,
  getLiveProductState,
  saveLiveState,
  STORE_CONFIG_KEY,
  loadStoreConfigCached,
  PRODUCTS_KEY,
  PROMO_CODES_KEY,
  promoUsedKey,
  promoPendingKey,
  poolKey,
} from '@/lib/server-config';
import { markProcessedSession, claimProcessedSession, markEntryEmailSent, isEntryEmailSent } from '@/lib/redis-maintenance';
import { withRedisLock } from '@/lib/redis-lock';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { resolveStripeClient, resolvePaymentWebhookSecret } from '@/services/payment/factory';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';
import { isValidEmail, clampLength, maskEmail } from '@/lib/validation';
import { recordOrder, type RecordOrderLine } from '@/lib/order-write';
import { subrequestCount, reportSubrequests } from '@/lib/subrequest-meter';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';
import { resolveVariantId, decrementInventory as decrementPostgresInventory } from '@/lib/inventory';
import { createRaffleEntry } from '@/lib/raffle';
import { recordPlatformAudit } from '@/lib/platform-audit';

/**
 * Best-effort Postgres inventory mirror for a webhook-driven charge. Stripe
 * has ALREADY charged the customer by the time this runs, so — unlike
 * checkout/direct/route.ts, which can gate the sale before charging — this
 * can only record the authoritative count and flag a discrepancy; it never
 * blocks or fails the webhook response (see lib/order-write.ts's
 * identical "never blocks the real transaction" contract).
 */
async function shadowDecrementInventory(tenantId: string, externalProductId: string, size: string, qty: number): Promise<void> {
  try {
    const variantId = await resolveVariantId(tenantId, externalProductId, size);
    if (!variantId) return; // not backfilled into Postgres yet — nothing to mirror
    const result = await decrementPostgresInventory(tenantId, variantId, qty);
    if (!result.ok) {
      console.error('[webhook] Postgres inventory oversold — manual reconciliation needed', { externalProductId, size, qty, reason: result.reason });
      await recordPlatformAudit({
        action: 'postgres_inventory_oversold',
        tenantId,
        detail: { externalProductId, size, qty, reason: result.reason },
      });
    }
  } catch (e) {
    console.error('[webhook] Postgres inventory shadow-decrement failed', e);
  }
}

export const dynamic = 'force-dynamic';

function siteUrlFromEnv() {
  return getSiteUrl() || fallbackSiteUrl();
}

/**
 * Every paid purchase earns rewards points for the account owner (if they have
 * an account). Rate is configurable in /admin → Settings → Rewards & Points.
 *
 * H7: this is a WRITER of the loyalty balance, so it had to move to
 * public.customers with the two the phase named. Left on the KV hash it would
 * have kept adding points to a copy nobody reads any more, and every purchase
 * would have looked like it earned nothing.
 *
 * adjustRewards creates the customer record when it does not exist yet, so a
 * purchaser who never signed up still accrues a balance against their email —
 * which is the behaviour the KV version could not provide (it silently did
 * nothing when the scan found no account).
 */
async function awardPurchasePoints(redis: any, email: string, amountCents: number) {
  try {
    if (!email || Number(amountCents) <= 0) return;
    // Cached: this handler reads store:config up to three times per delivery
    // (ref prefix, entry email, points), each a PostgREST round trip against
    // the free-plan subrequest ceiling. One read serves all three.
    const config = await loadStoreConfigCached(redis);
    const rate = Math.max(0, Number(config?.rewards?.purchasePointsPerDollar) || 10);
    if (rate <= 0) return;
    const pointsEarned = Math.floor((Number(amountCents) / 100) * rate);
    if (pointsEarned <= 0) return;
    const tenantId = await ensureDefaultTenant();
    const result = await adjustRewards(tenantId, email, pointsEarned);
    if (!result.ok) {
      console.error('[webhook] purchase points NOT awarded to ' + maskEmail(email) + ' (' + result.reason + ')');
      return;
    }
    await mirrorRewardsToKv(redis, email, result.balance);
  } catch (e) {
    console.error('[webhook] award points failed', e);
  }
}

/** Whether this email has a customer record, and its authoritative balance —
 * the number printed in the order-confirmation email. */
async function lookupUserRewards(redis: any, email: string): Promise<{ hasAccount: boolean; rewardsBalance: number }> {
  try {
    if (!email) return { hasAccount: false, rewardsBalance: 0 };
    const tenantId = await ensureDefaultTenant();
    const profile = await readProfile(tenantId, email);
    if (!profile) return { hasAccount: false, rewardsBalance: 0 };
    return { hasAccount: true, rewardsBalance: profile.rewardsBalance };
  } catch (e) {
    console.error('[webhook] lookup rewards failed', e);
    return { hasAccount: false, rewardsBalance: 0 };
  }
}

async function resolvePromo(
  redis: NonNullable<ReturnType<typeof createKvClient>>,
  rawCode: string,
  email: string,
) {
  const promoCode = String(rawCode || '')
    .trim()
    .toUpperCase();
  if (!promoCode) {
    return { appliedPromo: undefined as string | undefined, discountPercent: 0 };
  }

  try {
    const raw = await redis.hget(PROMO_CODES_KEY, promoCode);
    const promo = safeParseKvItem<any>(raw);
    if (!promo || promo.active === false) {
      console.warn('[webhook] promo not found or inactive', promoCode);
      return { appliedPromo: undefined, discountPercent: 0 };
    }

    const maxPer = typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
    const self = promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
    if (self) {
      console.warn('[webhook] self-promo blocked', promoCode, maskEmail(email));
      return { appliedPromo: undefined, discountPercent: 0 };
    }
    if (maxPer > 0) {
      const used = await redis.sismember(promoUsedKey(promoCode), email);
      if (used === 1) {
        console.warn('[webhook] promo already used by email', promoCode, maskEmail(email));
        return { appliedPromo: undefined, discountPercent: 0 };
      }
    }

    const discountPercent = Math.min(
      50,
      Math.max(0, Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0),
    );
    return { appliedPromo: promoCode, discountPercent };
  } catch (e) {
    console.error('[webhook] promo lookup failed', e);
    return { appliedPromo: undefined, discountPercent: 0 };
  }
}

export async function POST(request: Request) {
  // How much of the Worker's subrequest budget this delivery spends. A
  // one-item cart used the whole free-plan ceiling and silently dropped the
  // order write; nothing counted the calls, so the only symptom was whichever
  // call happened to be the one over the line. See lib/subrequest-meter.ts.
  const subrequestsAtStart = subrequestCount();
  const redis = createKvClient();
  // Resolve the Stripe client + webhook secret through the payment driver
  // engine (Setup Wizard settings → legacy env fallback).
  const [stripe, webhookSecret] = await Promise.all([resolveStripeClient(), resolvePaymentWebhookSecret()]);
  if (!redis || !stripe) {
    return NextResponse.json({ error: 'Offline' }, { status: 500 });
  }

  // Admin-configured order-ref prefix (store:config.refPrefix, fallback 'GU').
  // Every ref built/normalized below uses it so legacy GY-/GOY- refs are
  // re-labelled to the NEW prefix and new refs are born with it.
  // Cached — the same read serves the points and entry-email lookups below.
  const refPrefix = normalizeRefPrefix((await loadStoreConfigCached(redis))?.refPrefix || 'GU');

  const sig = request.headers.get('stripe-signature');
  const secret = webhookSecret;
  // Unverified parsing is ONLY allowed in local development with an explicit
  // opt-in flag — never in production, and never just because a header is
  // missing. Forging a checkout.session.completed event must be impossible.
  const allowUnverified = process.env.NODE_ENV !== 'production' && process.env.DEV_WEBHOOK_BYPASS === '1';
  let event: any;

  try {
    const rawBody = await request.text();
    // Stripe webhook payloads are a few KB; anything larger is not a Stripe
    // event. Guard before any parse so a giant body can't pin CPU/memory.
    if (rawBody.length > 1_000_000) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else if (allowUnverified) {
      event = JSON.parse(rawBody);
    } else {
      return NextResponse.json(
        { error: 'Webhook signature verification required' },
        { status: 400 },
      );
    }
  } catch (err: any) {
    // Never echo the underlying error to the caller — log it server-side only
    // (signature errors can leak payload details / internals).
    console.error('[webhook] event verification failed', err?.message || err);
    return NextResponse.json({ error: 'Webhook Error' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;
    // Atomic claim: closes the window where a Stripe redelivery arriving
    // while the first delivery is still mid-flight could double-fulfill an
    // order (double inventory decrement, double reward points, etc).
    const claimed = await claimProcessedSession(redis, sessionId);

    if (!claimed) {
      return NextResponse.json({ received: true, skipped: 'already_processed' });
    }

    if (session.mode === 'setup' && session.status === 'complete') {
      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '')
        .trim()
        .toLowerCase();
      const shippingAddress = clampLength(meta.address, 500).trim();
      const customerId = typeof session.customer === 'string' ? session.customer : '';
      const rawPromo = String(meta.promoCode || meta.ref || '').slice(0, 40);
      const checkoutType = String(meta.checkoutType || 'single').slice(0, 20);

      // Defense-in-depth: never let a malformed session payload write junk into
      // the pools/ledger, even though signature verification is now mandatory.
      if (!isValidEmail(email)) {
        console.warn('[webhook] setup session rejected: invalid email', maskEmail(email));
        await markProcessedSession(redis, sessionId);
        return NextResponse.json({ received: true, skipped: 'invalid_payload' });
      }

      let paymentMethodId = '';
      let cardLast4 = '';
      let cardFingerprint = '';
      try {
        if (session.setup_intent) {
          const si = await stripe.setupIntents.retrieve(String(session.setup_intent), {
            expand: ['payment_method'],
          });
          const pm = si.payment_method as any;
          if (pm) {
            paymentMethodId = typeof pm === 'string' ? pm : pm.id;
            if (typeof pm !== 'string') {
              cardLast4 = pm.card?.last4 || '';
              cardFingerprint = pm.card?.fingerprint || '';
            }
          }
        }
      } catch {}

      // Surface the saved card + address in the Stripe Customer Portal.
      if (paymentMethodId && customerId) {
        try {
          await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: paymentMethodId },
            ...(shippingAddress
              ? {
                  address: { line1: shippingAddress },
                  shipping: { name: email, address: { line1: shippingAddress } },
                }
              : {}),
          });
        } catch (e) {
          console.error('[webhook] attach payment method failed', e);
        }
      }

      // Build the (variant, size, orderRef, maxPerEmail) lines this session
      // secures. A `raffle_cart` setup session carries cartItems JSON and its
      // meta.variant is EMPTY — the webhook must expand every cart line here,
      // otherwise the whole branch is skipped and NO ledger row / confirmation
      // email is ever written for multi-item cart checkouts.
      const allProducts = await loadProducts(redis);
      const lines: Array<{ variant: string; size: string; orderRef: string; productId: string; maxPerEmail: number }> = [];
      if (checkoutType === 'raffle_cart') {
        let cartItems: any[] = [];
        try {
          const rawCart = String(meta.cartItems || '[]');
          if (rawCart.length <= 50_000) cartItems = JSON.parse(rawCart);
        } catch {}
        if (cartItems.length === 0) {
          console.warn('[webhook] raffle_cart setup session rejected: empty cartItems', maskEmail(email));
          await markProcessedSession(redis, sessionId);
          return NextResponse.json({ received: true, skipped: 'invalid_payload' });
        }
        let orderRefIndex = 0;
        for (const item of cartItems) {
          const variant = clampLength(String(item.variant || allProducts[String(item.productId || '')]?.name || ''), 200).trim();
          const size = clampLength(String(item.size || 'Standard'), 50).trim();
          if (!variant || !size) continue;
          const qty = Math.max(1, Math.floor(Number(item.quantity || 1) || 1));
          const product = allProducts[String(item.productId || '')] as any;
          const maxPerEmail = Math.max(1, Number(product?.maxPerEmail || meta.maxPerEmail || 1));
          const baseRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(item.productId || variant), size, refPrefix);
          for (let i = 0; i < qty; i += 1) {
            orderRefIndex += 1;
            lines.push({
              variant,
              size,
              orderRef: `${baseRef}-${orderRefIndex}`,
              productId: String(item.productId || ''),
              maxPerEmail,
            });
          }
        }
      } else {
        const variant = clampLength(meta.variant, 200).trim();
        const size = clampLength(meta.size || 'Standard', 50).trim();
        if (!variant || !size) {
          console.warn('[webhook] setup session rejected: invalid variant/size', maskEmail(email));
          await markProcessedSession(redis, sessionId);
          return NextResponse.json({ received: true, skipped: 'invalid_payload' });
        }
        const maxPerEmail = Math.max(1, Number(meta.maxPerEmail || 1));
        const orderRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(meta.productId || variant), size, refPrefix);
        lines.push({ variant, size, orderRef, productId: String(meta.productId || ''), maxPerEmail });
      }

      for (const line of lines) {
        const { variant, size, orderRef, productId, maxPerEmail } = line;

        const pool = poolKey(variant, size);
        const existingEntries = await redis.lrange(pool, 0, -1);
        const activeCountForEmail = existingEntries.reduce((count: number, row: any) => {
          const parsed = safeParseKvItem<any>(row);
          if (String(parsed?.email || '').toLowerCase() === email) return count + 1;
          return count;
        }, 0);

        const emailBlocked = await redis.sismember(emailBlockKey(variant, size), email);
        // Only treat the fraud-block as a duplicate when this email actually holds
        // an ACTIVE entry — after a draw resets the pool, a stale block from the
        // previous cycle must not block a fresh entry in the new cycle.
        const hasActiveEntry = activeCountForEmail > 0;
        const blockedByLegacyOneEntryRule = emailBlocked === 1 && maxPerEmail <= 1 && hasActiveEntry;
        const blockedByLimit = activeCountForEmail >= maxPerEmail;

        if (!blockedByLegacyOneEntryRule && !blockedByLimit) {
          const { appliedPromo, discountPercent } = await resolvePromo(redis, rawPromo, email);

          const entry = {
            email,
            variant,
            size,
            shippingAddress,
            address: shippingAddress,
            customerId,
            stripeCustomerId: customerId,
            paymentMethodId,
            cardLast4,
            cardFingerprint,
            sessionId,
            promoCode: appliedPromo || undefined,
            discountPercent: appliedPromo && discountPercent > 0 ? discountPercent : undefined,
            registeredAt: new Date().toISOString(),
            type: 'ENTERED',
            orderRef,
          };

          await redis.rpush(poolKey(variant, size), JSON.stringify(entry));
          await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), 1);
          await redis.sadd(emailBlockKey(variant, size), email);
          if (cardFingerprint) await redis.sadd(cardBlockKey(variant, size), cardFingerprint);
          await cleanupMatchingIntent(redis, variant, size, email);

          // Dual-write into Postgres raffle_entries — Redis (above) stays the
          // live system of record (the actual draw engine, lib/auto-draw.ts,
          // still reads from it); this only populates the relational table in
          // real time so it's ready for a future draw-engine cutover. Its own
          // partial-unique-index duplicate check makes this safe to attempt
          // even when the Redis dedupe above already ran.
          if (isPostgresPrimaryEnabled()) {
            const raffleTenantId = await ensureDefaultTenant().catch(() => null);
            if (raffleTenantId && productId) {
              const raffleVariantId = await resolveVariantId(raffleTenantId, productId, size).catch(() => null);
              if (raffleVariantId) {
                // ONE durable customer record per entrant, linked to Stripe.
                // Without this the entry's customer_id stayed NULL and every
                // winner declined as no_payment_method.
                const customerUuid = await ensureCustomer(raffleTenantId, email, customerId || null);
                if (!customerUuid) {
                  console.error('[webhook] no customer record for entrant — this entry cannot be charged', email);
                }
                await createRaffleEntry({
                  tenantId: raffleTenantId,
                  variantId: raffleVariantId,
                  customerId: customerUuid,
                  email,
                  paymentMethodRef: paymentMethodId || null,
                  promoCode: appliedPromo || null,
                  discountPercent: discountPercent || null,
                  shippingAddress: shippingAddress || null,
                }).catch((e) => console.error('[webhook] Postgres raffle_entries dual-write failed', e));
              }
            }
          }

          await archiveEntry(redis, {
            email,
            variant,
            size,
            shippingAddress,
            id: customerId || 'n/a',
            registeredAt: entry.registeredAt,
            type: 'ENTERED',
            orderRef,
            ...(appliedPromo
              ? { promoCode: appliedPromo, discountPercent: discountPercent || undefined }
              : {}),
          } as any);

          if (appliedPromo) {
            try {
              await redis.sadd(promoUsedKey(appliedPromo), email);
              const raw = await redis.hget(PROMO_CODES_KEY, appliedPromo);
              const promo = safeParseKvItem<any>(raw);
              if (promo) {
                promo.uses = (promo.uses || 0) + 1;
                await redis.hset(PROMO_CODES_KEY, { [appliedPromo]: JSON.stringify(promo) });
              }
            } catch {}
          }

          const emailDedupe = `${variant}:${size}:${email}`;
          try {
            const sent = await isEntryEmailSent(redis, emailDedupe);
            if (!sent) {
              const product = Object.values(allProducts).find((p: any) => p.name === variant || p.id === productId);
              const category = (product as any)?.priceCategories?.find((item: any) => item.size === size);
              const listPrice = category?.price;
              const userRewards = await lookupUserRewards(redis, email);
              const storeConfig = await loadStoreConfigCached(redis);
              const purchasePointsPerDollar = Math.max(0, Number(storeConfig?.rewards?.purchasePointsPerDollar) || 10);
              const emailResult = await sendEntryConfirmedEmail({
                to: email,
                product: variant,
                size,
                address: shippingAddress,
                promoCode: appliedPromo,
                discountPercent: discountPercent || undefined,
                listPrice,
                orderRef,
                siteUrl: siteUrlFromEnv(),
                hasAccount: userRewards.hasAccount || undefined,
                rewardsBalance: userRewards.hasAccount ? userRewards.rewardsBalance : undefined,
                purchasePointsPerDollar,
              });
              // Only dedupe when the email ACTUALLY went out — a skipped/failed
              // send (e.g. RESEND_API_KEY missing) must be retried by the
              // confirm-setup repair path instead of being swallowed forever.
              if (emailResult?.ok === true) {
                await markEntryEmailSent(redis, emailDedupe);
              } else {
                console.error('[webhook] entry email failed', maskEmail(email), emailResult?.error || 'send failed');
              }
            }
          } catch (e) {
            console.error('[webhook] entry email', e);
          }

        }
        if (blockedByLimit) {
          await archiveEntry(redis, {
            email,
            variant,
            size,
            shippingAddress,
            id: customerId || 'n/a',
            registeredAt: new Date().toISOString(),
            type: 'ADMIN_NOTE',
            orderRef,
          } as any);
        }
      }

      await markProcessedSession(redis, sessionId);
    }

    if (session.mode === 'payment' && session.status === 'complete') {
      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
      const productId = clampLength(meta.productId, 200).trim();
      const variant = clampLength(meta.variant, 200).trim();
      const size = clampLength(meta.size || 'Standard', 50).trim();
      const shippingAddress = clampLength(meta.address, 500).trim();
      const checkoutType = String(meta.checkoutType || 'single').slice(0, 20);
      const appliedPromo = String(meta.promoCode || meta.ref || '').trim().toUpperCase().slice(0, 40);
      const orderRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(meta.productId || variant), size, refPrefix);

      // Same defense-in-depth as the setup path: junk payloads never reach the
      // ledger/inventory accounting.
      if (!isValidEmail(email)) {
        console.warn('[webhook] payment session rejected: invalid email', maskEmail(email));
        await markProcessedSession(redis, sessionId);
        return NextResponse.json({ received: true, skipped: 'invalid_payload' });
      }

      const allProducts = await loadProducts(redis);
      if (checkoutType === 'cart') {
        let cartItems: any[] = [];
        try {
          const rawCart = String(meta.cartItems || '[]');
          if (rawCart.length <= 50_000) cartItems = JSON.parse(rawCart);
        } catch {}

        // Resolve the cart from metadata and the already-loaded catalog. This
        // costs NO subrequests, which is the whole point of doing it here.
        const cartLines: Array<{ product: any; size: string; qty: number; priceCents: number }> = [];
        for (const item of cartItems) {
          const thisProduct = allProducts[String(item.productId || '')] as any;
          if (!thisProduct) continue;
          cartLines.push({
            product: thisProduct,
            size: String(item.size || 'Standard'),
            qty: Math.max(1, Number(item.quantity || 1)),
            priceCents: Math.max(0, Number(item.priceCents || 0)),
          });
        }
        const cartTotalCents = cartLines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);

        // ── AUTHORITATIVE WRITES FIRST ──────────────────────────────────────
        //
        // THE ORDER USED TO BE WRITTEN LAST, AND THAT IS WHY NO CART ORDER HAS
        // EVER EXISTED. A Cloudflare Worker gets a fixed budget of subrequests
        // per invocation, and every Redis and PostgREST call spends one. The
        // per-item KV mirroring, archive entries, sold-out catalog writes and
        // reward points ahead of it burned the whole budget, so on a two-item
        // cart the run reached this point with nothing left. Measured on
        // production against a real $57.00 charge:
        //
        //   [redis-lock] atomic acquire failed cache:lock:inventory:...
        //   Too many subrequests by single Worker invocation.   (x23)
        //
        // The handler then returned 200, Stripe considered the event
        // delivered, the session was marked processed, and the customer had
        // paid for two products that no order row mentions.
        //
        // So the ordering is now deliberate: the sale and the authoritative
        // stock count are written before anything best-effort is allowed to
        // spend the budget. A cart big enough to exhaust it now loses a KV
        // mirror, which self-heals, instead of losing the record of the sale,
        // which does not.
        let cartTenantId: string | null = null;
        if (cartLines.length > 0 && isPostgresPrimaryEnabled()) {
          cartTenantId = await ensureDefaultTenant().catch((err) => {
            // NEVER SILENT. This used to be `.catch(() => null)` followed by
            // `if (orderTenantId)`, so when the tenant lookup failed the order
            // was skipped without a single line of log — the one failure on
            // this path that must be loud was the one that said nothing.
            console.error('[webhook] CHARGED BUT NOT RECORDED — ' + maskEmail(email) +
              ' ref=' + String(orderRef || session.id) + ': tenant lookup failed: ' +
              ((err as Error)?.message || String(err)));
            return null;
          });
          if (cartTenantId) {
            // ONE PAYMENT, ONE ORDER, EVERY LINE. recordOrder was previously
            // called once per cart item with the single order_ref from the
            // session metadata; orders upsert on (tenant_id, order_ref) and
            // their line items are replaced rather than appended, so each item
            // erased the one before it and a two-item cart recorded only its
            // last line.
            const recorded = await recordOrder({
              tenantId: cartTenantId,
              orderRef: orderRef ? `${orderRef}` : `DIRECT-${session.id}`,
              email,
              lines: cartLines.map((l) => ({
                externalProductId: String(l.product.id),
                productName: String(l.product.name),
                size: l.size,
                quantity: l.qty,
                amountCents: l.priceCents * l.qty,
              })),
              // A `checkoutType: 'cart'` session is ALWAYS first-come-first-served:
              // app/api/checkout/cart/route.ts partitions the basket and sends
              // raffle lines to a separate `mode: 'setup'` session under
              // `raffle_cart`, so nothing raffle-shaped reaches this branch.
              // The metadata has no `checkoutMode` key at all, so reading it
              // produced '' and every cart order was stored with a NULL
              // checkout_mode — invisible to per-mode revenue reporting, and
              // ambiguous for the per-payment fee attribution Connect needs.
              checkoutMode: 'fcfs',
              promoCode: appliedPromo,
              stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
            });
            if (!recorded.ok) {
              console.error('[webhook] CHARGED BUT NOT RECORDED — ' + maskEmail(email) +
                ' ref=' + String(orderRef || session.id) + ': ' + recorded.message);
            }
            // Authoritative stock, straight after the sale and before any
            // best-effort work can spend what is left of the budget.
            for (const l of cartLines) {
              await shadowDecrementInventory(cartTenantId, String(l.product.id), l.size, l.qty);
            }
          }
        }

        // ── BEST-EFFORT MIRRORS ─────────────────────────────────────────────
        // Everything below is a KV mirror of state Postgres already holds, or
        // a ledger entry. Losing one to an exhausted budget is recoverable;
        // losing the order above is not, which is why it no longer runs here.
        // One ledger write for the whole cart. `archiveUnitIndex` runs across
        // the ENTIRE order rather than restarting per line, which also fixes a
        // duplicate: two lines of quantity 1 both produced `<ref>-1`.
        const cartArchiveRecords: any[] = [];
        let archiveUnitIndex = 0;
        for (const l of cartLines) {
          const thisProduct = l.product;
          const thisSize = l.size;
          const qty = l.qty;
          const priceCents = l.priceCents;
          // Atomic-ish: serialize concurrent decrements for this product+size
          // so two paid orders can never both read the same stock count and
          // both write back a decrement — that's how you oversell the last
          // unit (charged customer, no inventory to ship).
          const decrementInventory = async () => {
            const inner = await getLiveProductState(redis, thisProduct, thisSize);
            inner.inventoryRemaining = Math.max(0, Number(inner.inventoryRemaining || 0) - qty);
            inner.salesCompleted = (inner.salesCompleted || 0) + qty;
            await saveLiveState(redis, inner);
            return inner;
          };
          const lockResult = await withRedisLock(redis, `inventory:${thisProduct.id}:${thisSize}`, decrementInventory);
          // KV live-state mirror ONLY. inventory_levels is decremented by
          // shadowDecrementInventory above, which also records a platform
          // audit on failure -- adding a second decrement here
          // DOUBLE-DECREMENTED every cart order. Caught by counting decrements
          // per path, not by any test.
          //
          // The old "if (!lockResult.ok) await decrementInventory()" unlocked
          // fallback is GONE: with a lock that genuinely excludes, that branch
          // would have turned real contention into a live oversell path.
          //
          // On contention the soldOutAt update is SKIPPED rather than guessed.
          // Fabricating inventoryRemaining = 0 would mark a product sold out on
          // a lock miss, and the storefront derives soldOut from Postgres
          // inventory anyway.
          if (!lockResult.ok) {
            console.error('[webhook] KV live-state mirror skipped (lock contended); Postgres remains authoritative', thisProduct.id, thisSize);
          }
          // THE SOLD-OUT CATALOG WRITE IS GONE, AND IT NEVER DID ANYTHING.
          //
          // This block set `soldOutAt` on the in-memory product and then called
          // writeProductToPostgres to persist it — three PostgREST calls plus a
          // per-variant insert loop, on the most budget-starved path in the
          // system. But `sold_out_at` IS NOT A COLUMN: neither
          // lib/catalog-write.ts nor lib/postgres-catalog-read.ts mentions the
          // field, and there is no jsonb passthrough carrying it. The only
          // field this code mutated was one the write ignores, and
          // statusFromFlags() does not read it either, so the call rewrote
          // unchanged data at full price.
          //
          // Removing it changes no persisted state. It also does not make
          // anything worse: the storefront derives sold-out from Postgres
          // inventory, which shadowDecrementInventory has already written
          // above, so the display is driven by the authoritative number rather
          // than a timestamp that was never stored.
          //
          // What IS lost is a feature that was already dead — sold-out products
          // auto-archiving after `soldOutArchiveDelayHours` (app/api/store
          // and app/api/catalog/status both read `soldOutAt` to decide it) has
          // not worked since the catalog moved to Postgres, because the value
          // they read is always empty. Reviving it needs a real column and a
          // backfill decision; see DEFERRED-8. It is not something to smuggle
          // back in from the checkout webhook.

          // Collected across every line and unit, written once below. One
          // rpush carries the whole cart for the same two HTTP calls a single
          // entry used to cost.
          for (let i = 0; i < qty; i += 1) {
            cartArchiveRecords.push({
              email,
              variant: thisProduct.name,
              size: thisSize,
              shippingAddress,
              id: typeof session.customer === 'string' ? session.customer : 'n/a',
              registeredAt: new Date().toISOString(),
              type: 'WINNER_CHARGED',
              shippingStatus: 'PENDING_FULFILLMENT',
              amountCents: priceCents,
              promoCode: appliedPromo || undefined,
              orderRef: orderRef ? `${orderRef}-${archiveUnitIndex + 1}` : `DIRECT-${session.id}-${archiveUnitIndex + 1}`,
            } as any);
            archiveUnitIndex += 1;
          }
        }
        await archiveEntries(redis, cartArchiveRecords);
        // ONCE for the cart, not once per line. Called per item this repeated a
        // config read, a tenant lookup, a balance read/write and a KV mirror
        // for every product in the basket, to arrive at a single total.
        await awardPurchasePoints(redis, email, cartTotalCents);
      } else {
        const product = (allProducts[productId] || Object.values(allProducts).find((item: any) => item.name === variant)) as any;
        if (product && email) {
          const decrementInventory = async () => {
            const inner = await getLiveProductState(redis, product, size);
            if (inner.inventoryRemaining > 0) inner.inventoryRemaining -= 1;
            inner.salesCompleted = (inner.salesCompleted || 0) + 1;
            await saveLiveState(redis, inner);
            return inner;
          };
          const lockResult = await withRedisLock(redis, `inventory:${product.id}:${size}`, decrementInventory);
          // KV live-state mirror ONLY. inventory_levels is decremented by the
          // pre-existing shadowDecrementInventory() call further down, which
          // also records a platform audit on failure -- adding a second
          // decrement here DOUBLE-DECREMENTED every direct order. Caught by
          // counting decrements per path, not by any test.
          //
          // The old "if (!lockResult.ok) await decrementInventory()" unlocked
          // fallback is GONE: with a lock that genuinely excludes, that branch
          // would have turned real contention into a live oversell path.
          //
          // On contention the soldOutAt update is SKIPPED rather than guessed.
          // Fabricating inventoryRemaining = 0 would mark a product sold out on
          // a lock miss, and the storefront derives soldOut from Postgres
          // inventory anyway.
          if (!lockResult.ok) {
            console.error('[webhook] KV live-state mirror skipped (lock contended); Postgres remains authoritative', product.id, size);
          }
          // Removed for the same reason as the cart branch above: `sold_out_at`
          // is not a column, so this rewrote the whole product and all its
          // variants to persist a field that is silently dropped. See the
          // longer note there and DEFERRED-8.

          await archiveEntry(redis, {
            email,
            variant: product.name,
            size,
            shippingAddress,
            id: typeof session.customer === 'string' ? session.customer : 'n/a',
            registeredAt: new Date().toISOString(),
            type: 'WINNER_CHARGED',
            shippingStatus: 'PENDING_FULFILLMENT',
            amountCents: Number(session.amount_total || 0),
            promoCode: appliedPromo || undefined,
            orderRef: orderRef || `DIRECT-${session.id}`,
          } as any);
          await awardPurchasePoints(redis, email, Number(session.amount_total || 0));

          if (isPostgresPrimaryEnabled()) {
            // Loud for the same reason as the cart branch above: a swallowed
            // tenant lookup skipped the order write without logging anything,
            // so money taken with no order behind it looked like a clean run.
            const orderTenantId = await ensureDefaultTenant().catch((err) => {
              console.error('[webhook] CHARGED BUT NOT RECORDED — ' + maskEmail(email) +
                ' ref=' + String(orderRef || session.id) + ': tenant lookup failed: ' +
                ((err as Error)?.message || String(err)));
              return null;
            });
            if (orderTenantId) {
              const recorded = await recordOrder({
                tenantId: orderTenantId,
                orderRef: orderRef || `DIRECT-${session.id}`,
                email,
                externalProductId: String(product.id),
                productName: product.name,
                size,
                quantity: 1,
                amountCents: Number(session.amount_total || 0),
                checkoutMode: String((meta as Record<string, unknown>).checkoutMode || ''),
                promoCode: appliedPromo,
                stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
              });
              if (!recorded.ok) {
                console.error('[webhook] CHARGED BUT NOT RECORDED — ' + maskEmail(email) +
                  ' ref=' + String(orderRef || session.id) + ': ' + recorded.message);
              }
              await shadowDecrementInventory(orderTenantId, String(product.id), size, 1);
            }
          }
        }
      }

      if (appliedPromo) {
        try {
          await redis.sadd(promoUsedKey(appliedPromo), email);
          await redis.del(promoPendingKey(appliedPromo, email));
          const raw = await redis.hget(PROMO_CODES_KEY, appliedPromo);
          const promo = safeParseKvItem<any>(raw);
          if (promo) {
            promo.uses = (Number(promo.uses) || 0) + 1;
            await redis.hset(PROMO_CODES_KEY, { [appliedPromo]: JSON.stringify(promo) });
          }
        } catch (e) {
          console.error('[webhook] payment promo accounting failed', e);
        }
      }

      await markProcessedSession(redis, sessionId);
    }
  }

  reportSubrequests('webhook ' + String(event.type || 'unknown'), subrequestsAtStart);
  return NextResponse.json({ received: true });
}