/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RAFFLE DRAW — pure winner-selection logic for the Postgres-backed
 * `raffle_entries` table (supabase/migrations/00012_drop_mode_schema.sql).
 *
 * Mirrors the EXACT algorithm lib/draw.ts already uses for the live
 * Redis-backed raffle engine (a Fisher-Yates shuffle, then take the first
 * `winnerCount`) — same fairness guarantee, same distribution, just over a
 * different entry source. Kept as its own zero-import pure module (mirrors
 * lib/b2b/pricing.ts / lib/b2b/approval.ts) so the selection algorithm is
 * directly unit-testable, including with a seeded RNG for deterministic
 * test runs — lib/draw.ts's own shuffle is NOT independently testable this
 * way today (it's inlined in a large I/O function), so this is also a
 * strict improvement in verifiability for the same algorithm.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Fisher-Yates shuffle (in place on a COPY of `input`, never mutates the
 *  caller's array). `rng` defaults to `Math.random` but accepts an
 *  injected deterministic generator for tests. */
export function shuffle<T>(input: readonly T[], rng: () => number = Math.random): T[] {
  const arr = input.slice();
  for (let index = arr.length - 1; index > 0; index -= 1) {
    const j = Math.floor(rng() * (index + 1));
    [arr[index], arr[j]] = [arr[j], arr[index]];
  }
  return arr;
}

export interface DrawSelection<T> {
  winners: T[];
  notSelected: T[];
}

/**
 * Select up to `winnerCount` winners from `entries` (order-independent —
 * shuffles first). `winnerCount` is clamped to [0, entries.length]; a
 * negative, zero, or NaN value selects nobody, never throws. `Infinity` (or
 * any count at/above the entry pool size) selects everyone — `Math.min`
 * below does the capping, so no separate finiteness check is needed.
 */
export function selectWinners<T>(entries: readonly T[], winnerCount: number, rng: () => number = Math.random): DrawSelection<T> {
  const count = !Number.isNaN(winnerCount) && winnerCount > 0 ? Math.floor(winnerCount) : 0;
  const shuffled = shuffle(entries, rng);
  const capped = Math.min(count, shuffled.length);
  return {
    winners: shuffled.slice(0, capped),
    notSelected: shuffled.slice(capped),
  };
}
