/**
 * DRAW RUNS — the history of every execution of the draw engine (DEFERRED-7).
 *
 * `draws:last` (a string) and `draws:history` (a capped list) were the only
 * record that a draw had ever happened. Both are KV, both are capped at 100
 * entries, and both vanish with a `wipe`. A draw is the moment this store takes
 * money from a set of customers, so "we kept the last hundred, probably" is not
 * an adequate record of it.
 *
 * WHAT THIS IS NOT: a second copy of the money. `winners` holds the engine's
 * per-winner outcome list, but the authoritative record that a customer was
 * charged is their ORDER (lib/order-write.ts) — `orders.order_ref` is unique
 * per tenant and a winner entry points at it. Two places claiming what someone
 * paid is how they end up disagreeing.
 *
 * FAILURE POSTURE. A draw run is recorded AFTER the charging has finished, so a
 * failure here loses the audit record, not the money. That makes it best-effort
 * — a draw must never be rolled back because its history row would not
 * write — but LOUD, because a missing run record is the thing an incident
 * review would go looking for and not find.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export type DrawWinner = {
  email?: string;
  product?: string;
  size?: string;
  status?: string;
  amountCents?: number;
  orderRef?: string;
  promoCode?: string;
};

export type RecordDrawRunInput = {
  tenantId: string;
  executedAt?: string;
  timezone?: string | null;
  triggerSource: 'auto' | 'manual' | 'dry_run';
  winners: DrawWinner[];
  totalCharges: number;
  totalRevenueCents: number;
};

export type DrawRun = {
  id: string;
  executedAt: string;
  timezone: string | null;
  triggerSource: string;
  totalCharges: number;
  totalRevenueCents: number;
  winners: DrawWinner[];
};

type RunRow = {
  id: string;
  executed_at: string;
  timezone: string | null;
  trigger_source: string;
  total_charges: number | null;
  total_revenue_cents: number | null;
  winners: DrawWinner[] | null;
};

const SELECT = ['id', 'executed_at', 'timezone', 'trigger_source', 'total_charges', 'total_revenue_cents', 'winners'];

const toRun = (row: RunRow): DrawRun => ({
  id: row.id,
  executedAt: row.executed_at,
  timezone: row.timezone,
  triggerSource: row.trigger_source,
  totalCharges: Math.max(0, Math.floor(Number(row.total_charges) || 0)),
  totalRevenueCents: Math.max(0, Math.floor(Number(row.total_revenue_cents) || 0)),
  winners: Array.isArray(row.winners) ? row.winners : [],
});

/** Record one execution of the draw engine. Returns the row id, or null. */
export async function recordDrawRun(input: RecordDrawRunInput): Promise<string | null> {
  if (!getDb().configured) return null;
  try {
    const rows = (await getDb().insert<RunRow>('drop_draw_runs', {
      tenant_id: input.tenantId,
      executed_at: input.executedAt || new Date().toISOString(),
      timezone: input.timezone || null,
      trigger_source: input.triggerSource,
      total_charges: Math.max(0, Math.floor(Number(input.totalCharges) || 0)),
      total_revenue_cents: Math.max(0, Math.floor(Number(input.totalRevenueCents) || 0)),
      winners: Array.isArray(input.winners) ? input.winners : [],
    })) as RunRow[];
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error(
      '[draw-runs] DRAW RUN NOT RECORDED (' + input.triggerSource + ', ' + input.totalCharges +
        ' charges, ' + input.totalRevenueCents + ' cents). The draw itself completed; this is the ' +
        'audit record that is missing. ' + ((err as Error)?.message || err),
    );
    return null;
  }
}

/**
 * THESE READS THROW. They deliberately do not catch and return empty.
 *
 * An empty list and a failed read mean completely different things here —
 * "no draw has ever run" versus "we cannot tell you what happened" — and a
 * catch that returns `[]` collapses them into the reassuring one. The caller
 * would then render an empty draw history, with no indication that the record
 * of every draw this store has executed simply could not be read.
 *
 * That is the silent-fallback-to-a-plausible-default pattern, and on an audit
 * record for the moment money is taken it is the worse failure of the two.
 * Callers decide what to do with a thrown error; they cannot decide about one
 * they were never told about.
 */

/** The most recent run — what `draws:last` served. Throws if it cannot read. */
export async function readLastDrawRun(tenantId: string): Promise<DrawRun | null> {
  const rows = (await getDb().select<RunRow>('drop_draw_runs', {
    where: { tenant_id: eq(tenantId) },
    select: SELECT,
    order: { column: 'executed_at', ascending: false },
    limit: 1,
  })) as RunRow[];
  return rows?.[0] ? toRun(rows[0]) : null;
}

/** Recent runs, newest first — what `draws:history` served, uncapped by a list
 *  length. Throws if it cannot read; an empty array means there are none. */
export async function listDrawRuns(tenantId: string, limit = 50): Promise<DrawRun[]> {
  const rows = (await getDb().select<RunRow>('drop_draw_runs', {
    where: { tenant_id: eq(tenantId) },
    select: SELECT,
    order: { column: 'executed_at', ascending: false },
    limit: Math.max(1, Math.min(200, limit)),
  })) as RunRow[];
  return (rows || []).map(toRun);
}
