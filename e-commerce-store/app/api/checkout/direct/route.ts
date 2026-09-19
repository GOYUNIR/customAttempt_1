import { NextResponse } from 'next/server';
import {
  createKvClient,
  getLiveProductState,
  saveLiveState,
  archiveEntry,
  ArchiveRecord,
  ARCHIVE_LEDGER_KEY,
  loadProducts, // new helper to fetch product from Redis
  safeParseKvItem,
  STORE_CONFIG_KEY,
} from '@/lib/server-config';
import { resolveStripeClient } from '@/services/payment/factory';
import { resolveStripePriceIdWithSettings } from '@/services/config/platform-settings';
import { buildOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { isConfiguredPrice } from '@/lib/storefront-config';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { withRedisLock } from '@/lib/redis-lock';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { resolveVariantId, decrementInventory as decrementPostgresInventory, restockInventory } from '@/lib/inventory';
import { boundIdempotencyKey } from '@/lib/idempotency-key';

/** Same anti-scalping check `checkout/route.ts` enforces before creating a
 * Stripe Checkout Session — this direct-charge path was missing it entirely,
 * letting a stored payment method buy unlimited units of a "N per customer"
 * drop. */
async function countChargedByEmail(redis: any, email: string, variant: string, size: string) {
  const rows = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
  let count = 0;
  for (const row of rows) {
    try {
      const parsed = typeof row === 'string' ? JSON.parse(row) : row;
      if (!parsed) continue;
      if (String(parsed.type || '') !== 'WINNER_CHARGED') continue;
      if (String(parsed.email || '').toLowerCase() !== email) continue;
      if (String(parsed.variant || '') !== variant) continue;
      if (String(parsed.size || '') !== size) continue;
      count += 1;
    } catch {}
  }
  return count;
}

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Read the admin-configured order-ref prefix (`store:config.refPrefix`,
 * fallback 'GU') so refs built here match what the admin portal shows. */
async function getRefPrefix(redis: any): Promise<string> {
  try {
    const rawCfg = await redis.get(STORE_CONFIG_KEY);
    const cfg = safeParseKvItem<any>(rawCfg) || {};
    return normalizeRefPrefix(cfg?.refPrefix || 'GU');
  } catch {
    return 'GU';
  }
}

export async function POST(request: Request) {
  try {
    const redis = createKvClient();
    const stripe = await resolveStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { productId, size, email, shippingAddress, paymentMethodId, promoCode, customerId } = body;

    if (!productId || !size || !email || !shippingAddress || !paymentMethodId) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const limited = await rateLimitedResponse('checkout_direct', request, 10, 60);
    if (limited) return limited;

    const refPrefix = await getRefPrefix(redis);

    // Fetch the product from Redis – this gives us the live priceCategories.
    const allProducts = await loadProducts(redis);
    const product = allProducts[productId];
    if (!product) {
      return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    }

    // Also check if the size exists in the product's priceCategories
    const priceCategories = product.priceCategories || [];
    const category = priceCategories.find((cat: any) => cat.size === size);
    if (!category) {
      return NextResponse.json({ error: `Size "${size}" not configured for this product.` }, { status: 400 });
    }

    // Price and Stripe ID come directly from the priceCategories (no separate overrides needed)
    const basePrice = category.price;
    if (!isConfiguredPrice(basePrice)) {
      return NextResponse.json({ error: `Price not set for size "${size}". Set it in admin.` }, { status: 400 });
    }
    const priceCents = Math.round(basePrice * 100);

    const stripeId = await resolveStripePriceIdWithSettings(category.stripeId);
    if (!stripeId || stripeId.startsWith('price_placeholder') || stripeId === '') {
      return NextResponse.json({ error: `Stripe price ID not set for size "${size}". Set it in admin or via STRIPE_PRODUCT_ID.` }, { status: 400 });
    }

    // Get live inventory state
    const live = await getLiveProductState(redis, product, size);
    if (!live || live.inventoryRemaining <= 0) {
      return NextResponse.json({ error: 'Sold out.' }, { status: 400 });
    }

    // Anti-scalping cap — same rule `checkout/route.ts` enforces.
    const maxPerEmail = Math.max(1, Number((product as any).maxPerEmail || 1));
    const chargedCount = await countChargedByEmail(redis, normalizedEmail, product.name, String(size));
    if (chargedCount >= maxPerEmail) {
      return NextResponse.json({ error: `Purchase limit reached (${maxPerEmail} per email).` }, { status: 409 });
    }

    // ── Postgres primary gate (USE_POSTGRES_PRIMARY) ──────────────────────
    // Unlike the webhook-driven flow (checkout/cart), this route charges the
    // customer directly, so it's the one checkout path that CAN gate the
    // sale on Postgres inventory before money moves — the real "primary"
    // cutover for this route. Fails closed: a variant that hasn't been
    // backfilled into Postgres yet (scripts/migrate-redis-to-supabase.ts)
    // blocks the sale rather than risk an unprotected oversell.
    let pgTenantId: string | null = null;
    let pgVariantId: string | null = null;
    if (isPostgresPrimaryEnabled()) {
      pgTenantId = await ensureDefaultTenant().catch(() => null);
      if (!pgTenantId) {
        return NextResponse.json({ error: 'Postgres is not reachable. Try again shortly.' }, { status: 503 });
      }
      pgVariantId = await resolveVariantId(pgTenantId, String(productId), String(size)).catch(() => null);
      if (!pgVariantId) {
        return NextResponse.json(
          { error: 'This product has not been migrated to Postgres yet (run scripts/migrate-redis-to-supabase.ts).' },
          { status: 503 },
        );
      }
      const decrementResult = await decrementPostgresInventory(pgTenantId, pgVariantId, 1);
      if (!decrementResult.ok) {
        const status = decrementResult.reason === 'insufficient_stock' ? 400 : 409;
        return NextResponse.json({ error: decrementResult.reason === 'insufficient_stock' ? 'Sold out.' : 'Please retry — inventory is busy.' }, { status });
      }
    }

    // Create or use existing Stripe customer + charge. Any thrown error (not
    // just a non-'succeeded' status) rolls back the Postgres reservation
    // above — the unit was never actually charged, so it must not stay
    // decremented.
    let stripeCustomerId = customerId;
    let paymentIntent;
    try {
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          email,
          // Stripe metadata values must be strings — passing the raw address
          // object here failed on every checkout, string or not: Stripe's
          // validator rejects a non-string value before the charge itself is
          // ever attempted. Found by actually running a checkout, not by
          // reading the code.
          metadata: { initialShippingAddress: JSON.stringify(shippingAddress) },
        });
        stripeCustomerId = customer.id;
      }

      // An idempotency key means a client retry (double-tap, network blip) of
      // the SAME attempt reuses this key and Stripe dedupes it into one charge.
      // Bucketed to a 30s window on the stable inputs so it's deterministic
      // across retries of one attempt but doesn't block a later, separate
      // purchase of the same product/size by the same customer.
      const idempotencyKey = boundIdempotencyKey(`direct:${normalizedEmail}:${productId}:${size}:${paymentMethodId}:${Math.floor(Date.now() / 30_000)}`);
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: priceCents,
          currency: 'usd',
          customer: stripeCustomerId,
          payment_method: paymentMethodId,
          off_session: false,
          confirm: true,
          receipt_email: email,
          description: `${product.name} (${size})`,
        },
        { idempotencyKey },
      );
    } catch (chargeErr) {
      if (pgTenantId && pgVariantId) await restockInventory(pgTenantId, pgVariantId, 1).catch(() => {});
      throw chargeErr;
    }

    if (paymentIntent.status !== 'succeeded') {
      // Roll back the Postgres reservation — the charge never went through,
      // so the unit is still available.
      if (pgTenantId && pgVariantId) await restockInventory(pgTenantId, pgVariantId, 1).catch(() => {});
      return NextResponse.json({ error: 'Payment not successful.' }, { status: 400 });
    }

    // Deduct inventory. The card is already charged at this point, so a
    // contended lock still falls back to an unlocked (best-effort) decrement
    // rather than silently leaving stock counts wrong.
    const decrementInventory = async () => {
      const inner = await getLiveProductState(redis, product, size);
      inner.inventoryRemaining = Math.max(0, Number(inner.inventoryRemaining || 0) - 1);
      inner.salesCompleted = (inner.salesCompleted || 0) + 1;
      await saveLiveState(redis, inner);
      return inner;
    };
    // NO Postgres decrement here. This route ALREADY decremented
    // inventory_levels PRE-CHARGE (decrementPostgresInventory above), which is
    // the correct place for it: it is the one path that can still refuse the
    // sale. Adding decrementForSale here as well double-decremented every
    // order -- caught by tracing the pre-charge gate, not by any test.
    //
    // The remaining write below is the KV live-state mirror only.
    const lockResult = await withRedisLock(redis, `inventory:${product.id}:${size}`, decrementInventory);
    // KV live-state mirror ONLY. The old "if (!lockResult.ok) await
    // decrementInventory()" unlocked fallback is GONE -- with a lock that
    // genuinely excludes, that branch would have become a live oversell path.
    if (!lockResult.ok) {
      console.error('[checkout/direct] KV live-state mirror skipped (lock contended) — Postgres already decremented', product.id, size);
    }

    // Archive the sale
    const customerIdForArchive = typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : (paymentIntent.customer?.id ?? 'n/a');

    const archiveRecord: ArchiveRecord = {
      email,
      variant: product.name,
      size,
      shippingAddress,
      id: customerIdForArchive,
      registeredAt: new Date().toISOString(),
      type: 'WINNER_CHARGED',
      shippingStatus: 'PENDING_FULFILLMENT',
      amountCents: priceCents,
      orderRef: buildOrderRef(email, String(productId), String(size), refPrefix),
      promoCode: promoCode || undefined,
    };
    await archiveEntry(redis, archiveRecord);

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      amount: priceCents / 100,
    });
  } catch (err: any) {
    console.error('[direct/route] Error:', err?.message || err);
    return NextResponse.json({ error: 'Payment could not be completed. Please try again.' }, { status: 500 });
  }
}