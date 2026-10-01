/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE UNIT-ECONOMICS LEDGER — what the Growth layer costs us to run.
 *
 * Every billable unit a module consumes is recorded here, priced at the moment
 * of use, per tenant and per module. That makes gross margin per account and
 * per module answerable at any time instead of at the end of a billing cycle.
 *
 * PRICED AT THE MOMENT OF USE, never recomputed. When a provider changes a
 * rate, last quarter's margin must not change with it.
 *
 * THE FREE-TIER HEADROOM CHECK IS THE POINT, not a nicety. Resend's free tier
 * is 3,000 emails a month, and one merchant running cart recovery at ~2,000
 * orders/month consumes essentially all of it. "We will notice when the bill
 * arrives" fails here, because what arrives is not a bill — it is sends that
 * stop. `usageHeadroom` is designed to be called BEFORE a batch, so the warning
 * lands while there is still room to act.
 *
 * FAILS OPEN, deliberately. If the ledger cannot be written, the send still
 * happens and the cost is logged loudly. Losing a cost record is an accounting
 * problem; refusing to send a customer their failed-payment notice because our
 * bookkeeping is down is a customer problem, and the customer's is worse.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { getDb } from '@/lib/db/client';
import { eq, gte } from '@/lib/db/query';
import {
  computeHeadroom,
  currentPeriodStart,
  type Headroom,
  type Micros,
} from '@/lib/growth/units';

// Re-exported so callers have one import for the ledger surface; the arithmetic
// itself lives in lib/growth/units.ts, which is import-free and therefore
// loadable under `node --test` and in the Edge runtime.
export {
  MICROS_PER_CENT, MICROS_PER_USD, microsToCents, formatMicrosAsUsd,
  usdPerThousand, currentPeriodStart, computeHeadroom, headroomMessage,
  marginPercent, HEADROOM_WARN_AT,
} from '@/lib/growth/units';
export type { Headroom, Micros } from '@/lib/growth/units';


export type ProviderRate = {
  provider: string;
  unit: string;
  unitCostMicros: number;
  includedUnits: number;
  period: string;
  sourceUrl: string | null;
};

type RateRow = {
  provider: string;
  unit: string;
  unit_cost_micros: number | string;
  included_units: number | string;
  period: string;
  source_url: string | null;
};

/**
 * The active rate for a unit, or null when none is configured.
 *
 * Null is NOT treated as free by callers. A unit with no rate is a unit whose
 * cost we do not know, and recording it as zero would make an unknown cost look
 * like a solved one — the exact failure this ledger exists to prevent.
 */
/**
 * Rates are a provider price list — they change when Resend changes its pricing,
 * which is a quarterly event, not a per-request one. Re-reading the row on every
 * send would put a database round trip in front of every transactional email in
 * the platform, and the ledger has to be cheap enough that nobody is ever
 * tempted to switch it off to save latency. A minute of staleness on a number
 * that moves four times a year costs nothing.
 */
const RATE_CACHE_MS = 60_000;
const rateCache = new Map<string, { at: number; rate: ProviderRate | null }>();

export async function readRate(unit: string, provider?: string): Promise<ProviderRate | null> {
  if (!unit) return null;
  // Per provider when known (email has several: Cloudflare, Resend, the
  // sink); the newest row for the unit otherwise.
  const cacheKey = unit + '|' + (provider || '');
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RATE_CACHE_MS) return cached.rate;
  try {
    const rows = (await getDb().select<RateRow>('provider_rates', {
      where: provider ? { unit: eq(unit), provider: eq(provider) } : { unit: eq(unit) },
      select: ['provider', 'unit', 'unit_cost_micros', 'included_units', 'period', 'source_url'],
      order: { column: 'effective_from', ascending: false },
      limit: 1,
    })) as RateRow[];
    const row = rows?.[0];
    const rate: ProviderRate | null = row
      ? {
          provider: row.provider,
          unit: row.unit,
          unitCostMicros: Math.max(0, Math.floor(Number(row.unit_cost_micros) || 0)),
          includedUnits: Math.max(0, Math.floor(Number(row.included_units) || 0)),
          period: row.period,
          sourceUrl: row.source_url,
        }
      : null;
    rateCache.set(cacheKey, { at: Date.now(), rate });
    return rate;
  } catch (err) {
    console.error('[growth-ledger] rate lookup failed for ' + unit, (err as Error)?.message || err);
    // A failed lookup is NOT cached. Caching it would turn one transient
    // outage into a minute of silently unpriced usage.
    return null;
  }
}

/** Drop the memo. For tests and for an admin who has just edited a rate. */
export function clearRateCache(): void {
  rateCache.clear();
}

export type RecordUsageInput = {
  tenantId: string;
  moduleId: string;
  unit: string;
  quantity?: number;
  reference?: string | null;
  /** Which provider carried it (email): picks the rate, and is stored. */
  provider?: string | null;
};

/**
 * Record consumed units. Returns what it cost, or null when it could not be
 * recorded — the caller proceeds either way (see the fail-open note above).
 */
export async function recordUsage(input: RecordUsageInput): Promise<Micros | null> {
  const quantity = Math.max(0, Math.floor(Number(input.quantity ?? 1)));
  if (!input.tenantId || !input.moduleId || !input.unit || quantity === 0) return null;

  const rate = await readRate(input.unit, input.provider || undefined);
  if (!rate) {
    console.error(
      '[growth-ledger] NO RATE CONFIGURED for unit "' + input.unit + '" (module ' + input.moduleId +
        '). The usage is recorded at zero cost, which UNDERSTATES cost-to-serve until a rate row is added.',
    );
  }
  const costMicros = (rate?.unitCostMicros ?? 0) * quantity;

  const row = {
    tenant_id: input.tenantId,
    module_id: input.moduleId,
    unit: input.unit,
    quantity,
    cost_micros: costMicros,
    reference: input.reference || null,
  };
  try {
    try {
      await getDb().insert('usage_events', { ...row, ...(input.provider ? { provider: input.provider } : {}) }, { returning: 'minimal' });
    } catch (err) {
      // A database without the provider column (before 00042) still gets the
      // cost row; only which provider carried it is lost.
      if (!input.provider || !/provider/i.test(String((err as Error)?.message || err))) throw err;
      await getDb().insert('usage_events', row, { returning: 'minimal' });
    }
    return costMicros;
  } catch (err) {
    console.error(
      '[growth-ledger] usage NOT recorded (' + input.moduleId + '/' + input.unit + ' x' + quantity +
        '). The work still happened; this is a missing cost record.',
      (err as Error)?.message || err,
    );
    return null;
  }
}




/**
 * How much of a provider's free allowance is left this period, ACROSS ALL
 * TENANTS.
 *
 * Platform-wide on purpose: Resend's 3,000/month is OUR allowance, not each
 * merchant's. A per-tenant view would show three merchants each comfortably
 * under "their" limit while the account as a whole had already stopped sending.
 */
export async function usageHeadroom(unit: string, provider?: string): Promise<Headroom | null> {
  const rate = await readRate(unit, provider);
  if (!rate) return null;
  try {
    const rows = (await getDb().select<{ quantity: number | string; provider: string | null }>('usage_events', {
      where: { unit: eq(unit), occurred_at: gte(currentPeriodStart()) },
      select: ['quantity', 'provider'],
      limit: 10000,
    })) as Array<{ quantity: number | string; provider: string | null }>;
    // A provider's allowance counts that provider's sends. Rows from before
    // the provider was recorded (00042) were all the configured provider's.
    const used = rows
      .filter((r) => !provider || r.provider === provider || r.provider == null)
      .reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    return computeHeadroom({
      unit,
      provider: rate.provider,
      used,
      includedUnits: rate.includedUnits,
      overageCostPerUnitMicros: rate.unitCostMicros,
      sourceUrl: rate.sourceUrl,
    });
  } catch (err) {
    console.error('[growth-ledger] headroom check failed for ' + unit, (err as Error)?.message || err);
    return null;
  }
}


export type ModuleCost = { moduleId: string; costMicros: number; units: number };

/** Cost-to-serve this period, by module, for one tenant or the whole platform. */
export async function costByModule(tenantId?: string | null): Promise<ModuleCost[]> {
  try {
    const where: Record<string, ReturnType<typeof eq>> = { occurred_at: gte(currentPeriodStart()) };
    if (tenantId) where.tenant_id = eq(tenantId);
    const rows = (await getDb().select<{ module_id: string; cost_micros: number | string; quantity: number | string }>(
      'usage_events',
      { where, select: ['module_id', 'cost_micros', 'quantity'], limit: 10000 },
    )) as Array<{ module_id: string; cost_micros: number | string; quantity: number | string }>;

    const byModule = new Map<string, ModuleCost>();
    for (const r of rows) {
      const entry = byModule.get(r.module_id) || { moduleId: r.module_id, costMicros: 0, units: 0 };
      entry.costMicros += Number(r.cost_micros) || 0;
      entry.units += Number(r.quantity) || 0;
      byModule.set(r.module_id, entry);
    }
    return [...byModule.values()].sort((a, b) => b.costMicros - a.costMicros);
  } catch (err) {
    console.error('[growth-ledger] cost rollup failed', (err as Error)?.message || err);
    return [];
  }
}
