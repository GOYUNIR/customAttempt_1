/**
 * Product & settings "sanity" checks — the smart-math guardrail behind the
 * admin portal ("have the admin portal be smart in general and understand
 * what's going on").
 *
 * Every check is PURE (no Redis, no `@/` VALUE imports) so the admin product
 * form can run it live on every keystroke AND the `node --test` runner can
 * cover it. The same engine is used by:
 *   - the admin product editor (live "Math & health check" panel),
 *   - the admin Overview dashboard (per-product issue summary),
 *   - `/api/admin/products` (save-time gate: exploitable 'error' issues block
 *     the save with a 400 so a broken config can never reach production),
 *   - the Settings → Rewards & Points tab (rewards-arbitrage alert).
 *
 * Severity contract:
 *   - 'error'   — the math is EXPLOITABLE or structurally broken; the product
 *                 must not be saved (customers could farm free credits/money,
 *                 a raffle over-sells its inventory, a timer ends before it
 *                 opens, …).
 *   - 'warning' — almost certainly a mistake or a bad deal for the company or
 *                 the customer; save is allowed but flagged loudly.
 *   - 'info'    — helpful context / a soft recommendation.
 */

export type SanitySeverity = 'error' | 'warning' | 'info';

export type SanityIssue = {
  severity: SanitySeverity;
  /** Stable machine-readable code (used by tests + the admin UI key). */
  code: string;
  /** One short line for the operator. */
  message: string;
  /** Optional longer plain-English explanation + suggested fix. */
  detail?: string;
  /** Optional DOM id of the exact input this issue points at, so the admin can
   *  scroll + focus the offending field directly ("Fix first issue"). */
  fieldId?: string;
};

/** Parsed winner-tier CSV ("3,2,2") or numeric array → the list of per-draw counts. */
export function parseWinnerTiers(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((n) => Math.max(0, Math.floor(Number(n) || 0))).filter((n) => n > 0);
  }
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Math.max(0, Math.floor(Number(s) || 0)))
    .filter((n) => n > 0);
}

/** Total winners across ALL draws of a size (draw 1 + draw 2 + …). */
export function totalWinnersForTiers(value: unknown): number {
  return parseWinnerTiers(value).reduce((sum, n) => sum + n, 0);
}

export type ProductSanityContext = {
  /** Rewards settings (admin → Settings → Rewards & Points) for the earn-rate
   *  cross-check. Optional — reward checks are skipped when absent. */
  rewards?: {
    purchasePointsPerDollar?: number;
    pointsPerDollar?: number;
  };
  /** True when a global `STRIPE_PRODUCT_ID` fallback is configured (so a size
   *  without its own Stripe ID still charges). Defaults to false. */
  globalStripeConfigured?: boolean;
  /** Testable clock — defaults to Date.now(). */
  now?: number;
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Run every sanity check against one product record. Returns a list sorted by
 * severity (errors first, then warnings, then info) and, within a severity,
 * stable by check order. Never throws.
 */
export function checkProductSanity(product: any, ctx: ProductSanityContext = {}): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  const cats = Array.isArray(product?.priceCategories) ? product.priceCategories : [];
  const inventoryPerSize: Record<string, number> =
    product?.inventoryPerSize && typeof product.inventoryPerSize === 'object' && !Array.isArray(product.inventoryPerSize)
      ? product.inventoryPerSize
      : {};
  const totalInventory = Math.max(0, Number(product?.totalInventory) || 0);
  const sizeByName = new Map<string, { price: number; winnerTiers: unknown; checkoutMode?: string }>();

  // ── Structure: sizes & prices ────────────────────────────────────────────
  if (cats.length === 0) {
    issues.push({
      severity: 'error',
      code: 'no_sizes',
      fieldId: 'pf-sizes',
      message: 'Add at least one variant / option with a price.',
      detail: 'A product with no Pricing & Variants rows cannot be sold or entered. Add a variant in Pricing & Variants.',
    });
  } else {
    const seen = new Map<string, number>();
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      const size = String(cat?.size || '').trim();
      const key = size.toLowerCase();
      const price = Math.max(0, Number(cat?.price) || 0);
      const mode = String(cat?.checkoutMode || '').toUpperCase();
      sizeByName.set(key, { price, winnerTiers: cat?.winnerTiers, checkoutMode: mode === 'FCFS' ? 'FCFS' : mode === 'RAFFLE' ? 'RAFFLE' : '' });

      if (!size) continue;
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({
          severity: 'error',
          code: 'duplicate_size',
          fieldId: `pf-size-${i}`,
          message: `Duplicate size “${size}” (same as size #${first + 1}).`,
          detail: 'Two sizes with the same label will share one pool and confuse the storefront. Rename one of them.',
        });
      } else {
        seen.set(key, i + 1);
      }

      // A variant linked into a shared-inventory pool (`inventorySyncSlug`) inherits
      // its price from the pool's canonical source variant, so an empty local price
      // is NOT "no price" — flagging it would make every synced variant un-saveable.
      const isSyncedVariant = String(cat?.inventorySyncSlug || '').trim() !== '';
      if (!isSyncedVariant && (price < 0.01 || price >= 9999999)) {
        issues.push({
          severity: 'error',
          code: 'empty_price',
          fieldId: `pf-price-${i}`,
          message: `Size “${size || `#${seen.size}`}” has no real price yet.`,
          detail: 'A $0 (or placeholder) price lets customers buy/enter for free. Set a real price of at least $0.01 or remove the size.',
        });
      }
    }
  }

  // ── Draw math: a raffle can never oversell its inventory ─────────────────
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const size = String(cat?.size || '').trim();
    if (!size) continue;
    const key = size.toLowerCase();
    const info = sizeByName.get(key);
    const isFcfs = info?.checkoutMode === 'FCFS' || (product?.checkoutMode === 'FCFS' && info?.checkoutMode !== 'RAFFLE');

    // FCFS sizes are never drawn — a winners CSV on them is meaningless.
    if (isFcfs && totalWinnersForTiers(cat?.winnerTiers) > 0) {
      issues.push({
        severity: 'warning',
        code: 'winners_on_fcfs',
        fieldId: `pf-winnerstiers-${i}`,
        message: `Size “${size}” sells instantly (FCFS) but has winners configured.`,
        detail: 'FCFS sizes are never drawn, so the “Winners / draw” value is ignored. Clear it to avoid confusion.',
      });
    }

    if (!isFcfs) {
      const totalWinners = totalWinnersForTiers(cat?.winnerTiers);
      if (totalWinners > 0) {
        const perSizeStock = Number(inventoryPerSize[size]) || 0;
        const pool = perSizeStock > 0 ? perSizeStock : cats.length === 1 ? totalInventory : 0;
        if (pool > 0 && totalWinners > pool) {
          issues.push({
            severity: 'error',
            code: 'raffle_oversell',
            fieldId: `pf-winnerstiers-${i}`,
            message: `Size “${size}” draws ${totalWinners} winners total but only has ${pool} unit${pool === 1 ? '' : 's'} of stock.`,
            detail: `The winner tiers CSV (${parseWinnerTiers(cat?.winnerTiers).join(', ')}) sums to ${totalWinners}, which exceeds the ${pool} available. A raffle can never give away more units than exist — lower the tiers or raise inventory.`,
          });
        } else if (pool === 0 && totalWinners > totalInventory && totalInventory > 0) {
          issues.push({
            severity: 'error',
            code: 'raffle_oversell',
            fieldId: `pf-winnerstiers-${i}`,
            message: `Size “${size}” draws ${totalWinners} winners but total inventory is only ${totalInventory}.`,
            detail: 'No per-size stock is set, so the total inventory is the pool. The winners exceed it.',
          });
        }
      }
    }
  }

  // ── Sampler / trial-credit math: the anti-arbitrage gate ────────────────
  const samplers = Array.isArray(product?.samplerSizes) ? product.samplerSizes : [];
  const samplerSizes = samplers.map((s: any) => String(s?.size || '').trim().toLowerCase()).filter(Boolean);
  const deliveryEnabled = product?.deliveryIncentiveEnabled === true;
  const productDefaultCredit = Math.max(0, Number(product?.deliveryIncentiveCreditCents) || 0);
  const productDefaultMinOrder = Math.max(0, Number(product?.deliveryIncentiveMinOrderSubtotalCents) || 0);

  if (deliveryEnabled && samplerSizes.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'sampler_no_markers',
      message: 'Trial credits are enabled but no variant is marked as a sampler.',
      detail: 'Enable “🧪 Sample” on at least one variant in Pricing & Variants, otherwise the credits are never advertised or issued.',
    });
  }

  for (const cat of cats) {
    const size = String(cat?.size || '').trim();
    if (!size) continue;
    const key = size.toLowerCase();
    const sampler = samplers.find((s: any) => String(s?.size || '').trim().toLowerCase() === key);
    if (!sampler) continue;

    const samplePriceCents = Math.max(0, Math.round(Number(cat?.price || 0) * 100));
    const creditCents = Math.max(0, Number(sampler.creditCents ?? productDefaultCredit) || 0);
    const minOrderCents = Math.max(0, Number(sampler.minOrderSubtotalCents ?? productDefaultMinOrder) || 0);
    const fullSize = String(sampler.fullSize || '').trim();
    const fullPriceCents = fullSize
      ? Math.max(0, Math.round(Number(cats.find((c: any) => String(c?.size || '').trim().toLowerCase() === fullSize.toLowerCase())?.price || 0) * 100))
      : 0;

    // Exploit: a customer buys the sampler and receives a credit worth MORE
    // than they paid — repeat forever and they own the store for free.
    if (creditCents > 0 && samplePriceCents > 0 && creditCents >= samplePriceCents) {
      issues.push({
        severity: 'error',
        code: 'sampler_arbitrage',
        message: `Size “${size}” costs ${dollars(samplePriceCents)} but its credit is ${dollars(creditCents)}.`,
        detail: `The customer pays ${dollars(samplePriceCents)} and gets ${dollars(creditCents)} back — a guaranteed profit loop. The credit must be LESS than the sampler price (keep it under ~50–75% for a healthy margin).`,
      });
    }
    // Exploit: credit ≥ full-size price → the full size becomes free.
    if (creditCents > 0 && fullSize && fullPriceCents > 0 && creditCents >= fullPriceCents) {
      issues.push({
        severity: 'error',
        code: 'sampler_free_full',
        message: `Size “${size}” credit (${dollars(creditCents)}) fully covers the ${fullSize} (${dollars(fullPriceCents)}).`,
        detail: 'The full size costs the customer $0 after the credit. Lower the credit or raise the full-size price.',
      });
    }
    // A min-order below (or equal to) the credit lets a customer apply the
    // credit to a tiny order and effectively get that order free.
    if (creditCents > 0 && minOrderCents > 0 && minOrderCents <= creditCents) {
      issues.push({
        severity: 'warning',
        code: 'sampler_min_order_low',
        message: `Size “${size}” credit (${dollars(creditCents)}) is ≥ the minimum next order (${dollars(minOrderCents)}).`,
        detail: 'A customer can buy one item at the minimum and the credit wipes it out. Set the minimum order ABOVE the credit value.',
      });
    }
    // A sampler must point at a real size on the product.
    if (fullSize && !cats.some((c: any) => String(c?.size || '').trim().toLowerCase() === fullSize.toLowerCase())) {
      issues.push({
        severity: 'warning',
        code: 'sampler_stale_target',
        message: `Option “${size}” credits toward “${fullSize}”, which isn't a variant on this product.`,
        detail: '“Credits toward” should be one of the variants in Pricing & Variants (or left empty for “any next order”).',
      });
    }
  }


  // ── Inventory math: per-size stock should reconcile with the total ───────
  const perSizeKeys = Object.keys(inventoryPerSize);
  if (perSizeKeys.length > 0) {
    const perSizeTotal = perSizeKeys.reduce((sum, k) => sum + Math.max(0, Number(inventoryPerSize[k]) || 0), 0);
    const hasMatchingKeys = perSizeKeys.every((k) => cats.some((c: any) => String(c?.size || '').trim().toLowerCase() === k.toLowerCase()));
    if (!hasMatchingKeys) {
      issues.push({
        severity: 'warning',
        code: 'inventory_stale_keys',
        message: 'Per-variant inventory mentions an option that no longer exists in Pricing & Variants.',
        detail: 'Renaming or deleting a variant should re-key its stock automatically — if you see this, re-save the variant so the stale record is dropped.',
      });
    } else if (totalInventory > 0 && perSizeTotal !== totalInventory) {
      issues.push({
        severity: 'warning',
        code: 'inventory_mismatch',
        message: `Per-size inventory sums to ${perSizeTotal} but Total inventory is ${totalInventory}.`,
        detail: 'These should agree — the storefront’s sold-out logic keys off the total while live states seed per size. Make them match or clear the per-size values.',
      });
    }
  }

  if (totalInventory > 0 && Number(product?.maxPerEmail) > 0 && Number(product.maxPerEmail) > totalInventory) {
    issues.push({
      severity: 'warning',
      code: 'max_per_email_over_inventory',
      message: `Max per email (${product.maxPerEmail}) exceeds total inventory (${totalInventory}).`,
      detail: 'One customer could take the entire release. Lower the per-email cap.',
    });
  }

  // ── Lifecycle math: timers must open before they end ─────────────────────
  const goLiveMs = product?.goLiveAt ? Date.parse(String(product.goLiveAt)) : NaN;
  const releaseEndsMs = product?.releaseEndsAt ? Date.parse(String(product.releaseEndsAt)) : NaN;
  if (Number.isFinite(goLiveMs) && Number.isFinite(releaseEndsMs) && goLiveMs >= releaseEndsMs) {
    issues.push({
      severity: 'error',
      code: 'go_live_after_end',
      fieldId: 'pf-goliveat',
      message: '“Go live at” is after (or equal to) “Countdown ends at”.',
      detail: 'The release opens after its raffle already ended — it can never go live. Set the countdown end later than go-live.',
    });
  }

  // ── Upcoming lifecycle: “Go live at” is OPTIONAL (it auto-activates when set).
  //    A missing date is perfectly valid — the release just stays queued until
  //    an operator sets one. A PAST date simply means it's ready to publish now.
  if (product?.isUpcoming && Number.isFinite(goLiveMs) && goLiveMs < now) {
    issues.push({
      severity: 'warning',
      code: 'upcoming_golive_past',
      fieldId: 'pf-goliveat',
      message: '“Go live at” is in the past — this release is ready to publish now.',
      detail: 'Move “Go live at” to the future, or switch the status to Active to publish immediately.',
    });
  }

  const hasRecurring = Boolean(product?.customDropSchedule) || Object.values(product?.sizeConfigs || {}).some((cfg: any) => Boolean(cfg?.customDropSchedule));
  const isActive = product?.isActive !== false && !product?.isArchived;
  if (isActive && !product?.isUpcoming && Number.isFinite(releaseEndsMs) && releaseEndsMs < now && !hasRecurring) {
    issues.push({
      severity: 'warning',
      code: 'released_in_past',
      fieldId: 'pf-releaseends',
      message: '“Countdown ends at” is in the past and there is no recurring schedule.',
      detail: 'The next page load will draw/close this pool immediately. If that was intended (a one-shot drop), archive it or set a future timer.',
    });
  }
  if (isActive && !product?.isUpcoming && totalInventory === 0) {
    issues.push({
      severity: 'warning',
      code: 'no_inventory',
      message: 'Total inventory is 0 while the product is live.',
      detail: 'The storefront shows this release as sold out instantly. Set a real stock count or mark it upcoming.',
    });
  }

  // ── Stripe readiness (soft) ──────────────────────────────────────────────
  if (!ctx.globalStripeConfigured) {
    const missingStripe = cats.filter((c: any) => !String(c?.stripeId || '').trim());
    if (cats.length > 0 && missingStripe.length === cats.length) {
      issues.push({
        severity: 'warning',
        code: 'no_stripe',
        message: 'No size has a Stripe Price ID and no global fallback is configured.',
        detail: 'Checkout will fail with “price not configured”. Add per-size Stripe IDs or set STRIPE_PRODUCT_ID in the platform environment.',
      });
    }
  }

  return issues;
}


/**
 * Global rewards math check (admin → Settings → Rewards & Points).
 * A customer should NEVER earn points faster than they can be redeemed,
 * and gift discounts must stay below face value.
 */
export function checkRewardsSanity(rewards: {
  purchasePointsPerDollar?: number;
  pointsPerDollar?: number;
  minRedeemPoints?: number;
  giftDiscountPercent?: number;
} = {}): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const earn = Math.max(0, Number(rewards?.purchasePointsPerDollar) || 0);
  const redeem = Math.max(0, Number(rewards?.pointsPerDollar) || 0);

  if (earn > 0 && redeem > 0) {
    if (earn >= redeem) {
      issues.push({
        severity: 'error',
        code: 'reward_arbitrage',
        message: `Customers earn ${earn} points per $1 spent but only ${redeem} points buy $1 of credit.`,
        detail: `Spending $1 earns ${earn} points, which redeems for $${(earn / redeem).toFixed(2)} of credit — customers effectively get money back for every purchase and could farm it. The redeem rate must be HIGHER than the earn rate (e.g. earn 10, redeem 100).`,
      });
    } else if (earn >= redeem * 0.6) {
      issues.push({
        severity: 'warning',
        code: 'reward_thin_margin',
        message: `Earning ${earn} points per $1 is aggressive against a ${redeem}-points-per-$1 redeem rate.`,
        detail: `Every $1 of purchase returns up to $${(earn / redeem).toFixed(2)} in credit — about ${Math.round((earn / redeem) * 100)}% cashback. Consider a lower earn rate or a higher redeem rate for a sustainable margin.`,
      });
    }
  }

  const gift = Math.max(0, Number(rewards?.giftDiscountPercent) || 0);
  if (gift >= 100) {
    issues.push({
      severity: 'error',
      code: 'gift_full_value',
      message: `Gift credit discount is ${gift}%.`,
      detail: 'A 100%+ gift discount makes gifted credits worth more than their face value — customers could gift credits to farm value. Keep it well below 100 (the default is 10).',
    });
  } else if (gift >= 50) {
    issues.push({
      severity: 'warning',
      code: 'gift_high_discount',
      message: `Gift credit discount is ${gift}% — gifted credits are worth ${gift}% less than face value.`,
      detail: 'High gift discounts make gift-sharing less attractive and invite gifting loops. The default is 10%.',
    });
  }

  return issues;
}

/** Severity-aware sort: errors first, then warnings, then info. */
export function sortSanityIssues(issues: SanityIssue[]): SanityIssue[] {
  const order: Record<SanitySeverity, number> = { error: 0, warning: 1, info: 2 };
  return [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Human label for a severity. */
export function severityLabel(severity: SanitySeverity): string {
  return severity === 'error' ? 'Blocking' : severity === 'warning' ? 'Warning' : 'Tip';
}

