/**
 * TENANT CHECKOUT — a store other than the default one selling through its
 * OWN Stripe account (TENANCY.md phase 2, CONNECT.md §4–5).
 *
 * The default store's checkout (app/api/checkout/route.ts) is untouched; it is
 * welded to global KV state (raffle pools, promo codes, the ledger) that
 * belongs to that store. This is a separate, deliberately narrow path:
 *
 *   - INSTANT BUY ONLY. Raffles, waitlists and promo codes are refused for
 *     now: their state is still global (TENANCY.md T7, phases 3–4).
 *   - Catalog and stock: the tenant's own Postgres catalog, never KV (T8).
 *     Stock that cannot be read refuses the sale (fail closed).
 *   - Per-email cap: counted from THIS tenant's paid orders in Postgres.
 *   - The Checkout Session, its Customer and its PaymentIntent live on the
 *     merchant's connected account (direct charge), with our graduated fee as
 *     application_fee_amount, fixed at session creation (PRICING.md §6).
 *   - The order, the stock decrement and the fee record are written by the
 *     Connect webhook (handleConnectCheckoutCompleted), not here: nothing is
 *     recorded for a checkout nobody paid.
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { resolveStripeClient } from '@/services/payment/factory';
import { chargeRouteForTenant } from '@/lib/connect';
import { platformFeeForCharge, recordBillingCharge, setBillingRefund } from '@/lib/billing';
import { loadProducts } from '@/lib/server-config';
import { getSizeCheckoutMode, isConfiguredPrice } from '@/lib/storefront-config';
import { readLiveStock } from '@/lib/stock-gate';
import { resolveVariantId, decrementForSale } from '@/lib/inventory';
import { recordOrder } from '@/lib/order-write';
import { buildOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { boundIdempotencyKey } from '@/lib/idempotency-key';
import { isValidEmail } from '@/lib/validation';
import { validateShippingAddress } from '@/lib/address-validation';
import { encodeCartMetadata, decodeCartMetadata } from '@/lib/cart-metadata';
import { startTenantEntry } from '@/lib/tenant-drops';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** How many units of this product/size this email has already bought HERE. */
async function countTenantPurchases(tenantId: string, email: string, externalProductId: string, size: string): Promise<number> {
  const db = getDb();
  const customer = ((await db.select<any>('customers', {
    where: { tenant_id: eq(tenantId), email: eq(email) }, select: ['id'], limit: 1,
  })) as any[])[0];
  if (!customer) return 0;
  const orders = (await db.select<any>('orders', {
    where: { tenant_id: eq(tenantId), customer_id: eq(String(customer.id)), payment_status: eq('paid') }, select: ['id'],
  })) as any[];
  if (orders.length === 0) return 0;
  const variantId = await resolveVariantId(tenantId, externalProductId, size);
  // No variant means the cap can't be counted. The caller treats a throw as
  // "refuse the sale", never as "no purchases yet".
  if (!variantId) throw new Error('no variant for ' + externalProductId + '/' + size);
  const lines = (await db.select<any>('order_line_items', {
    where: { tenant_id: eq(tenantId), order_id: inList(orders.map((o) => String(o.id))), variant_id: eq(variantId) },
    select: ['quantity'],
  })) as any[];
  return lines.reduce((sum, l) => sum + Math.max(0, Number(l.quantity) || 0), 0);
}

async function tenantRefPrefix(tenantId: string, slug: string | null): Promise<string> {
  const row = ((await getDb().select<any>('tenant_store_config', {
    where: { tenant_id: eq(tenantId) }, select: ['config'], limit: 1,
  }).catch(() => [])) as any[])[0];
  const configured = row?.config?.refPrefix;
  // Never the default store's prefix: the store's own setting, else its slug.
  return normalizeRefPrefix(configured || slug || 'ORD');
}

/**
 * Start a hosted checkout for an instant-buy product on a connected merchant.
 * `origin` must come from the Host header (lib/storefront-tenant.ts, T5).
 */
export async function startTenantCheckout(input: {
  tenantId: string;
  tenantSlug: string | null;
  origin: string;
  body: Record<string, any>;
}): Promise<Response> {
  const { tenantId, tenantSlug, origin, body } = input;

  // T9: only a merchant Stripe has enabled can sell, on its own account.
  const route = await chargeRouteForTenant(tenantId);
  if (route.route !== 'connected') return json({ error: 'This store cannot take orders yet.' }, 409);
  const on = { stripeAccount: route.stripeAccount };

  const { productId, size, email, address, promoCode, ref } = body || {};
  if (!productId || !size || !email || !address) return json({ error: 'Missing fields' }, 400);
  if (!isValidEmail(email)) return json({ error: 'A valid email is required.' }, 400);
  const addrError = validateShippingAddress(String(address || ''));
  if (addrError) return json({ error: addrError }, 400);
  if (String(promoCode || ref || '').trim()) {
    return json({ error: "Promo codes aren't available in this store yet." }, 409);
  }
  const products = await loadProducts(null, { tenantId });
  const product = products[String(productId)];
  if (!product) return json({ error: 'Product not found' }, 404);

  // Raffle sizes, and instant-buy sizes whose product isn't on sale yet, are
  // ENTRIES: the card is saved on the merchant's account now and charged by a
  // draw or the waitlist later (lib/tenant-drops.ts, phase 4).
  const sizeMode = getSizeCheckoutMode(product, String(size));
  const waitlist = sizeMode === 'FCFS' && (String(body?.mode || '').toLowerCase() === 'waitlist' || product.isUpcoming === true);
  if (sizeMode === 'RAFFLE' || waitlist) {
    const priceCatForEntry = (product.priceCategories || []).find((c: any) => c.size === size);
    if (!priceCatForEntry || !isConfiguredPrice(priceCatForEntry.price)) return json({ error: 'Price not set for this size' }, 400);
    return startTenantEntry({
      tenantId, stripeAccount: route.stripeAccount, origin, product, size: String(size),
      email: String(email).trim().toLowerCase(), address: String(address), kind: sizeMode === 'RAFFLE' ? 'raffle' : 'waitlist',
    });
  }
  if (product.isActive !== true || product.isArchived === true || product.isUpcoming === true) {
    return json({ error: 'This product is not on sale.' }, 409);
  }
  const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
  if (!priceCat || !isConfiguredPrice(priceCat.price)) return json({ error: 'Price not set for this size' }, 400);
  if (getSizeCheckoutMode(product, String(size)) !== 'FCFS') {
    return json({ error: 'Only instant buy is available in this store for now.' }, 409);
  }
  const priceCents = Math.round(Number(priceCat.price) * 100);
  const normalizedEmail = String(email).trim().toLowerCase();

  const stock = readLiveStock(product, String(size));
  if (!stock.ok) {
    console.error('[tenant-checkout] stock for ' + tenantId + '/' + product.id + '/' + size + ' is ' + stock.reason + ' — refusing (fail closed)');
    return json({ error: 'Sold out for this size.' }, 409);
  }
  if (stock.stock <= 0) return json({ error: 'Sold out for this size.' }, 409);

  const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
  let bought: number;
  try {
    bought = await countTenantPurchases(tenantId, normalizedEmail, String(product.id), String(size));
  } catch (err) {
    console.error('[tenant-checkout] purchase cap unreadable — refusing (fail closed)', (err as Error)?.message || err);
    return json({ error: 'Checkout could not be started. Please try again.' }, 503);
  }
  if (bought >= maxPerEmail) return json({ error: `Purchase limit reached (${maxPerEmail} per email).` }, 409);

  const stripe: any = await resolveStripeClient();
  if (!stripe) return json({ error: 'Payment provider is not configured.' }, 500);

  // The merchant's own currency (Stripe derives it from their country).
  const account = await stripe.v2.core.accounts.retrieve(route.stripeAccount, { include: ['defaults'] });
  const currency = String(account?.defaults?.currency || '').toLowerCase();
  if (!currency) return json({ error: 'This store cannot take orders yet.' }, 409);

  // Fixed now, from the month's running total as it stands (PRICING.md §6).
  const fee = await platformFeeForCharge(tenantId, priceCents);

  const existing = await stripe.customers.list({ email: normalizedEmail, limit: 1 }, on);
  const customer = existing.data[0] || await stripe.customers.create({ email: normalizedEmail }, on);

  // One attempt per 30s window: a double tap reuses the same session (same
  // key, same params), and the ref is derived from the same window so a
  // Stripe retry of this call is byte-identical.
  const window = String(Math.floor(Date.now() / 30_000));
  const orderRef = buildOrderRef(normalizedEmail, String(product.id), String(size), await tenantRefPrefix(tenantId, tenantSlug), window);
  const productSlug = String(product.slug || product.id);
  const metadata = {
    tenant_id: tenantId,
    productId: String(product.id),
    productSlug,
    variant: String(product.name || ''),
    size: String(size),
    email: normalizedEmail,
    address: String(address).slice(0, 480),
    orderRef,
    entryType: 'direct',
    platform_fee_cents: String(fee.feeCents),
    platform_fee_basis: fee.basis,
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customer.id,
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: priceCents,
        product_data: {
          name: `${product.name} - ${size}`,
          ...(product.tagline || product.desc ? { description: String(product.tagline || product.desc).slice(0, 300) } : {}),
        },
      },
    }],
    payment_intent_data: {
      ...(fee.feeCents > 0 ? { application_fee_amount: fee.feeCents } : {}),
      receipt_email: normalizedEmail,
      // Carried onto the charge, so refunds pass the Connect webhook's guard.
      metadata: { tenant_id: tenantId, orderRef, productId: String(product.id), size: String(size) },
    },
    success_url: `${origin}/${productSlug}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${productSlug}?purchase=cancel`,
    metadata,
  }, { ...on, idempotencyKey: boundIdempotencyKey(`tenant-checkout:${route.stripeAccount}:${normalizedEmail}:${product.id}:${size}:${window}`) });

  return json({ url: session.url, sessionId: session.id });
}

/**
 * checkout.session.completed on a merchant's account (already past the
 * Connect webhook's tenant guard). Order first, then the fee record, then
 * stock: the first two are idempotent, so a throw before the decrement is
 * safely retried by Stripe; the decrement is not idempotent, so it runs last
 * and never throws.
 */
export async function handleConnectCheckoutCompleted(session: any, tenantId: string, account: string): Promise<{ handled: boolean; note: string }> {
  const md = session?.metadata || {};
  const kind = md.entryType === 'direct' ? 'direct' : md.entryType === 'cart' ? 'cart' : null;
  if (session?.mode !== 'payment' || !kind) return { handled: false, note: 'not an instant-buy or cart session' };
  if (session.payment_status !== 'paid') return { handled: false, note: 'payment_status ' + session.payment_status };

  const stripe: any = await resolveStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!piId) throw new Error('paid session ' + session.id + ' has no PaymentIntent');
  // The fee actually charged, from Stripe — not our metadata.
  const pi = await stripe.paymentIntents.retrieve(piId, {}, { stripeAccount: account });
  const feeCents = Math.max(0, Number(pi.application_fee_amount || 0));
  const amountCents = Math.max(0, Number(session.amount_total || 0));

  // WHAT was sold. A cart is ONE order with every line (lib/order-write.ts).
  let lines: Array<{ externalProductId: string; productName: string; size: string; quantity: number; amountCents: number }>;
  if (kind === 'direct') {
    lines = [{ externalProductId: String(md.productId || ''), productName: String(md.variant || ''), size: String(md.size || ''), quantity: 1, amountCents }];
  } else {
    const decoded = decodeCartMetadata(md);
    if (!decoded || decoded.length === 0) {
      // Never lose the payment: record it as one line for what was charged, loudly.
      console.error('[connect-webhook] CART LINES UNREADABLE for paid session ' + session.id + ' (tenant ' + tenantId +
        ') — recording ' + amountCents + ' as a single unattributed line; stock NOT decremented. Reconcile by hand.');
      lines = [{ externalProductId: '', productName: 'Cart (lines unreadable)', size: '', quantity: 1, amountCents }];
    } else {
      const products = await loadProducts(null, { tenantId }).catch(() => ({} as Record<string, any>));
      lines = decoded.map((l) => ({
        externalProductId: l.productId,
        productName: String(products[l.productId]?.name || l.productId),
        size: l.size,
        quantity: l.quantity,
        amountCents: l.unitCents * l.quantity,
      }));
      const sum = lines.reduce((s, l) => s + l.amountCents, 0);
      if (sum !== amountCents) {
        console.error('[connect-webhook] cart ' + session.id + ': lines total ' + sum + ' but Stripe charged ' + amountCents + ' — recorded as charged; reconcile');
      }
    }
  }

  const recorded = await recordOrder({
    tenantId,
    orderRef: String(md.orderRef || 'CONNECT-' + session.id),
    email: String(md.email || session.customer_details?.email || ''),
    lines,
    checkoutMode: 'fcfs',
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
    stripePaymentIntentId: piId,
    currency: String(session.currency || ''),
    platformFeeCents: feeCents,
  });
  // Retry rather than acknowledge a payment with no order behind it.
  if (!recorded.ok) throw new Error('CHARGED BUT NOT RECORDED ' + session.id + ': ' + recorded.message);

  // Volume is what Stripe charged, not our line arithmetic.
  const billing = await recordBillingCharge({ paymentIntentId: piId, tenantId, volumeCents: amountCents, feeCents, orderId: recorded.orderId });

  // Stock last: not idempotent, so it must never be reached twice (the claim
  // is completed right after) and never throws.
  const stockNotes: string[] = [];
  for (const l of lines) {
    if (!l.externalProductId) { stockNotes.push('unattributed line: not decremented'); continue; }
    const r = await decrementForSale({
      tenantId, externalProductId: l.externalProductId, size: l.size, quantity: l.quantity, context: 'connect-webhook',
    }).catch((err) => ({ ok: false, remaining: null, reason: (err as Error)?.message || String(err) }));
    stockNotes.push(l.externalProductId + '/' + l.size + ' x' + l.quantity + (r.ok ? ' decremented' : ' NOT decremented: ' + r.reason));
  }

  return {
    handled: true,
    note: kind + ' order ' + recorded.orderId + ' (' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + '), fee ' + feeCents +
      (billing.recorded ? '' : ' (billing already recorded)') + ', stock: ' + stockNotes.join('; '),
  };
}

/**
 * charge.refunded on a merchant's account: D5 — the fee on that sale comes
 * back exactly. A refund from the merchant's own Stripe Dashboard does not
 * return our application fee, so it is returned here, in proportion to what
 * was refunded (all of it on a full refund). Cumulative and keyed by the
 * target, so a redelivered event refunds nothing twice.
 */
export async function handleConnectChargeRefunded(charge: any, account: string): Promise<{ handled: boolean; note: string }> {
  const stripe: any = await resolveStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  const amount = Math.max(0, Number(charge.amount || 0));
  const refunded = Math.max(0, Number(charge.amount_refunded || 0));
  let feeRefunded = 0;
  const feeId = typeof charge.application_fee === 'string' ? charge.application_fee : charge.application_fee?.id;
  if (feeId) {
    const fee = await stripe.applicationFees.retrieve(feeId);
    const target = refunded >= amount ? fee.amount : Math.round((fee.amount * refunded) / Math.max(1, amount));
    const delta = target - Number(fee.amount_refunded || 0);
    if (delta > 0) {
      await stripe.applicationFees.createRefund(feeId, { amount: delta }, { idempotencyKey: 'fee-refund:' + feeId + ':' + target });
    }
    feeRefunded = Math.max(target, Number(fee.amount_refunded || 0));
  }
  const ok = piId ? await setBillingRefund(piId, refunded, feeRefunded) : false;
  if (!ok) console.error('[connect-webhook] refund on ' + account + ' charge ' + charge.id + ' had no recorded billing charge — reconcile');
  return { handled: true, note: 'refunded ' + refunded + '/' + amount + ', fee returned ' + feeRefunded + (ok ? '' : ' (no billing row)') };
}

// ── CART (TENANCY.md phase 3) ──────────────────────────────────────────────
//
// One hosted checkout for the whole bag, on the merchant's account, with our
// fee on the cart total; one order with every line, written by the webhook
// (handleConnectCheckoutCompleted). Instant-buy lines only: raffle lines and
// promo codes are refused, like the single-product path.

type CartLine = { productId: string; size: string; quantity: number; unitCents: number; name: string };

export async function startTenantCartCheckout(input: {
  tenantId: string;
  tenantSlug: string | null;
  origin: string;
  body: Record<string, any>;
}): Promise<Response> {
  const { tenantId, tenantSlug, origin, body } = input;
  const route = await chargeRouteForTenant(tenantId);
  if (route.route !== 'connected') return json({ error: 'This store cannot take orders yet.' }, 409);
  const on = { stripeAccount: route.stripeAccount };

  const email = String(body?.email || '').trim().toLowerCase();
  const address = String(body?.address || '').trim();
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!email || !address || items.length === 0) return json({ error: 'Missing checkout details.' }, 400);
  if (!isValidEmail(email)) return json({ error: 'A valid email is required.' }, 400);
  if (items.length > 50) return json({ error: 'Too many items in the cart.' }, 400);
  const addrError = validateShippingAddress(address);
  if (addrError) return json({ error: addrError }, 400);
  if (String(body?.promoCode || body?.ref || '').trim()) {
    return json({ error: "Promo codes aren't available in this store yet. Remove it to continue." }, 409);
  }

  // One line per product/size, quantities summed.
  const agg = new Map<string, { productId: string; size: string; quantity: number }>();
  for (const it of items) {
    const productId = String(it?.productId || '').trim();
    const size = String(it?.size || '').trim();
    if (!productId || !size) continue;
    const q = Math.max(1, Math.floor(Number(it?.quantity || 1) || 1));
    const k = productId + '|' + size;
    const prev = agg.get(k);
    if (prev) prev.quantity += q; else agg.set(k, { productId, size, quantity: q });
  }
  if (agg.size === 0) return json({ error: 'Cart is empty.' }, 400);

  const products = await loadProducts(null, { tenantId });
  const lines: CartLine[] = [];
  for (const item of agg.values()) {
    const product = products[item.productId];
    if (!product) return json({ error: 'A cart item no longer exists.' }, 404);
    if (product.isActive !== true || product.isArchived === true || product.isUpcoming === true) {
      return json({ error: `${product.name} is not on sale.` }, 409);
    }
    const cat = (product.priceCategories || []).find((c: any) => String(c.size) === item.size);
    if (!cat || !isConfiguredPrice(cat.price)) return json({ error: `Price missing for ${product.name} (${item.size}).` }, 400);
    if (getSizeCheckoutMode(product, item.size) !== 'FCFS') {
      return json({ error: `${product.name} (${item.size}) is a raffle entry; only instant-buy items can be checked out in this store for now.` }, 409);
    }
    const stock = readLiveStock(product, item.size);
    if (!stock.ok) {
      console.error('[tenant-cart] stock for ' + tenantId + '/' + product.id + '/' + item.size + ' is ' + stock.reason + ' — refusing (fail closed)');
      return json({ error: `${product.name} (${item.size}) is sold out.` }, 409);
    }
    if (stock.stock < item.quantity) return json({ error: `Only ${Math.max(0, stock.stock)} of ${product.name} (${item.size}) left.` }, 409);
    const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
    let bought: number;
    try {
      bought = await countTenantPurchases(tenantId, email, String(product.id), item.size);
    } catch (err) {
      console.error('[tenant-cart] purchase cap unreadable — refusing (fail closed)', (err as Error)?.message || err);
      return json({ error: 'Checkout could not be started. Please try again.' }, 503);
    }
    if (bought + item.quantity > maxPerEmail) return json({ error: `${product.name} limit is ${maxPerEmail} per email.` }, 409);
    lines.push({ productId: String(product.id), size: item.size, quantity: item.quantity, unitCents: Math.round(Number(cat.price) * 100), name: String(product.name || product.id) });
  }

  const cartMd = encodeCartMetadata(lines);
  if (!cartMd) return json({ error: 'Too many different items for one checkout. Split the order.' }, 400);
  const totalCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);

  const stripe: any = await resolveStripeClient();
  if (!stripe) return json({ error: 'Payment provider is not configured.' }, 500);
  const account = await stripe.v2.core.accounts.retrieve(route.stripeAccount, { include: ['defaults'] });
  const currency = String(account?.defaults?.currency || '').toLowerCase();
  if (!currency) return json({ error: 'This store cannot take orders yet.' }, 409);

  // Fixed now, on the whole cart, from the month's running total (PRICING §6).
  const fee = await platformFeeForCharge(tenantId, totalCents);

  const existing = await stripe.customers.list({ email, limit: 1 }, on);
  const customer = existing.data[0] || await stripe.customers.create({ email }, on);

  // Same 30s-window idempotency as the single-product path: a double tap
  // reuses one session, and the ref is derived from the same inputs.
  const window = String(Math.floor(Date.now() / 30_000));
  const cartSignature = lines.map((l) => l.productId + ':' + l.size + ':' + l.quantity).sort().join('|');
  const orderRef = buildOrderRef(email, lines[0].productId, lines[0].size, await tenantRefPrefix(tenantId, tenantSlug), cartSignature + ':' + window);
  const returnSlug = String(products[lines[0].productId]?.slug || lines[0].productId);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customer.id,
    payment_method_types: ['card'],
    line_items: lines.map((l) => ({
      quantity: l.quantity,
      price_data: { currency, unit_amount: l.unitCents, product_data: { name: `${l.name} - ${l.size}` } },
    })),
    payment_intent_data: {
      ...(fee.feeCents > 0 ? { application_fee_amount: fee.feeCents } : {}),
      receipt_email: email,
      // Carried onto the charge, so refunds pass the Connect webhook's guard.
      metadata: { tenant_id: tenantId, orderRef, checkoutType: 'cart' },
    },
    success_url: `${origin}/${returnSlug}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${returnSlug}?purchase=cancel`,
    metadata: {
      tenant_id: tenantId,
      entryType: 'cart',
      checkoutType: 'cart',
      email,
      address: address.slice(0, 480),
      orderRef,
      platform_fee_cents: String(fee.feeCents),
      platform_fee_basis: fee.basis,
      ...cartMd,
    },
  }, { ...on, idempotencyKey: boundIdempotencyKey(`tenant-cart:${route.stripeAccount}:${email}:${cartSignature}:${window}`) });

  return json({ url: session.url, sessionId: session.id });
}
