/**
 * ANALYTICS / USAGE METRICS — daily API calls, AI asset generations and system
 * events, tracked PER TENANT.
 *
 * Each tenant's counters live in a daily hash (`analytics:usage:<tenant>:<day>`)
 * so the admin analytics view can chart them over time. Multi-tenant-ready: a
 * `tenantId` (default `default`) scopes every write/read.
 *
 * DESIGN — ZERO-import (no `@/`) so `node --test` loads it directly. Storage is
 * a minimal structural interface; key names are passed in by callers (resolved
 * from `lib/redis-keys.ts`).
 */

export type UsageMetric = 'api_calls' | 'ai_generations' | 'system_events';

export const USAGE_METRICS: readonly UsageMetric[] = ['api_calls', 'ai_generations', 'system_events'];

export interface UsageStorage {
  hincrby(key: string, field: string, by: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string> | null>;
}

/** YYYY-MM-DD (UTC) for a timestamp — the daily rollover boundary. */
export function usageDayStamp(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Build a daily usage hash key: `<prefix>:<tenantId>:<YYYY-MM-DD>`. */
export function usageKey(prefix: string, tenantId: string, day: string): string {
  const t = String(tenantId || 'default').trim().toLowerCase().slice(0, 64) || 'default';
  const d = String(day || '').slice(0, 10);
  return `${prefix}:${t}:${d}`;
}

/** The last `days` day stamps (newest first) ending at `now` — used to read a
 *  rolling window without a Redis scan. */
export function lastDayStamps(days: number, now = Date.now()): string[] {
  const count = Math.max(1, Math.min(days, 90));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(usageDayStamp(now - i * 86_400_000));
  }
  return out;
}

/** Increment one metric for a tenant (auto-scopes to today's key). */
export async function trackUsage(
  storage: UsageStorage,
  input: { prefix: string; tenantId?: string; metric: UsageMetric; amount?: number; now?: number },
): Promise<void> {
  const prefix = input.prefix;
  const key = usageKey(prefix, input.tenantId ?? 'default', usageDayStamp(input.now ?? Date.now()));
  const amount = Math.max(1, Math.floor(input.amount ?? 1));
  await storage.hincrby(key, input.metric, amount);
}

export interface UsageTotals {
  api_calls: number;
  ai_generations: number;
  system_events: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = { api_calls: 0, ai_generations: 0, system_events: 0 };

/** Read + sum a rolling window of daily hashes for one tenant. */
export async function readUsageTotals(
  storage: UsageStorage,
  input: { prefix: string; tenantId?: string; days?: number; now?: number },
): Promise<UsageTotals> {
  const days = lastDayStamps(input.days ?? 7, input.now ?? Date.now());
  const totals: UsageTotals = { ...EMPTY_USAGE_TOTALS };
  for (const day of days) {
    const key = usageKey(input.prefix, input.tenantId ?? 'default', day);
    const row = await storage.hgetall(key);
    if (!row) continue;
    for (const metric of USAGE_METRICS) {
      const n = Number(row[metric]);
      if (Number.isFinite(n)) totals[metric] += n;
    }
  }
  return totals;
}

/** Parse an untrusted hash row into numeric totals (safe against garbage). */
export function totalsFromRow(row: Record<string, string> | null | undefined): UsageTotals {
  const totals: UsageTotals = { ...EMPTY_USAGE_TOTALS };
  if (!row) return totals;
  for (const metric of USAGE_METRICS) {
    const n = Number(row[metric]);
    if (Number.isFinite(n)) totals[metric] = Math.max(0, Math.floor(n));
  }
  return totals;
}
