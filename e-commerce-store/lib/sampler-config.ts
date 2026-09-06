/**
 * Trial-size ("sampler") engine — shared by the admin product panel, the
 * storefront and the delivery-credit shipping routes.
 *
 * Big-brand pattern: a low-price trial SKU that "pays itself forward". The
 * customer buys the sampler, and once it's marked delivered they receive a
 * one-time credit code toward the full-size SKU — so the full size costs "the
 * difference". Glossier does this with minis, Apple with trade-in credit,
 * Dyson with try-it-first; the point is that EVERY sampler tells its own
 * story (badge, target size, credit value) — never one generic line for the
 * whole product.
 *
 * Every sampler lives on the product as `samplerSizes` (an array of
 * `SamplerConfig`). Each entry carries OPTIONAL overrides; blank/null means
 * "fall back to the product-level deliveryIncentive* defaults", so operators
 * can set one sane default for the whole product and then fine-tune a single
 * sampler (e.g. the 10ml trial gets a bigger credit than the 30ml trial).
 */

export type SamplerConfig = {
  /** Must match a `priceCategories[].size` on the product. */
  size: string;
  /** Badge shown on the storefront size chip + trial card, e.g. "Trial". Default "Sample". */
  label?: string;
  /** The full-size SKU this sampler credits toward. Empty = any next order. */
  fullSize?: string;
  /** Credit value in cents. null → product-level `deliveryIncentiveCreditCents`. */
  creditCents?: number | null;
  /** Minimum next-order subtotal (cents) for the credit. null → product default. */
  minOrderSubtotalCents?: number | null;
  /** Tri-state expiry override. null → product default. */
  neverExpires?: boolean | null;
  /** Validity window in days (when not never-expires). null → product default. */
  expiresDays?: number | null;
  /** Generated-code prefix. Empty/null → product default (then brand-neutral `DROP`). */
  codePrefix?: string | null;
  /** Restrict which products the credit works on. null → product default (all). */
  eligibleProductSlugs?: string[] | null;
  /** Restrict which sizes the credit works on. null → product default (all). */
  eligibleSizes?: string[] | null;
  /** Optional customer-facing line. Empty → auto-generated per-size copy. */
  note?: string | null;
  /**
   * Shared sample reference — links THIS sampler to a standalone sample product
   * so a single trial-SKU definition can be reused across MULTIPLE full-size
   * listings without duplicating its size/price/image/credit data. `sampleRefId`
   * is the linked product's slug; `sampleRefName` is its display name. Empty =
   * the sampler's definition lives on this product (self-contained).
   */
  sampleRefId?: string | null;
  sampleRefName?: string | null;
};

/** A sampler with every override merged against the product-level defaults. */
export type ResolvedSampler = {
  size: string;
  label: string;
  fullSize: string;
  creditCents: number;
  minOrderSubtotalCents: number;
  neverExpires: boolean;
  expiresDays: number;
  codePrefix: string;
  eligibleProductSlugs: string[];
  eligibleSizes: string[];
  note: string;
  sampleRefId: string;
  sampleRefName: string;
};

const cleanSize = (value: unknown): string => String(value ?? '').trim();
const cleanShort = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
const positiveInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
};

/**
 * Sanitize a raw `samplerSizes` array: trim labels, clamp numbers, drop
 * entries that don't match a real priceCategory (unless the list is empty),
 * and dedupe by size. Safe for both the admin write API and the `/api/store`
 * public sanitizer.
 */
export function normalizeSamplerSizes(raw: unknown, priceCategories: unknown[] = []): SamplerConfig[] {
  if (!Array.isArray(raw)) return [];
  const available = new Set(priceCategories.map((c) => cleanSize((c as any)?.size).toLowerCase()));
  const seen = new Set<string>();
  const out: SamplerConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, any>;
    const size = cleanSize(rec.size);
    if (!size) continue;
    const key = size.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A sampler must reference a size that actually exists on the product.
    if (available.size > 0 && !available.has(key)) continue;

    out.push({
      size,
      label: cleanShort(rec.label, 24),
      fullSize: cleanSize(rec.fullSize),
      creditCents: rec.creditCents === null || rec.creditCents === undefined || rec.creditCents === '' ? null : positiveInt(rec.creditCents, 0),
      minOrderSubtotalCents: rec.minOrderSubtotalCents === null || rec.minOrderSubtotalCents === undefined || rec.minOrderSubtotalCents === '' ? null : positiveInt(rec.minOrderSubtotalCents, 0),
      neverExpires: typeof rec.neverExpires === 'boolean' ? rec.neverExpires : null,
      expiresDays: rec.expiresDays === null || rec.expiresDays === undefined || rec.expiresDays === '' ? null : Math.max(1, positiveInt(rec.expiresDays, 60) || 60),
      codePrefix: (cleanShort(rec.codePrefix, 8).toUpperCase().replace(/[^A-Z0-9]/g, '')) || null,
      eligibleProductSlugs: Array.isArray(rec.eligibleProductSlugs) ? rec.eligibleProductSlugs.map(String).filter(Boolean) : null,
      eligibleSizes: Array.isArray(rec.eligibleSizes) ? rec.eligibleSizes.map(String).filter(Boolean) : null,
      note: typeof rec.note === 'string' ? rec.note.trim().slice(0, 200) || null : null,
      sampleRefId: cleanShort(rec.sampleRefId, 64) || null,
      sampleRefName: cleanShort(rec.sampleRefName, 120) || null,
    });
  }
  return out;
}

/** Whether the given size is a sampler on this product (new config OR legacy CSV). */
export function isSamplerSize(product: any, size: string): boolean {
  if (!product || product.deliveryIncentiveEnabled !== true) return false;
  const key = cleanSize(size).toLowerCase();
  if (!key) return false;
  const samplers = Array.isArray(product.samplerSizes) ? product.samplerSizes : [];
  if (samplers.some((s: any) => cleanSize(s?.size).toLowerCase() === key)) return true;
  const legacy = Array.isArray(product.deliveryIncentiveTriggerSizes) ? product.deliveryIncentiveTriggerSizes : [];
  return legacy.some((s: any) => cleanSize(s).toLowerCase() === key);
}


/**
 * Resolve the EFFECTIVE sampler config for a size — per-sampler overrides win,
 * product-level deliveryIncentive* values are the fallback, and a legacy
 * `deliveryIncentiveTriggerSizes` entry (no `samplerSizes` record) still
 * resolves from product defaults. Returns null when delivery credits are
 * disabled or the size isn't a sampler.
 */
export function resolveSamplerConfig(product: any, size: string): ResolvedSampler | null {
  if (!product || product.deliveryIncentiveEnabled !== true) return null;
  const key = cleanSize(size).toLowerCase();
  if (!key) return null;

  const samplers = normalizeSamplerSizes(product.samplerSizes, product.priceCategories || []);
  const sampler = samplers.find((s) => s.size.toLowerCase() === key);
  const legacy = Array.isArray(product.deliveryIncentiveTriggerSizes)
    && product.deliveryIncentiveTriggerSizes.some((s: unknown) => cleanSize(s).toLowerCase() === key);
  if (!sampler && !legacy) return null;

  return {
    size: cleanSize(size),
    label: sampler?.label || 'Sample',
    fullSize: sampler?.fullSize || '',
    creditCents: sampler?.creditCents ?? positiveInt(product.deliveryIncentiveCreditCents, 0),
    minOrderSubtotalCents: sampler?.minOrderSubtotalCents ?? positiveInt(product.deliveryIncentiveMinOrderSubtotalCents, 0),
    neverExpires: sampler?.neverExpires ?? product.deliveryIncentiveNeverExpires === true,
    expiresDays: sampler?.expiresDays ?? Math.max(1, positiveInt(product.deliveryIncentiveExpiresDays, 60) || 60),
    codePrefix: sampler?.codePrefix || String(product.deliveryIncentiveCodePrefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
    eligibleProductSlugs: sampler?.eligibleProductSlugs
      ?? (Array.isArray(product.deliveryIncentiveEligibleProductSlugs) ? product.deliveryIncentiveEligibleProductSlugs : []),
    eligibleSizes: sampler?.eligibleSizes
      ?? (Array.isArray(product.deliveryIncentiveEligibleSizes) ? product.deliveryIncentiveEligibleSizes : []),
    note: sampler?.note || '',
    sampleRefId: sampler?.sampleRefId || '',
    sampleRefName: sampler?.sampleRefName || '',
  };
}

/** Money from cents: `$19`, `$19.50`. Never renders a raw cent integer. */
export function formatMoneyCents(cents: number): string {
  const value = Math.max(0, Math.round(Number(cents) || 0));
  const dollars = value / 100;
  return Number.isInteger(dollars) ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}


export type SamplerPresentation = {
  enabled: boolean;
  /** Whether ANY size on this product is a sampler. */
  hasSamplers: boolean;
  /** The trial card for the size the customer has selected right now. */
  selected: {
    isSampler: boolean;
    badge: string;
    headline: string;
    body: string;
    /** Exact upgrade math — shown when the sampler names a full-size target. */
    math: {
      samplePriceCents: number;
      creditCents: number;
      fullPriceCents: number;
      /** Full price minus the credit — the "you only pay" number. */
      remainingCents: number;
      pctCovered: number;
      fullSize: string;
    } | null;
    note: string;
  };
  /** Shown when a NON-sampler size is selected but samplers exist. */
  nudge: {
    badge: string;
    size: string;
    priceCents: number;
    creditCents: number;
    fullSize: string;
  } | null;
};

function priceCentsOf(product: any, size: string): number {
  const cat = (product?.priceCategories || []).find(
    (c: any) => cleanSize(c?.size).toLowerCase() === cleanSize(size).toLowerCase(),
  );
  return Math.max(0, Math.round(Number(cat?.price || 0) * 100));
}

/**
 * Build the storefront presentation for a product + currently-selected size.
 * The copy is generated PER SIZE so the customer never sees one generic line:
 * a selected sampler gets a headline, its specific credit math and the exact
 * remaining balance; a selected non-sampler gets a gentle upgrade nudge.
 */
export function samplerPresentation(product: any, selectedSize: string): SamplerPresentation {
  const enabled = product?.deliveryIncentiveEnabled === true;
  const samplers = enabled ? normalizeSamplerSizes(product?.samplerSizes, product?.priceCategories || []) : [];
  const legacyTriggers = enabled && Array.isArray(product?.deliveryIncentiveTriggerSizes)
    ? product.deliveryIncentiveTriggerSizes.map((s: unknown) => cleanSize(s)).filter(Boolean)
    : [];
  const samplerSizeNames = Array.from(new Set([...samplers.map((s) => s.size), ...legacyTriggers]));
  const hasSamplers = enabled && samplerSizeNames.length > 0;

  const selectedSampler = enabled ? resolveSamplerConfig(product, cleanSize(selectedSize)) : null;
  const isSelectedSampler = selectedSampler !== null;

  let selected: SamplerPresentation['selected'];
  if (isSelectedSampler && selectedSampler) {
    const samplePriceCents = priceCentsOf(product, selectedSampler.size);
    const fullPriceCents = selectedSampler.fullSize ? priceCentsOf(product, selectedSampler.fullSize) : 0;
    const creditCents = selectedSampler.creditCents;
    const remainingCents = Math.max(0, fullPriceCents - creditCents);
    const pctCovered = fullPriceCents > 0 ? Math.round((creditCents / fullPriceCents) * 100) : 0;
    const badge = selectedSampler.label || 'Sample';

    let body: string;
    if (selectedSampler.fullSize && fullPriceCents > 0 && creditCents > 0) {
      body = `Your ${selectedSampler.size} (${formatMoneyCents(samplePriceCents)}) ships with a ${formatMoneyCents(creditCents)} credit after delivery. Put it toward the ${selectedSampler.fullSize} (${formatMoneyCents(fullPriceCents)}) and you only pay ${formatMoneyCents(remainingCents)}.`;
    } else if (creditCents > 0) {
      body = `Your ${selectedSampler.size} (${formatMoneyCents(samplePriceCents)}) ships with a ${formatMoneyCents(creditCents)} credit after delivery. Apply it to your next full-size order — you only pay the difference.`;
    } else {
      body = `Your ${selectedSampler.size} (${formatMoneyCents(samplePriceCents)}) is the low-risk way in — take your time with it, then come back for the full size when you're ready.`;
    }

    selected = {
      isSampler: true,
      badge,
      headline: `Try the ${badge} first`,
      body,
      math: selectedSampler.fullSize && fullPriceCents > 0
        ? { samplePriceCents, creditCents, fullPriceCents, remainingCents, pctCovered, fullSize: selectedSampler.fullSize }
        : null,
      note: selectedSampler.note,
    };
  } else {
    selected = { isSampler: false, badge: '', headline: '', body: '', math: null, note: '' };
  }

  // Gentle upgrade nudge for a non-sampler selection — entice with the first sampler.
  let nudge: SamplerPresentation['nudge'] = null;
  if (!isSelectedSampler && samplerSizeNames.length > 0) {
    const firstSize = samplers.length > 0 ? samplers[0].size : legacyTriggers[0];
    const resolved = enabled ? resolveSamplerConfig(product, firstSize) : null;
    if (resolved) {
      nudge = {
        badge: resolved.label || 'Sample',
        size: firstSize,
        priceCents: priceCentsOf(product, firstSize),
        creditCents: resolved.creditCents,
        fullSize: resolved.fullSize,
      };
    }
  }

  return { enabled, hasSamplers, selected, nudge };
}

/**
 * Derive a variant's sample badge from the VARIANT OBJECT itself (a slug-synced
 * variant carries `samplerLabel` copied from its shared pool at link time),
 * falling back to the product-level `samplerSizes` lookup by size string. This
 * lets the storefront render the "🧪 Sample" tag for a synced variant exactly as
 * it would on the standalone source product page — with zero hardcoded data.
 */
export function categorySampleBadge(product: any, category: any): { isSampler: boolean; label: string } {
  const own = String(category?.samplerLabel || category?.samplerConfig?.label || '').trim();
  if (own) return { isSampler: true, label: own };
  const size = String(category?.size || '').trim();
  const rec = size && Array.isArray(product?.samplerSizes)
    ? product.samplerSizes.find((s: any) => String(s?.size || '').trim().toLowerCase() === size.toLowerCase())
    : null;
  if (rec) return { isSampler: true, label: String(rec.label || 'Sample').trim() || 'Sample' };
  return { isSampler: false, label: '' };
}

/**
 * The storefront seed for a synced sample variant. Builds the FULLY-MERGED
 * sampler config for a source product + size (per-sampler overrides over
 * product defaults) AND pre-resolves the sample + full-size prices so the
 * synced variant can render its incentive math with ZERO cross-product lookup.
 * `sampler` is null when the source size is not a sampler.
 */
export function samplerPresentationSeed(
  product: any,
  size: string,
): { sampler: ResolvedSampler | null; samplePriceCents: number; fullPriceCents: number } {
  const resolved = resolveSamplerConfig(product, cleanSize(size));
  if (!resolved) return { sampler: null, samplePriceCents: 0, fullPriceCents: 0 };
  return {
    sampler: resolved,
    samplePriceCents: priceCentsOf(product, resolved.size),
    fullPriceCents: resolved.fullSize ? priceCentsOf(product, resolved.fullSize) : 0,
  };
}


/**
 * Reconstruct a `ResolvedSampler` from a category's self-contained
 * `samplerConfig` snapshot (written onto slug-synced variants at link time).
 * Returns null when the category carries no snapshot.
 */
function normalizeSamplerConfigBlob(blob: any, category: any): ResolvedSampler | null {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  const size = cleanSize(category?.size || blob?.size);
  if (!size) return null;
  return {
    size,
    label: cleanShort(blob.label, 24) || 'Sample',
    fullSize: cleanSize(blob.fullSize),
    creditCents: positiveInt(blob.creditCents, 0),
    minOrderSubtotalCents: positiveInt(blob.minOrderSubtotalCents, 0),
    neverExpires: blob.neverExpires === true,
    expiresDays: Math.max(1, positiveInt(blob.expiresDays, 60) || 60),
    codePrefix: cleanShort(blob.codePrefix, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    eligibleProductSlugs: Array.isArray(blob.eligibleProductSlugs) ? blob.eligibleProductSlugs.map(String).filter(Boolean) : [],
    eligibleSizes: Array.isArray(blob.eligibleSizes) ? blob.eligibleSizes.map(String).filter(Boolean) : [],
    note: cleanShort(blob.note, 200),
    sampleRefId: cleanShort(blob.sampleRefId, 64),
    sampleRefName: cleanShort(blob.sampleRefName, 120),
  };
}

/**
 * Resolve the EFFECTIVE sampler config for a SPECIFIC VARIANT (category object),
 * reading the variant's own `samplerConfig` snapshot first (slug-synced samples)
 * and falling back to the product-level size-string lookup (standalone samples).
 */
export function resolveCategorySamplerConfig(product: any, category: any): ResolvedSampler | null {
  const blobResolved = normalizeSamplerConfigBlob(category?.samplerConfig, category);
  if (blobResolved) return blobResolved;
  const size = cleanSize(category?.size);
  return size ? resolveSamplerConfig(product, size) : null;
}

/**
 * Storefront presentation for a SPECIFIC VARIANT (category object) — the
 * category-aware counterpart of `samplerPresentation`. When the selected variant
 * is a slug-synced SAMPLE (its `samplerConfig` snapshot was copied from a shared
 * pool whose product has no local sampler), this builds the FULL incentive card
 * (badge, credit math, note) from the variant's own snapshot so a synced sample
 * variant renders exactly like its standalone source page.
 */
export function categorySamplerPresentation(product: any, category: any): SamplerPresentation {
  const resolved = resolveCategorySamplerConfig(product, category);
  const base = samplerPresentation(product, cleanSize(category?.size));

  // Fast path: the product-level resolver already produced a selected-sampler
  // card (standalone sample, or the category matches THIS product's samplerSizes).
  if (!resolved) return base;
  if (base.selected.isSampler) return base;

  const blob = category?.samplerConfig && typeof category.samplerConfig === 'object' && !Array.isArray(category.samplerConfig)
    ? category.samplerConfig
    : null;
  const samplePriceCents = blob && Number.isFinite(Number(blob.samplePriceCents))
    ? Math.max(0, Math.round(Number(blob.samplePriceCents)))
    : priceCentsOf(product, resolved.size);
  const fullPriceCents = blob && Number.isFinite(Number(blob.fullPriceCents))
    ? Math.max(0, Math.round(Number(blob.fullPriceCents)))
    : (resolved.fullSize ? priceCentsOf(product, resolved.fullSize) : 0);
  const creditCents = resolved.creditCents;
  const remainingCents = Math.max(0, fullPriceCents - creditCents);
  const pctCovered = fullPriceCents > 0 ? Math.round((creditCents / fullPriceCents) * 100) : 0;
  const badge = resolved.label || 'Sample';

  let body: string;
  if (resolved.fullSize && fullPriceCents > 0 && creditCents > 0) {
    body = `Your ${resolved.size} (${formatMoneyCents(samplePriceCents)}) ships with a ${formatMoneyCents(creditCents)} credit after delivery. Put it toward the ${resolved.fullSize} (${formatMoneyCents(fullPriceCents)}) and you only pay ${formatMoneyCents(remainingCents)}.`;
  } else if (creditCents > 0) {
    body = `Your ${resolved.size} (${formatMoneyCents(samplePriceCents)}) ships with a ${formatMoneyCents(creditCents)} credit after delivery. Apply it to your next full-size order — you only pay the difference.`;
  } else {
    body = `Your ${resolved.size} (${formatMoneyCents(samplePriceCents)}) is the low-risk way in — take your time with it, then come back for the full size when you're ready.`;
  }

  return {
    enabled: true,
    hasSamplers: true,
    selected: {
      isSampler: true,
      badge,
      headline: `Try the ${badge} first`,
      body,
      math: resolved.fullSize && fullPriceCents > 0
        ? { samplePriceCents, creditCents, fullPriceCents, remainingCents, pctCovered, fullSize: resolved.fullSize }
        : null,
      note: resolved.note,
    },
    nudge: base.nudge,
  };
}

