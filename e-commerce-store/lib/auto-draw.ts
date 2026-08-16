/**
 * Shared, Redis-driven auto-draw runner.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The old cron routes (`/api/cron/auto-draw`, `/api/checkout/cron-draw`)
 * iterated the STATIC `GOYUNIR_STORE_SUITE.productCatalog` to find the product
 * behind each `entries:pool:*` key. Products created purely through the admin
 * portal (the normal white-label flow) live ONLY in Redis (`store:products`),
 * so their pools were never drawn — the countdown hit zero and nothing
 * happened. This module is the single draw engine used by:
 *
 *   - `/api/cron/auto-draw`           (Vercel cron safety net)
 *   - `/api/checkout/cron-draw`       (legacy cron / QStash path)
 *   - `/api/checkout/auto-draw`       (client "timer hit zero" trigger)
 *
 * It reads products from Redis (never the static config), decides whether each
 * pool is due based on the product's own timings (releaseEndsAt / goLiveAt /
 * archived) OR the global drop schedule, and runs the same winner-charging
 * logic the old cron used so behavior is unchanged — except it now actually
 * fires for admin-created products.
 */

import {
  archiveEntry,
  archiveProductToCatalog,
  buildAbsoluteUrl,
  cardBlockKey,
  createRedisClient,
  createStripeClient,
  DRAW_HISTORY_KEY,
  emailBlockKey,
  getGlobalScheduleOverride,
  getOrSeedLiveState,
  getProductOverride,
  intentPoolKey,
  LAST_DRAW_KEY,
  LAST_AUTO_DRAW_HASH_KEY,
  lastAutoDrawField,
  loadProducts,
  POOL_KEY_PREFIX,
  POOL_STATS_KEY,
  poolStatField,
  PRODUCTS_KEY,
  PROMO_CODES_KEY,
  resolveCustomerId,
  safeParseRedisItem,
  saveLiveState,
  sizeFromPoolKey,
  STORE_CONFIG_KEY,
  USERS_KEY,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  getProductPrice,
  getWinnerCount,
  isConfiguredPrice,
  shouldRunDraw,
  getNextRecurringAnchorMs,
  getSizeCheckoutMode,
} from '@/lib/storefront-config';
import { sendPromoterPayoutEmail, sendWinnerEmail } from '@/lib/email';
import { fallbackSiteUrl, getSiteUrl } from '@/lib/env';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { productNameFromPoolKey } from '@/lib/draw-keys';
import { dropTimestampToMs, formatStoreWallClock, splitEntriesByCycleEnd } from '@/lib/drop-timestamps';

export { productNameFromPoolKey };

/** How recently a pool must have been drawn before a client trigger will re-run
 * it. Stops a stampede of "timer hit zero" pings from re-drawing the same pool
 * over and over while inventory is still being allocated. */
const CLIENT_RE_RUN_COOLDOWN_MS = 90_000;

/** Look up whether an email has a store account and its current rewards balance
 * (same store:users scan the checkout routes use) so winner/recovery emails
 * always reflect the CURRENT account state, never a stale guest snapshot. */
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

export interface AutoDrawOptions {
  redis?: any;
  stripe?: any;
  request?: Request | null;
  /** Only draw pools belonging to this product id. */
  onlyProductId?: string;
  /** Only draw pools belonging to this product name. */
  onlyProductName?: string;
  /** Only draw pools belonging to a product with this slug. */
  onlySlug?: string;
  /** Skip per-pool scheduling/cooldown checks and draw ANY pool with entries
   * (admin/manual force). Prefer `ignoreCooldown` for cron runs. */
  force?: boolean;
  /** Cron/manual: skip the client-trigger 90s cooldown but still respect the
   * pool due-check (releaseEndsAt passed / archived / schedule cadence). */
  ignoreCooldown?: boolean;
  /** Simulate the draw: charge nothing, only report what WOULD happen. */
  dryRun?: boolean;
  /** Wall-clock override (tests). */
  now?: number;
}

export interface AutoDrawWinner {
  email: string;
  product: string;
  size: string;
  shippingAddress: string;
  status: string;
  shippingStatus?: string;
  amountCents?: number;
  promoCode?: string;
  orderRef?: string;
}

export interface AutoDrawResult {
  success: boolean;
  message?: string;
  drewPools: string[];
  processedWinners: AutoDrawWinner[];
  totalSuccessfulCharges: number;
  totalRevenueCents: number;
}

/**
 * Parse a product drop timestamp as an absolute epoch-ms value. Naive strings
 * (`2026-08-15T06:16`) are interpreted in the STORE's timezone (never the
 * server's UTC), so the draw engine agrees with the browser countdown that
 * triggered it. Explicitly-zoned strings pass through natively.
 */
const toMs = (value: unknown, timezone?: string): number | null =>
  dropTimestampToMs(value, timezone);

export interface PoolDueInfo {
  /** Should this pool be drawn right now? */
  due: boolean;
  /** The persisted cycle boundary (`releaseEndsAt`) as epoch-ms, or null when
   *  the product has no explicit countdown end. */
  cycleEndMs: number | null;
  /** The next recurring draw anchor after the cycle end, or null for one-shot
   *  drops / products without a recurring schedule. */
  nextAnchorMs: number | null;
  /** True when due-ness came from the global cadence (no explicit cycle). */
  cadence: boolean;
}

/**
 * Decide whether a pool is due for a draw right now, AND expose the timing
 * facts the draw itself needs (cycle boundary + next anchor) so the runner can
 * draw cycle-safely:
 * - force → yes
 * - product archived → yes (final allocation of any stragglers)
 * - product has an explicit `releaseEndsAt` → that is the CYCLE boundary. The
 *   pool is NEVER drawn before the countdown finishes (a cron run or an
 *   unrelated client ping must not charge winners early). Once the cycle has
 *   ended:
 *     - one-shot drops (no next scheduled anchor) draw at most once — a pool
 *       that has already been drawn after the cycle ended stays done;
 *     - recurring raffles draw now (the runner rolls `releaseEndsAt` forward
 *       after the draw, so the next countdown becomes due at the next anchor),
 *       and if the pool has somehow rolled PAST the next anchor without a draw
 *       (e.g. a failed roll-forward) it is due immediately to catch up.
 * - no explicit `releaseEndsAt` → fall back to the global schedule cadence
 *   (interval since the last auto-draw).
 */
async function evaluatePoolDue(opts: {
  redis: any;
  product: any;
  size: string;
  now: number;
  force: boolean;
  globalSchedule?: Record<string, any> | null;
}): Promise<PoolDueInfo> {
  if (opts.force) {
    return { due: true, cycleEndMs: null, nextAnchorMs: null, cadence: false };
  }
  if (opts.product?.isArchived === true) {
    return { due: true, cycleEndMs: null, nextAnchorMs: null, cadence: false };
  }

  const effectiveSchedule = {
    ...GOYUNIR_STORE_SUITE.dropSchedule,
    ...(opts.globalSchedule || {}),
    ...(opts.product?.customDropSchedule || {}),
  };
  const timezone = String(effectiveSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles');
  const endMs = toMs(opts.product?.releaseEndsAt, timezone);
  const lastAuto = Number((await opts.redis.hget(LAST_AUTO_DRAW_HASH_KEY, lastAutoDrawField(opts.product.name, opts.size))) || 0);

  if (endMs !== null) {
    // The product's own countdown end is the current cycle boundary.
    if (opts.now < endMs) return { due: false, cycleEndMs: endMs, nextAnchorMs: null, cadence: false };
    const nextAnchor = getNextRecurringAnchorMs(effectiveSchedule as any, endMs);
    if (nextAnchor === null) {
      // One-shot: draw at most once after the cycle ended (lastAuto >= endMs
      // means this pool was already drawn for this cycle).
      return { due: lastAuto < endMs, cycleEndMs: endMs, nextAnchorMs: null, cadence: false };
    }
    // Recurring. Due when this cycle hasn't been drawn yet (lastAuto < endMs),
    // OR when we have rolled PAST the next boundary (catch-up after a missed
    // draw/roll-forward). NEVER due before endMs.
    const due = lastAuto < endMs || opts.now >= nextAnchor;
    return { due, cycleEndMs: endMs, nextAnchorMs: nextAnchor, cadence: false };
  }

  // No explicit countdown end → the global cadence defines the cycle.
  return {
    due: shouldRunDraw(effectiveSchedule, lastAuto, opts.now),
    cycleEndMs: null,
    nextAnchorMs: null,
    cadence: true,
  };
}

export async function runAutoDraws(options: AutoDrawOptions = {}): Promise<AutoDrawResult> {
  const redis = options.redis || createRedisClient();
  const stripe = options.stripe || createStripeClient();
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun === true;

  if (!redis) {
    return { success: true, drewPools: [], processedWinners: [], totalSuccessfulCharges: 0, totalRevenueCents: 0 };
  }

  const products = await loadProducts(redis);
  const productsByName = new Map<string, any>();
  const productsById = new Map<string, any>();
  const productsBySlug = new Map<string, any>();
  for (const product of Object.values(products) as any[]) {
    if (!product) continue;
    const name = String(product.name || '');
    if (name) productsByName.set(name.toLowerCase(), product);
    if (product.id) productsById.set(String(product.id), product);
    if (product.slug) productsBySlug.set(String(product.slug).toLowerCase(), product);
  }

  // ── Auto-activate upcoming products whose go-live time has passed ───────────
  // The catalog/status route already computes this at READ time, but the product
  // record in Redis stayed `isUpcoming`, so the product page + entry form kept
  // treating it as upcoming forever. Persist the flip here so the drop actually
  // opens (and the raffle timer starts counting to releaseEndsAt).
  //
  // IMPORTANT: this must ALSO run when the caller passed a product filter (the
  // client "timer hit zero" trigger) — otherwise the exact product whose
  // countdown just ended would stay `isUpcoming` because the filter branch
  // skipped the flip. The flip is idempotent (isUpcoming: false), so concurrent
  // triggers are harmless.
  // Effective global schedule (code default → seeded store config → admin
  // live-apply override) + the store timezone. The per-product
  // `customDropSchedule` is merged per-pool in the due-check and roll-forward
  // below. All three sources matter: the seed writes `store:config.dropSchedule`,
  // the admin "Save Schedule" writes the override, and the static config is the
  // code-level fallback — priority is override > store config > static.
  const scheduleOverrideForTz = await getGlobalScheduleOverride(redis).catch(() => null);
  const storeConfigForSchedule = safeParseRedisItem<any>(await redis.get(STORE_CONFIG_KEY).catch(() => null)) || {};
  const refPrefix = normalizeRefPrefix(storeConfigForSchedule?.refPrefix || 'GU');
  const globalSchedule = {
    ...GOYUNIR_STORE_SUITE.dropSchedule,
    ...(storeConfigForSchedule?.dropSchedule || {}),
    ...(scheduleOverrideForTz || {}),
  };
  const storeTimezone = String(globalSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles');
  {
    for (const product of Object.values(products) as any[]) {
      if (!product || product.isUpcoming !== true) continue;
      if (options.onlyProductId && String(product.id) !== String(options.onlyProductId)) continue;
      if (options.onlyProductName && String(product.name || '').toLowerCase() !== String(options.onlyProductName).toLowerCase()) continue;
      if (options.onlySlug && String(product.slug || '').toLowerCase() !== String(options.onlySlug).toLowerCase()) continue;
      const goMs = toMs(product.goLiveAt, storeTimezone);
      if (goMs !== null && now >= goMs) {
        try {
          await redis.hset(PRODUCTS_KEY, {
            [product.id]: JSON.stringify({ ...product, isUpcoming: false, isActive: true, goLiveAt: product.goLiveAt || '' }),
          });
          product.isUpcoming = false;
          product.isActive = true;
        } catch {
          /* non-fatal */
        }
      }
    }
  }


  let allPoolKeys = (await redis.keys(`${POOL_KEY_PREFIX}*`)) as string[];
  if (!Array.isArray(allPoolKeys)) allPoolKeys = [];

  // Apply the caller's filter.
  if (options.onlyProductId || options.onlyProductName || options.onlySlug) {
    const wanted = new Set<string>();
    for (const product of Object.values(products) as any[]) {
      if (!product) continue;
      const name = String(product.name || '');
      if (options.onlyProductId && String(product.id) !== String(options.onlyProductId)) continue;
      if (options.onlyProductName && String(name).toLowerCase() !== String(options.onlyProductName).toLowerCase()) continue;
      if (options.onlySlug && String(product.slug || '').toLowerCase() !== String(options.onlySlug).toLowerCase()) continue;
      wanted.add(name);
    }
    allPoolKeys = allPoolKeys.filter((key) => wanted.has(productNameFromPoolKey(key)));
  }

  const processedWinners: AutoDrawWinner[] = [];
  const drewPools: string[] = [];
  let grandRevenueChargesCount = 0;
  // Products whose countdown should roll forward after ALL their pools have
  // been evaluated this run (a multi-size product's pools share the same
  // releaseEndsAt — advancing it mid-loop would wrongly mark later size pools
  // "not due" in the same run).
  const productsToAdvance = new Map<string, any>();

  for (const poolKey of allPoolKeys) {
    try {
      const productName = productNameFromPoolKey(poolKey);
      const productSize = sizeFromPoolKey(poolKey);
      const product = productsByName.get(String(productName).toLowerCase());
      if (!product) continue; // pool for a deleted/renamed product — leave untouched

      // Mixed-format products: a size marked FCFS sells instantly at checkout and
      // is NEVER part of the raffle. Guard so a stale/forced FCFS pool can never
      // be drawn (and never have its countdown rolled forward).
      if (getSizeCheckoutMode(product, productSize) === 'FCFS') continue;

      const listLength = await redis.llen(poolKey);

      const dueInfo = await evaluatePoolDue({ redis, product, size: productSize, now, force: options.force === true, globalSchedule });
      if (!dueInfo.due) continue;

      // Client "timer hit zero" pings should never re-draw the same pool in a
      // tight loop. A just-drawn pool (within the cooldown) is skipped unless
      // the caller explicitly forced the draw (cron/admin).
      if (options.force !== true && options.ignoreCooldown !== true) {
        const lastAuto = Number((await redis.hget(LAST_AUTO_DRAW_HASH_KEY, lastAutoDrawField(productName, productSize))) || 0);
        if (lastAuto > 0 && now - lastAuto < CLIENT_RE_RUN_COOLDOWN_MS) continue;
      }

      const override = await getProductOverride(redis, product.id);
      const priceCat = (product.priceCategories || []).find((c: any) => String(c?.size || '') === productSize);
      const categoryPriceCents = priceCat && isConfiguredPrice(priceCat.price)
        ? Math.round(Number(priceCat.price) * 100)
        : 0;
      const overridePrice = productSize === '100ml' ? override?.price100ml : override?.price50ml;
      const legacyPriceCents = Math.round((overridePrice ?? getProductPrice(product, productSize)) * 100);
      const basePriceCents = legacyPriceCents > 0 ? legacyPriceCents : categoryPriceCents;
      if (!basePriceCents || basePriceCents <= 0) continue;

      const winnersPerDraw = getWinnerCount(GOYUNIR_STORE_SUITE, productSize);
      const live = await getOrSeedLiveState(redis, product, productSize, winnersPerDraw);
      if (live.inventoryRemaining <= 0) continue;

      // ── Cycle-aware eligibility ────────────────────────────────────────────
      // Only entries registered before this cycle's end may be drawn now. A
      // pool whose cycle ended but contains ONLY entries for the NEXT round (a
      // "restarted countdown" the storefront already shows) is NOT drawn — the
      // runner just rolls the product's releaseEndsAt forward so the next
      // timer becomes the real due date. This is the guard that makes "I
      // entered after the countdown restarted" never get charged early. An
      // empty stale pool is advanced the same way.
      if (listLength === 0) {
        if (dueInfo.nextAnchorMs !== null && !dryRun) {
          productsToAdvance.set(String(product.id), product);
        }
        continue;
      }

      const entries = await redis.lrange(poolKey, 0, -1);
      const { eligible, carriedOver } = splitEntriesByCycleEnd(entries, dueInfo.cycleEndMs);
      if (eligible.length === 0) {
        if (dueInfo.nextAnchorMs !== null && !dryRun) {
          productsToAdvance.set(String(product.id), product);
        }
        continue;
      }

      const shuffled = [...eligible];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Next-cycle entries always survive this run untouched.
      const remainingEntries: string[] = [...carriedOver];

      const rawWinners = live.winnersPerDraw ?? winnersPerDraw;
      // Winner count for THIS draw. The per-size "Winners / draw" tiers on the
      // product's price categories are the source of truth (admin CSV, e.g.
      // 3,2,2 → 3 winners on draw 1, 2 on draw 2, 2 on draw 3); fall back to the
      // legacy `winnerTiers` array, then the live-state value, then the global
      // schedule fallback. This makes seeded products with `winnerTiers: [3,2,2]`
      // actually charge 3 winners on the first draw (their seeded live state
      // used to carry a wrong `winnersPerDraw: 1`).
      let winnersThisDraw = 1;
      const rawTierValue = priceCat?.winnerTiers ?? product.winnerTiers;
      if (typeof rawTierValue === 'string') {
        const tiers = rawTierValue.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (tiers.length > 0) winnersThisDraw = Math.max(1, Number(tiers[Math.min(live.drawsCompleted || 0, tiers.length - 1)]) || 1);
      } else if (Array.isArray(rawTierValue)) {
        const tiers = rawTierValue.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (tiers.length > 0) winnersThisDraw = Math.max(1, Number(tiers[Math.min(live.drawsCompleted || 0, tiers.length - 1)]) || 1);
      } else if (Array.isArray(rawWinners)) {
        winnersThisDraw = Math.max(1, Number(rawWinners[Math.min(live.drawsCompleted || 0, rawWinners.length - 1)]) || 1);
      } else {
        winnersThisDraw = Math.max(1, Number(rawWinners) || 1);
      }
      const inventoryLimit = Math.min(winnersThisDraw, live.inventoryRemaining);
      let successfulPoolCaptures = 0;

      const siteUrl = getSiteUrl() || (options.request ? buildAbsoluteUrl(options.request, '') : '') || fallbackSiteUrl();

      for (const winnerStr of shuffled) {
        const rawWinnerData = safeParseRedisItem<any>(winnerStr);
        if (!rawWinnerData) continue;
        const winnerData = rawWinnerData.email && typeof rawWinnerData.email === 'object' ? rawWinnerData.email : rawWinnerData;
        const winnerEmail = String(winnerData.email || '').toLowerCase();
        const paymentMethod = winnerData.paymentMethodId || null;
        const customerId = resolveCustomerId(winnerData) || null;
        const shippingAddress = winnerData.shippingAddress || winnerData.address || 'No Address Logged';
        const promoCode = String(winnerData.promoCode || '').trim().toUpperCase();
        const orderRef = formatOrderRef(String(winnerData.orderRef || ''), refPrefix) || buildOrderRef(winnerEmail, productName, productSize, refPrefix);

        if (successfulPoolCaptures >= inventoryLimit) {
          remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
          if (!dryRun) {
            await archiveEntry(redis, {
              email: winnerEmail, variant: productName, size: productSize, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'NOT_SELECTED', promoCode: promoCode || undefined,
            });
          }
          continue;
        }

        try {
          if (paymentMethod && customerId) {
            let priceCents = basePriceCents;
            let promoForCharge: any = null;
            let winnerDiscountPercent = 0;

            // The discount locked onto the entry at signup time always wins
            // ("X% off if selected"), so winners pay the advertised amount.
            const entryDiscount = Math.min(50, Math.max(0, Number(winnerData.discountPercent) || 0));
            if (entryDiscount > 0) {
              priceCents = Math.max(50, Math.round(basePriceCents * (1 - entryDiscount / 100)));
              winnerDiscountPercent = entryDiscount;
            }


            if (promoCode) {
              try {
                const raw = await redis.hget(PROMO_CODES_KEY, promoCode);
                promoForCharge = safeParseRedisItem<any>(raw);
                if (promoForCharge && promoForCharge.active !== false) {
                  const self = promoForCharge.promoterEmail && String(promoForCharge.promoterEmail).toLowerCase() === winnerEmail;
                  if (!self) {
                    if (entryDiscount <= 0) {
                      const discount = Math.min(50, Math.max(0, Number(promoForCharge.customerDiscountPercent) || 0));
                      if (discount > 0) {
                        priceCents = Math.max(50, Math.round(basePriceCents * (1 - discount / 100)));
                        winnerDiscountPercent = discount;
                      }
                    }
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

            if (dryRun) {
              // Simulated draw: report what WOULD happen, never charge/email.
              successfulPoolCaptures++;
              live.inventoryRemaining = Math.max(0, live.inventoryRemaining - 1);
              live.salesCompleted = (live.salesCompleted || 0) + 1;
              grandRevenueChargesCount++;
              processedWinners.push({
                email: winnerEmail, product: productName, size: productSize, shippingAddress,
                status: 'SUCCESS_CHARGED (dry-run)', shippingStatus: 'PENDING_FULFILLMENT',
                amountCents: priceCents, promoCode: promoCode || undefined, orderRef,
              });
              continue;
            }

            await stripe.paymentIntents.create({
              amount: priceCents, currency: 'usd', customer: customerId, payment_method: paymentMethod,
              off_session: true, confirm: true, receipt_email: winnerEmail,
              description: `${productName} (${productSize})`,
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
                await redis.hset(PROMO_CODES_KEY, { [promoCode]: JSON.stringify(promoForCharge) });

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
              } catch {
                /* payout bookkeeping is best-effort */
              }
            }


            await archiveEntry(redis, {
              email: winnerEmail, variant: productName, size: productSize, shippingAddress,
              id: customerId, registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
              shippingStatus: 'PENDING_FULFILLMENT', promoCode: promoCode || undefined, amountCents: priceCents, orderRef,
            });

            const userRewards = await lookupUserRewards(redis, winnerEmail);

            await sendWinnerEmail({
              to: winnerEmail,
              product: productName,
              size: productSize,
              amountLabel: `$${(priceCents / 100).toFixed(2)}`,
              promoCode: promoCode && promoForCharge ? promoCode : undefined,
              originalPrice: `$${(basePriceCents / 100).toFixed(2)}`,
              discountPercent: winnerDiscountPercent > 0 ? winnerDiscountPercent : undefined,
              orderRef,
              shippingAddress: shippingAddress || undefined,
              siteUrl,
              hasAccount: userRewards.hasAccount || undefined,
              rewardsBalance: userRewards.hasAccount ? userRewards.rewardsBalance : undefined,
            });

            processedWinners.push({
              email: winnerEmail, product: productName, size: productSize, shippingAddress,
              status: 'SUCCESS_CHARGED', shippingStatus: 'PENDING_FULFILLMENT',
              amountCents: priceCents, promoCode: promoCode || undefined, orderRef,
            });
          } else {
            remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
            if (!dryRun) {
              await archiveEntry(redis, {
                email: winnerEmail, variant: productName, size: productSize, shippingAddress,
                id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED', promoCode: promoCode || undefined,
              });
            }
            processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: 'MISSING_PAYMENT_METHOD', orderRef });
          }
        } catch (err: any) {
          remainingEntries.push(typeof winnerStr === 'string' ? winnerStr : JSON.stringify(rawWinnerData));
          processedWinners.push({ email: winnerEmail, product: productName, size: productSize, shippingAddress, status: `DECLINED: ${err.message}`, orderRef });
          if (!dryRun) {
            await archiveEntry(redis, {
              email: winnerEmail, variant: productName, size: productSize, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED', promoCode: promoCode || undefined,
            });
          }
        }
      }

      drewPools.push(poolKey);

      // In a dry-run we did mutate the live state counters — roll them back so
      // the simulation leaves zero trace (and skip the save entirely).
      if (dryRun) {
        live.inventoryRemaining = Math.max(0, Number(live.inventoryRemaining) + successfulPoolCaptures);
        live.salesCompleted = Math.max(0, Number(live.salesCompleted) - successfulPoolCaptures);
      } else {
        live.drawsCompleted = (live.drawsCompleted || 0) + 1;
        await saveLiveState(redis, live);
      }


      if (!dryRun) {
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

        const intentKey = intentPoolKey(productName, productSize);
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

        await redis.hset(LAST_AUTO_DRAW_HASH_KEY, {
          [lastAutoDrawField(productName, productSize)]: String(Date.now()),
        });

        // ── Recurring-raffle roll-forward (deferred) ─────────────────────────
        // If inventory remains (and the product is not archived), the product's
        // countdown rolls forward to its NEXT scheduled draw moment AFTER all of
        // its pools have been evaluated (see productsToAdvance below). The
        // storefront then shows a NEW countdown to that moment instead of
        // freezing on "Raffle closed"/"Until sold out", and the pool becomes due
        // again exactly when that timer hits zero. One-shot drops (no future
        // anchor) keep the past releaseEndsAt and are marked done by the
        // `lastAuto` guard in evaluatePoolDue.
        if (live.inventoryRemaining > 0 && !product.isArchived) {
          productsToAdvance.set(String(product.id), product);
        }

        if (live.inventoryRemaining <= 0) {
          await archiveProductToCatalog(redis, {
            productId: product.id,
            name: product.name,
            image: product.catalogImage || (product.images?.[0]) || `/images/${product.prefix}/1.jpeg`,
            description: product.desc || product.tagline || '',
            availableFrom: 'Sold out',
            archivedAt: new Date().toISOString(),
            notes: 'Sold out — all inventory allocated.',
            soldOut: true,
          });
        }
      }
    } catch {
      // A single broken pool must never abort the whole run.
    }
  }

  // ── Deferred recurring-raffle roll-forward ────────────────────────────────
  // Persist each drawn product's new releaseEndsAt (the next scheduled draw
  // moment) now that every pool has been evaluated. A failed roll-forward must
  // never fail the run itself.
  if (!dryRun && productsToAdvance.size > 0) {
    for (const [, product] of productsToAdvance) {
      try {
        const productSchedule = { ...GOYUNIR_STORE_SUITE.dropSchedule, ...(globalSchedule || {}), ...(product.customDropSchedule || {}) };
        const productTz = String(productSchedule?.timezone || storeTimezone || 'America/Los_Angeles');
        const currentEndMs = toMs(product.releaseEndsAt, productTz);
        // Advance from the LATER of (cycle end, now) so the new timer is ALWAYS
        // in the future — a run that catches a stale cycle late (missed draws,
        // empty-pool advance) skips straight past any intermediate anchors
        // instead of chasing them one at a time.
        const baseForAdvance = currentEndMs !== null && currentEndMs > 0 ? Math.max(currentEndMs, now) : now;
        const nextAnchorMs = getNextRecurringAnchorMs(productSchedule as any, baseForAdvance);
        if (nextAnchorMs !== null) {
          const nextRelease = formatStoreWallClock(nextAnchorMs, productTz);
          if (nextRelease && nextRelease !== product.releaseEndsAt) {
            product.releaseEndsAt = nextRelease;
            await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  const totalRevenueCents = processedWinners
    .filter((w) => w.status === 'SUCCESS_CHARGED' || w.status === 'SUCCESS_CHARGED (dry-run)')
    .reduce((sum, w) => sum + (Number(w.amountCents) || 0), 0);

  if (drewPools.length > 0 && !dryRun) {
    const tz = GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles';
    const executionTime = new Date().toLocaleString('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short',
    });
    const drawSummary = {
      executionTime,
      timezone: tz,
      processedWinners,
      totalSuccessfulCharges: grandRevenueChargesCount,
      totalRevenueCents,
    };
    try {
      await redis.set(LAST_DRAW_KEY, JSON.stringify(drawSummary));
      await redis.rpush(DRAW_HISTORY_KEY, JSON.stringify({ ...drawSummary, timestamp: new Date().toISOString() }));
      const len = await redis.llen(DRAW_HISTORY_KEY);
      if (len > 100) await redis.ltrim(DRAW_HISTORY_KEY, len - 100, -1);
    } catch {}
  }

  return {
    success: true,
    drewPools,
    processedWinners,
    totalSuccessfulCharges: grandRevenueChargesCount,
    totalRevenueCents,
  };
}

