/**
 * TENANT DROPS — raffles and waitlists for a store other than the default one
 * (TENANCY.md phase 4, CONNECT.md §4). Everything here is on the merchant's
 * OWN Stripe account and in the tenant-scoped Postgres tables; nothing touches
 * the global KV pools the original store's engines use (T7).
 *
 *   ENTRY    A Stripe `mode: 'setup'` session on the merchant's account saves
 *            the card there. The entry is recorded (raffle_entries, with the
 *            card's account and the entry type, 00035) by BOTH the Connect
 *            webhook and the page's confirm step — idempotently, so whichever
 *            runs first records it and the other finds it.
 *   DRAW     Once per variant per draw date (an atomic claim), after the
 *            date: winners are selected from pending RAFFLE entries, then each
 *            is charged on the account its card lives on (lib/saved-card-
 *            route.ts), with our fee; order, billing, stock follow. A declined
 *            winner goes back to the pool (the original store's behaviour).
 *   WAITLIST When the product is on sale, pending WAITLIST entries are
 *            charged oldest first, up to the stock there is.
 *
 * Each charge runs under its own claim (scope tenant_charge, keyed by the
 * entry), so two simultaneous triggers can't charge or decrement twice; the
 * Stripe idempotency key is per entry as a second line of defence.
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { resolveStripeClient } from '@/services/payment/factory';
import { chargeRouteForTenant } from '@/lib/connect';
import { platformFeeForCharge, recordBillingCharge } from '@/lib/billing';
import { loadProducts } from '@/lib/server-config';
import { getSizeCheckoutMode } from '@/lib/storefront-config';
import { resolveSizeReleaseEndsAt } from '@/lib/size-configs';
import { dropTimestampToMs } from '@/lib/drop-timestamps';
import { readLiveStock } from '@/lib/stock-gate';
import { resolveVariantId, decrementForSale } from '@/lib/inventory';
import { recordOrder } from '@/lib/order-write';
import { buildOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { boundIdempotencyKey } from '@/lib/idempotency-key';
import { ensureCustomer, stripeCustomerIdFor } from '@/lib/customers';
import { createRaffleEntry, findPendingEntryId, executeDraw, markRaffleEntryOutcome, rollDeclinedEntryBackToPool } from '@/lib/raffle';
import { claimWebhookKey, completeWebhookKey, releaseWebhookKey } from '@/lib/webhook-dedupe';
import { savedCardChargeRoute } from '@/lib/saved-card-route';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { subrequestCount, SUBREQUEST_LIMIT_FREE } from '@/lib/subrequest-meter';
import { sendStoreEmailOnce, renderEntryReceived, renderEntryCharged, STORE_EMAIL_CALLS } from '@/lib/tenant-email';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Kind = 'raffle' | 'waitlist';

// ── Schema gate (00035) ────────────────────────────────────────────────────

let schemaOkAt = 0;
/** Both 00035 columns exist. Until they do, merchant entries are refused at the
 *  door: a card must never be saved without its account being recorded. */
export async function raffleSchemaReady(): Promise<boolean> {
  if (Date.now() - schemaOkAt < 60_000) return true;
  try {
    await getDb().select('raffle_entries', { select: ['stripe_account', 'entry_type'], limit: 1 });
    schemaOkAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function tenantConfig(tenantId: string): Promise<Record<string, any>> {
  const row = ((await getDb().select<any>('tenant_store_config', {
    where: { tenant_id: eq(tenantId) }, select: ['config'], limit: 1,
  }).catch(() => [])) as any[])[0];
  return (row?.config || {}) as Record<string, any>;
}

function storeTimezone(config: Record<string, any>): string {
  return String(config?.dropSchedule?.timezone || (GOYUNIR_STORE_SUITE as any).dropSchedule?.timezone || 'America/Los_Angeles');
}

/** When this size's draw happens, in ms, or null if it has no draw date. */
function drawAtMs(product: any, size: string, tz: string): number | null {
  return dropTimestampToMs(resolveSizeReleaseEndsAt(product, size), tz);
}

// ── Entry ──────────────────────────────────────────────────────────────────

/**
 * A raffle or waitlist entry on a connected merchant: a card-save page on the
 * MERCHANT's account. Called by startTenantCheckout for a raffle size, or an
 * instant-buy size whose product is not on sale yet (waitlist).
 */
export async function startTenantEntry(input: {
  tenantId: string;
  stripeAccount: string;
  origin: string;
  product: any;
  size: string;
  email: string;
  address: string;
  kind: Kind;
}): Promise<Response> {
  const { tenantId, stripeAccount, origin, product, size, email, address, kind } = input;
  if (!(await raffleSchemaReady())) {
    return json({ error: kind === 'raffle' ? "Raffle entries aren't open in this store yet." : "Waitlists aren't open in this store yet." }, 409);
  }
  const config = await tenantConfig(tenantId);
  if (kind === 'raffle') {
    if (product.isActive !== true || product.isArchived === true || product.isUpcoming === true) {
      return json({ error: 'This raffle is not open.' }, 409);
    }
    const at = drawAtMs(product, size, storeTimezone(config));
    if (at === null) return json({ error: 'This raffle has no draw date yet.' }, 409);
    if (at <= Date.now()) return json({ error: 'Entries for this draw have closed.' }, 409);
  } else if (product.isUpcoming !== true || product.isArchived === true) {
    return json({ error: 'This product is not taking waitlist entries.' }, 409);
  }

  const variantId = await resolveVariantId(tenantId, String(product.id), size);
  if (!variantId) return json({ error: 'This size is not available.' }, 409);
  if (await findPendingEntryId(tenantId, variantId, email)) {
    return json({
      error: kind === 'raffle' ? `You're already entered for ${product.name} (${size}).` : `You're already on the waitlist for ${product.name} (${size}).`,
      alreadyEntered: true,
      code: 'DUPLICATE_BLOCKED',
    });
  }

  const stripe: any = await resolveStripeClient();
  if (!stripe) return json({ error: 'Payment provider is not configured.' }, 500);
  const on = { stripeAccount };
  const existing = await stripe.customers.list({ email, limit: 1 }, on);
  const customer = existing.data[0] || await stripe.customers.create({ email }, on);
  const productSlug = String(product.slug || product.id);
  const metadata = {
    tenant_id: tenantId,
    entryType: kind,
    productId: String(product.id),
    productSlug,
    variant: String(product.name || ''),
    size,
    email,
    address: address.slice(0, 480),
  };
  const window = String(Math.floor(Date.now() / 30_000));
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customer.id,
    payment_method_types: ['card'],
    setup_intent_data: { metadata },
    success_url: `${origin}/${productSlug}?setup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${productSlug}?setup=cancel`,
    metadata,
  }, { ...on, idempotencyKey: boundIdempotencyKey(`tenant-entry:${stripeAccount}:${email}:${product.id}:${size}:${window}`) });
  return json({ url: session.url, sessionId: session.id });
}

/**
 * Record the entry a completed card-save session stands for. Idempotent: the
 * Connect webhook and the page's confirm step both call it. Throws when it
 * cannot record yet (the webhook then retries) — an entry is never dropped.
 */
export async function recordTenantEntryFromSetupSession(session: any, tenantId: string, stripeAccount: string): Promise<{
  handled: boolean; kind?: Kind; entryId?: string; alreadyEntered?: boolean; note: string; afterCommit?: () => Promise<string>;
}> {
  const md = session?.metadata || {};
  const kind: Kind | null = md.entryType === 'raffle' ? 'raffle' : md.entryType === 'waitlist' ? 'waitlist' : null;
  if (session?.mode !== 'setup' || !kind) return { handled: false, note: 'not an entry session' };
  if (session.status !== 'complete') return { handled: false, note: 'session ' + session.status };
  if (!(await raffleSchemaReady())) throw new Error('00035 not applied — cannot record the entry yet');

  const stripe: any = await resolveStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  const si = await stripe.setupIntents.retrieve(String(siId), {}, { stripeAccount });
  const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (si.status !== 'succeeded' || !pm) throw new Error('setup intent ' + siId + ' is ' + si.status);

  const variantId = await resolveVariantId(tenantId, String(md.productId || ''), String(md.size || ''));
  if (!variantId) {
    console.error('[tenant-drops] ENTRY NOT RECORDED — no variant for ' + md.productId + '/' + md.size + ' (session ' + session.id + '); the card is saved on ' + stripeAccount);
    return { handled: true, kind, note: 'no variant' };
  }
  const email = String(md.email || '').trim().toLowerCase();
  const customerId = await ensureCustomer(tenantId, email, typeof session.customer === 'string' ? session.customer : null);
  const created = await createRaffleEntry({
    tenantId, variantId, customerId, email,
    paymentMethodRef: pm,
    shippingAddress: String(md.address || '') || null,
    stripeAccount,
    entryType: kind,
  });
  if (created.ok) {
    return {
      handled: true, kind, entryId: created.entryId, note: kind + ' entry recorded',
      // Only a NEW entry is confirmed by email (the webhook and the page both
      // call this; exactly one creates it). The caller runs it after its own
      // bookkeeping is done; it never throws.
      afterCommit: async () => (await sendStoreEmailOnce({
        tenantId, kind: 'entry', key: String(created.entryId), to: email,
        build: (store) => renderEntryReceived(store, { kind, product: String(md.variant || ''), size: String(md.size || '') }),
      })).status,
    };
  }
  if (created.reason === 'already_entered') {
    // The same session recorded by the other path, or a genuine second entry.
    const pendingId = await findPendingEntryId(tenantId, variantId, email);
    const row = pendingId ? ((await getDb().select<any>('raffle_entries', { where: { id: eq(pendingId) }, select: ['payment_method_ref'], limit: 1 })) as any[])[0] : null;
    const same = row?.payment_method_ref === pm;
    return { handled: true, kind, entryId: pendingId || undefined, alreadyEntered: !same, note: same ? 'already recorded' : 'already entered' };
  }
  throw new Error('entry not recorded: ' + (created.error || created.reason));
}

// ── Budget ───────────────────────────────────────────────────────────────────
//
// A Worker invocation has a hard ceiling of outbound calls (50 on the free
// plan, 1000 on paid). The first live draw ran straight into it: cards were
// charged and then the order, billing or stock write failed with "Too many
// subrequests by single Worker invocation" (2026-09-26). So a run spends a
// BUDGET: a charge is only started if a whole charge still fits, and anything
// left is reported as `more` for the next trigger. Database calls are counted
// by the meter (lib/subrequest-meter.ts); Stripe calls are counted here.

// Measured worst case of one chargeEntry, with margin. The customer's email
// is NOT in here: it is sent by the run's email pass (sendDueChargeEmails)
// with whatever budget is left, so an email can never starve a charge. (It
// was once added here, 28 -> 35, and on the 50-call plan no run could afford
// a single charge any more: every trigger deferred. Caught by the live proof.)
const PER_CHARGE_CALLS = 28;
const SAFETY_CALLS = 4;

class Budget {
  /** From the start of the INVOCATION when given: a caller that already spent
   *  calls (the scheduler runs the original store's engine first) must not
   *  hand this run a budget that is partly gone. */
  constructor(private readonly startDb: number = subrequestCount()) {}
  private stripeCalls = 0;
  readonly limit = Math.max(20, Number(process.env.WORKER_SUBREQUEST_LIMIT) || SUBREQUEST_LIMIT_FREE);
  stripe(n = 1) { this.stripeCalls += n; }
  used() { return subrequestCount() - this.startDb + this.stripeCalls; }
  canAffordCharge() { return this.canAfford(PER_CHARGE_CALLS); }
  canAfford(calls: number) { return this.used() + calls <= this.limit - SAFETY_CALLS; }
}

/** A Stripe card error: the only failure that means "declined". Anything else
 *  (network, the call ceiling) must be retried, never recorded as a decline. */
function isCardDecline(err: any): boolean {
  return err?.type === 'StripeCardError' || err?.rawType === 'card_error' || err?.raw?.type === 'card_error';
}

// ── Charging a saved card ───────────────────────────────────────────────────

type VariantInfo = { variantId: string; productId: string; productName: string; size: string; priceCents: number };
type ChargeResult = { entryId: string; status: 'charged' | 'declined' | 'skipped' | 'deferred'; note: string; calls?: number };

/**
 * Charge one entry's saved card, then write order, billing and stock — every
 * step safe to REPEAT, so a run that dies part-way is repaired by the next:
 *   the charge   Stripe idempotency key per attempt (same PaymentIntent back)
 *   the order    upsert on (tenant, order_ref); the ref is derived from the entry
 *   billing      one row per PaymentIntent (primary key)
 *   stock        its own claim per attempt (tenant_stock): decremented once
 *   the entry    marked 'charged' LAST, and only then is the claim completed
 * Any failure after the charge throws, leaving the claim to be retried (it
 * is released, or reclaimable after 5 minutes if even that fails). Only a
 * Stripe CARD error marks the entry declined.
 */
async function chargeEntry(input: {
  tenantId: string; tenantSlug: string | null; storeAccount: string; currency: string; entry: any; variant: VariantInfo; kind: Kind; budget: Budget;
}): Promise<ChargeResult> {
  const { tenantId, tenantSlug, storeAccount, currency, entry, variant, kind, budget } = input;
  const entryId = String(entry.id);
  if (!budget.canAffordCharge()) return { entryId, status: 'deferred', note: 'call budget spent — next trigger' };
  const before = budget.used();
  // Keyed by the entry AND the moment it was selected: a declined raffle winner
  // goes back to the pool and may win a later draw, which must be chargeable
  // (a key on the entry alone would read 'already done' forever, and Stripe
  // would replay the old decline for 24h). A waitlist entry converts once.
  const attempt = kind === 'raffle' ? entryId + ':' + String(entry.decided_at || '') : entryId;
  const claim = await claimWebhookKey('tenant_charge', attempt);
  if (claim === 'duplicate') return { entryId, status: 'skipped', note: 'in progress or done elsewhere' };
  try {
    const route = savedCardChargeRoute({ entryAccount: entry.stripe_account, isDefaultStore: false, storeAccount });
    const customerId = entry.customer_id ? await stripeCustomerIdFor(tenantId, String(entry.customer_id)) : null;
    const pm = String(entry.payment_method_ref || '');
    const stripe: any = await resolveStripeClient();
    if (!route.ok || !customerId || !pm || !stripe) {
      const why = !route.ok ? route.reason : !customerId ? 'no Stripe customer' : !pm ? 'no saved card' : 'Stripe not configured';
      console.error('[tenant-drops] ' + kind + ' entry ' + entryId + ' NOT CHARGED — ' + why);
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      if (kind === 'raffle') await rollDeclinedEntryBackToPool(tenantId, entryId);
      await completeWebhookKey('tenant_charge', attempt);
      return { entryId, status: 'declined', note: why, calls: budget.used() - before };
    }
    const email = String(entry.email || '');
    const orderRef = buildOrderRef(email, variant.productId, variant.size, normalizeRefPrefix(tenantSlug || 'ORD'), entryId);
    const fee = await platformFeeForCharge(tenantId, variant.priceCents);
    let pi: any;
    try {
      budget.stripe();
      pi = await stripe.paymentIntents.create({
        amount: variant.priceCents,
        currency,
        customer: customerId,
        payment_method: pm,
        off_session: true,
        confirm: true,
        receipt_email: email || undefined,
        description: `${variant.productName} (${variant.size})`,
        ...(fee.feeCents > 0 ? { application_fee_amount: fee.feeCents } : {}),
        metadata: { tenant_id: tenantId, entry_id: entryId, entryType: kind, orderRef },
      }, { stripeAccount: route.stripeAccount!, idempotencyKey: boundIdempotencyKey(`tenant-${kind}:${attempt}`) });
    } catch (err: any) {
      if (!isCardDecline(err)) throw err; // not a decline: retry, never "declined"
      const msg = err?.raw?.message || err?.message || String(err);
      console.error('[tenant-drops] ' + kind + ' entry ' + entryId + ' declined: ' + msg);
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      if (kind === 'raffle') await rollDeclinedEntryBackToPool(tenantId, entryId);
      await completeWebhookKey('tenant_charge', attempt);
      return { entryId, status: 'declined', note: msg, calls: budget.used() - before };
    }
    if (pi.status !== 'succeeded') throw new Error('PaymentIntent ' + pi.id + ' is ' + pi.status);
    const feeCharged = Number(pi.application_fee_amount || 0);

    const recorded = await recordOrder({
      tenantId, orderRef, email,
      externalProductId: variant.productId, productName: variant.productName, size: variant.size, quantity: 1,
      amountCents: variant.priceCents,
      checkoutMode: kind === 'raffle' ? 'raffle' : 'waitlist',
      stripeCustomerId: customerId,
      stripePaymentIntentId: pi.id,
      currency,
      platformFeeCents: feeCharged,
    });
    if (!recorded.ok) throw new Error('CHARGED BUT NOT RECORDED (will retry) — entry ' + entryId + ' pi ' + pi.id + ': ' + recorded.message);
    await recordBillingCharge({ paymentIntentId: pi.id, tenantId, volumeCents: variant.priceCents, feeCents: feeCharged, orderId: recorded.orderId });

    // Stock exactly once per attempt, however many times this is retried.
    const stockClaim = await claimWebhookKey('tenant_stock', attempt);
    if (stockClaim !== 'duplicate') {
      const r = await decrementForSale({ tenantId, externalProductId: variant.productId, size: variant.size, quantity: 1, context: 'tenant-' + kind });
      if (!r.ok && r.reason !== 'insufficient_stock') {
        await releaseWebhookKey('tenant_stock', attempt).catch(() => {});
        throw new Error('stock not decremented (will retry): ' + r.reason);
      }
      await completeWebhookKey('tenant_stock', attempt);
    }

    await markRaffleEntryOutcome(tenantId, entryId, 'charged');
    // The customer's "you won / it's yours" email is DUE: recorded here (one
    // insert), sent by the run's email pass with leftover budget, or by the
    // next run. Never inside the charge, never able to fail it.
    await claimWebhookKey(chargeEmailScope(tenantId), entryId).catch((err) =>
      console.error('[tenant-drops] could not mark the charged email due for ' + entryId, (err as Error)?.message || err));
    await completeWebhookKey('tenant_charge', attempt);
    return { entryId, status: 'charged', note: 'pi ' + pi.id + ', fee ' + feeCharged + ', order ' + orderRef, calls: budget.used() - before };
  } catch (err) {
    await releaseWebhookKey('tenant_charge', attempt).catch(() => {});
    console.error('[tenant-drops] ' + kind + ' entry ' + entryId + ' incomplete, will retry: ' + ((err as Error)?.message || err));
    throw err;
  }
}

// ── The customer's email for a charge ───────────────────────────────────────

/** Per-store marker scope: key = entry id, 'claimed' = the email is due. */
const chargeEmailScope = (tenantId: string) => 'tenant_email_due:' + tenantId;

/**
 * Send the "you won / it's yours" emails that are DUE for this store, with the
 * budget the run has left (charges always come first). Only entries charged
 * since this existed have a marker, so older charges are never emailed. The
 * amount and order come from the recorded order, not today's price. Sent,
 * already-sent or undeliverable = marker done; a transient failure stays due.
 */
async function sendDueChargeEmails(tenantId: string, tenantSlug: string | null, budget: Budget, infoByVariant: Map<string, VariantInfo>): Promise<number> {
  const scope = chargeEmailScope(tenantId);
  if (!budget.canAfford(2 + STORE_EMAIL_CALLS)) return 0;
  const due = (await getDb().select<any>('webhook_dedupe', { where: { scope: eq(scope), status: eq('claimed') }, select: ['dedupe_key'], limit: 20 })) as any[];
  if (due.length === 0) return 0;
  const entries = (await getDb().select<any>('raffle_entries', {
    where: { tenant_id: eq(tenantId), id: inList(due.map((d) => String(d.dedupe_key))) }, select: ['id', 'email', 'entry_type', 'variant_id', 'status'],
  })) as any[];
  const byId = new Map(entries.map((e) => [String(e.id), e]));
  const refFor = (e: any, v: VariantInfo) => buildOrderRef(String(e.email || ''), v.productId, v.size, normalizeRefPrefix(tenantSlug || 'ORD'), String(e.id));
  const refs = entries.map((e) => { const v = infoByVariant.get(String(e.variant_id)); return v ? refFor(e, v) : ''; }).filter(Boolean);
  const orders = refs.length === 0 ? [] : (await getDb().select<any>('orders', {
    where: { tenant_id: eq(tenantId), order_ref: inList(refs) }, select: ['order_ref', 'total_cents', 'currency'],
  })) as any[];
  const orderOf = new Map(orders.map((o) => [String(o.order_ref), o]));
  let sent = 0;
  for (const d of due) {
    const entryId = String(d.dedupe_key);
    const e = byId.get(entryId);
    const v = e ? infoByVariant.get(String(e.variant_id)) : undefined;
    const order = e && v ? orderOf.get(refFor(e, v)) : undefined;
    if (!e || e.status !== 'charged' || !v || !order) {
      // Nothing to say (entry gone, product gone, or no order): not due any more.
      await completeWebhookKey(scope, entryId);
      continue;
    }
    if (!budget.canAfford(STORE_EMAIL_CALLS + 1)) break;
    budget.stripe(1); // the email provider call is not metered
    const kind: Kind = e.entry_type === 'waitlist' ? 'waitlist' : 'raffle';
    const m = await sendStoreEmailOnce({
      tenantId, kind: 'charged', key: entryId, to: String(e.email || ''),
      build: (store) => renderEntryCharged(store, { kind, product: v.productName, size: v.size, amountCents: Number(order.total_cents), currency: String(order.currency || ''), orderRef: String(order.order_ref) }),
    });
    if (m.status !== 'failed') await completeWebhookKey(scope, entryId);
    if (m.status === 'sent') sent += 1;
  }
  return sent;
}

// ── Draws and waitlist conversion ───────────────────────────────────────────

export type TenantDropRun = { tenantId: string; draws: any[]; waitlist: any[]; more: boolean; calls: number; skipped?: string; emails?: number };

/**
 * Run whatever is DUE for this store, within this invocation's call budget:
 * raffle draws whose date has passed (once per variant per date), charging
 * of selected winners (including any a crashed run left half-done), and
 * waitlist conversion for products on sale. `more` = work remains for the
 * next trigger. Safe from anyone, at any time, concurrently.
 */
export async function runTenantDueDrops(tenantId: string, tenantSlug: string | null, opts?: { onlyProductId?: string; invocationStartCount?: number }): Promise<TenantDropRun> {
  const budget = new Budget(opts?.invocationStartCount);
  const out: TenantDropRun = { tenantId, draws: [], waitlist: [], more: false, calls: 0 };
  const done = (skipped?: string) => ({ ...out, calls: budget.used(), ...(skipped ? { skipped } : {}) });
  const route = await chargeRouteForTenant(tenantId);
  if (route.route !== 'connected') return done('not connected');
  if (!(await raffleSchemaReady())) return done('00035 not applied');
  const stripe: any = await resolveStripeClient();
  if (!stripe) return done('Stripe not configured');
  budget.stripe();
  const account = await stripe.v2.core.accounts.retrieve(route.stripeAccount, { include: ['defaults'] });
  const currency = String(account?.defaults?.currency || '').toLowerCase();
  if (!currency) return done('no currency');
  const tz = storeTimezone(await tenantConfig(tenantId));
  const products = await loadProducts(null, { tenantId });

  // Every variant of the store in ONE call (was one lookup per size).
  const variantRows = (await getDb().select<any>('product_variants', {
    where: { tenant_id: eq(tenantId) },
    select: ['id', 'option_label', { relation: 'products', columns: ['external_id'] }],
  })) as any[];
  const variantIdOf = new Map<string, string>();
  for (const v of variantRows) variantIdOf.set(String(v.products?.external_id) + '|' + String(v.option_label), String(v.id));
  // Every open entry of the store in ONE call.
  const open = (await getDb().select<any>('raffle_entries', {
    where: { tenant_id: eq(tenantId), status: inList(['winner', 'pending']) }, select: ['*'],
  })) as any[];

  const now = Date.now();
  for (const product of Object.values(products) as any[]) {
    if (opts?.onlyProductId && String(product.id) !== opts.onlyProductId) continue;
    for (const cat of (product.priceCategories || []) as any[]) {
      const size = String(cat.size || '');
      const variantId = variantIdOf.get(String(product.id) + '|' + size);
      if (!size || !variantId) continue;
      const variant: VariantInfo = { variantId, productId: String(product.id), productName: String(product.name || product.id), size, priceCents: Math.round(Number(cat.price) * 100) };
      const mode = getSizeCheckoutMode(product, size);
      const mine = open.filter((e) => e.variant_id === variantId);

      if (mode === 'RAFFLE') {
        const at = drawAtMs(product, size, tz);
        const pendingRaffle = mine.filter((e) => e.status === 'pending' && e.entry_type === 'raffle');
        if (at !== null && at <= now && pendingRaffle.length > 0) {
          // ONE draw per variant per draw date, however many triggers race.
          const drawKey = variantId + ':' + at;
          if ((await claimWebhookKey('tenant_draw', drawKey)) !== 'duplicate') {
            try {
              const stock = readLiveStock(product, size);
              const tiers = String(cat.winnerTiers ?? product.winnerTiers ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
              // Winners already selected but not yet charged hold stock too.
              const room = Math.max(0, (stock.ok ? stock.stock : 0) - mine.filter((e) => e.status === 'winner').length);
              const draw = await executeDraw(tenantId, variantId, Math.min(room, tiers[0] || room), { entryType: 'raffle' });
              await completeWebhookKey('tenant_draw', drawKey);
              out.draws.push({ product: product.name, size, drawId: draw.drawId, entries: draw.entriesCount, winners: draw.winnerCount });
              for (const w of draw.winners) {
                const row = mine.find((e) => e.id === w.id);
                if (row) { row.status = 'winner'; row.decided_at = (w as any).decided_at; }
              }
            } catch (err) {
              await releaseWebhookKey('tenant_draw', drawKey).catch(() => {});
              throw err;
            }
          }
        }
        // Charge winners: this draw's, and any a crashed run left half-done.
        // decided_at is re-read so the attempt key matches what is stored.
        const winnerIds = mine.filter((e) => e.status === 'winner').map((e) => e.id);
        const winners = winnerIds.length === 0 ? [] : (await getDb().select<any>('raffle_entries', {
          where: { id: inList(winnerIds), status: eq('winner') }, select: ['*'],
        })) as any[];
        for (const entry of winners) {
          const r = await chargeEntry({ tenantId, tenantSlug, storeAccount: route.stripeAccount, currency, entry, variant, kind: 'raffle', budget });
          if (r.status === 'deferred') { out.more = true; break; }
          out.draws.push({ product: product.name, size, ...r });
        }
      } else if (product.isActive === true && product.isUpcoming !== true && product.isArchived !== true) {
        // On sale: convert the waitlist, oldest first, up to the stock there is.
        const pending = mine.filter((e) => e.status === 'pending' && e.entry_type === 'waitlist')
          .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
        const stock = readLiveStock(product, size);
        let left = stock.ok ? Math.max(0, stock.stock) : 0;
        for (const entry of pending) {
          if (left <= 0) break;
          const r = await chargeEntry({ tenantId, tenantSlug, storeAccount: route.stripeAccount, currency, entry, variant, kind: 'waitlist', budget });
          if (r.status === 'deferred') { out.more = true; break; }
          out.waitlist.push({ product: product.name, size, ...r });
          if (r.status === 'charged') left -= 1;
        }
      }
      if (out.more) return done();
    }
  }
  // Charges are done for this run; with what budget is left, tell the
  // customers who were charged (this run's, or an earlier busy run's).
  const infoByVariant = new Map<string, VariantInfo>();
  for (const product of Object.values(products) as any[]) {
    for (const cat of (product.priceCategories || []) as any[]) {
      const size = String(cat.size || '');
      const variantId = variantIdOf.get(String(product.id) + '|' + size);
      if (size && variantId) infoByVariant.set(variantId, { variantId, productId: String(product.id), productName: String(product.name || product.id), size, priceCents: Math.round(Number(cat.price) * 100) });
    }
  }
  out.emails = await sendDueChargeEmails(tenantId, tenantSlug, budget, infoByVariant).catch((err) => {
    console.error('[tenant-drops] email pass failed for ' + tenantId, (err as Error)?.message || err);
    return 0;
  });
  return done();
}

/** Every connected store other than the default one, for the scheduler. */
export async function connectedTenantIds(): Promise<Array<{ id: string; slug: string | null }>> {
  const { DEFAULT_TENANT_ID } = await import('@/lib/tenant-context');
  const rows = (await getDb().select<any>('tenants', {
    where: { connect_charges_enabled: eq(true) }, select: ['id', 'slug'],
  })) as any[];
  return rows.filter((r) => String(r.id) !== DEFAULT_TENANT_ID).map((r) => ({ id: String(r.id), slug: r.slug ?? null }));
}


/**
 * The product page's confirm step after a card-save page, for a connected
 * merchant. Same contract as the original store's route ({ success, message,
 * alreadyEntered }). The session is looked up ON THE MERCHANT'S ACCOUNT, so a
 * session from anywhere else is simply not found.
 */
export async function confirmTenantEntry(tenantId: string, sessionId: string): Promise<Response> {
  const route = await chargeRouteForTenant(tenantId);
  if (route.route !== 'connected') return json({ success: false, error: 'This store cannot take entries yet.' }, 409);
  const stripe: any = await resolveStripeClient();
  if (!stripe) return json({ success: false, error: 'Payment provider is not configured.' }, 500);
  let session: any;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: route.stripeAccount });
  } catch {
    return json({ success: false, error: 'Session not found.' }, 404);
  }
  if (String(session?.metadata?.tenant_id || '') !== tenantId) return json({ success: false, error: 'Session not found.' }, 404);
  if (session.status !== 'complete') return json({ success: false, message: 'Card setup was not completed.' });
  const r = await recordTenantEntryFromSetupSession(session, tenantId, route.stripeAccount);
  if (!r.handled) return json({ success: false, message: 'Card setup was not completed.' });
  if (r.afterCommit) await r.afterCommit().catch(() => 'failed');
  const name = String(session.metadata?.variant || 'this item') + ' (' + String(session.metadata?.size || '') + ')';
  if (r.alreadyEntered) {
    return json({ success: true, alreadyEntered: true, message: r.kind === 'waitlist' ? `You're already on the waitlist for ${name}.` : `You're already entered for ${name}.` });
  }
  return json({
    success: true,
    message: r.kind === 'waitlist'
      ? `You're on the waitlist for ${name}. Your saved card is charged only if one is available when it goes on sale.`
      : `Your entry for ${name} is locked in. Your saved card is charged only if you win.`,
  });
}
