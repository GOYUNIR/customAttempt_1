/**
 * USAGE METRICS in Postgres (H8).
 *
 * `analytics:usage:<tenant>:<day>` was a KV hash of counters. This writes the
 * same information to `public.analytics_events` (00001), which had been sitting
 * in the schema with ZERO writers and ZERO readers since it was created.
 *
 * COUNTER -> EVENTS, and why that is affordable here. The KV version stored one
 * number per metric per day and incremented it; this stores one ROW per
 * occurrence. That trade would be wrong on a hot path — it is a database write
 * per request — but `trackUsage` has exactly three call sites, all of them AI
 * generation routes (app/api/ai/{animation,generate,shader-prompt}), and an AI
 * generation is a slow, expensive, human-triggered operation. One row each is
 * nothing, and rows are worth more than a counter: they carry WHEN, so a
 * rolling window is a query rather than a fan-out of per-day key reads.
 *
 * Note while reading the admin analytics screen: `api_calls` and
 * `system_events` have no writer anywhere in the app and never did. They read
 * as zero here for the same reason they read as zero before — not because this
 * migration lost them.
 *
 * TENANT IDS. The KV key took any string and sanitised it ('default' was the
 * usual value). `analytics_events.tenant_id` is a uuid FK to `tenants`, so a
 * caller that says 'default' is resolved to the real default tenant rather than
 * silently dropped.
 */
import { getDb } from '@/lib/db/client';
import { eq, gte } from '@/lib/db/query';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { USAGE_METRICS, lastDayStamps, type UsageMetric, type UsageTotals } from '@/lib/analytics';

/** `analytics_events.event_type`'s CHECK constraint is singular; our metric
 *  names are plural. One mapping, in one place. */
const EVENT_TYPE_FOR_METRIC: Record<UsageMetric, string> = {
  api_calls: 'api_call',
  ai_generations: 'ai_generation',
  system_events: 'system_event',
};

const EMPTY: UsageTotals = { api_calls: 0, ai_generations: 0, system_events: 0 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve whatever the caller called a tenant into a real tenant uuid.
 * Anything that is not already a uuid (including the legacy literal 'default')
 * becomes the default tenant.
 */
export async function resolveTenantUuid(tenantId?: string | null): Promise<string> {
  const raw = String(tenantId || '').trim();
  if (UUID_RE.test(raw)) return raw;
  return ensureDefaultTenant();
}

/**
 * Record one usage occurrence.
 *
 * Best-effort, like the KV version every call site already wraps in
 * `.catch(() => {})`: a metrics write must never fail the AI generation the
 * customer is waiting on. It returns whether the row landed so a caller that
 * cares can say so, rather than forcing every caller to assume it did.
 */
export async function recordUsageEvent(input: {
  tenantId?: string | null;
  metric: UsageMetric;
  amount?: number;
  occurredAt?: Date;
}): Promise<boolean> {
  const metric = input.metric;
  if (!EVENT_TYPE_FOR_METRIC[metric]) return false;
  const amount = Math.max(1, Math.floor(Number(input.amount ?? 1)));
  try {
    const tenantUuid = await resolveTenantUuid(input.tenantId);
    await getDb().insert(
      'analytics_events',
      {
        tenant_id: tenantUuid,
        event_type: EVENT_TYPE_FOR_METRIC[metric],
        metric,
        amount,
        ...(input.occurredAt ? { occurred_at: input.occurredAt.toISOString() } : {}),
      },
      { returning: 'minimal' },
    );
    return true;
  } catch (err) {
    console.error('[analytics-events] usage write failed', metric, (err as Error)?.message || err);
    return false;
  }
}

/**
 * The maximum rows a totals query will pull back.
 *
 * Summing in the application is the honest first cut for a table that has
 * three writers and no rows: it needs no RPC, no view and no new migration.
 * It does NOT scale — the right answer once volume is real is a `sum(amount)
 * group by` in the database (a Postgres function, since PostgREST cannot
 * express an aggregate through this port). The cap exists so that day arrives
 * as a logged warning rather than as quietly wrong numbers on a dashboard.
 */
const TOTALS_ROW_CAP = 10_000;

/** Rolling-window totals for a tenant, read from `analytics_events`. */
export async function readUsageTotalsFromDb(input: {
  tenantId?: string | null;
  days?: number;
}): Promise<UsageTotals> {
  const days = Math.max(1, Math.min(90, Math.floor(Number(input.days ?? 7))));
  const totals: UsageTotals = { ...EMPTY };
  try {
    const tenantUuid = await resolveTenantUuid(input.tenantId);
    // The window starts at midnight UTC of the OLDEST day in the range, which
    // is the same boundary the KV day-stamp keys used — so a switch between
    // the two never moves a total by a partial day.
    const stamps = lastDayStamps(days);
    const from = `${stamps[stamps.length - 1]}T00:00:00.000Z`;

    const rows = (await getDb().select<{ metric: string; amount: number | null }>('analytics_events', {
      where: { tenant_id: eq(tenantUuid), occurred_at: gte(from) },
      select: ['metric', 'amount'],
      limit: TOTALS_ROW_CAP,
    })) as Array<{ metric: string; amount: number | null }>;

    if (rows.length >= TOTALS_ROW_CAP) {
      console.warn(
        `[analytics-events] totals hit the ${TOTALS_ROW_CAP}-row cap for tenant ${tenantUuid} — ` +
          'the numbers below are an UNDERCOUNT. Move this to a database-side aggregate.',
      );
    }

    for (const row of rows) {
      const metric = String(row.metric || '') as UsageMetric;
      if (!USAGE_METRICS.includes(metric)) continue;
      const n = Number(row.amount);
      if (Number.isFinite(n)) totals[metric] += n;
    }
    return totals;
  } catch (err) {
    console.error('[analytics-events] totals read failed', (err as Error)?.message || err);
    return { ...EMPTY };
  }
}
