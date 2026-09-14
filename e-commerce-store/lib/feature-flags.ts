/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FEATURE FLAGS — the Postgres cutover switch.
 *
 * `USE_POSTGRES_PRIMARY` does NOT (yet) make Postgres the authoritative
 * read/write source for checkout/catalog — see the header on
 * lib/postgres-shadow-write.ts for exactly why, and what a real read
 * cutover for THIS store (raffle/FCFS drop mechanics, not generic retail)
 * actually requires. Today the flag turns on SHADOW WRITES: every real
 * checkout/cart mutation is best-effort mirrored into the 00009 Postgres
 * tables, alongside (never instead of) the existing Redis path, so the
 * write path gets validated against live traffic before anything is ever
 * switched to read from it. Off by default — setting the env var is the
 * only way to turn it on, and unsetting it is the only revert needed.
 *
 * Zero imports — edge-safe, `node --test`-loadable, mirrors lib/csrf.ts /
 * lib/env-schema.ts's design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function isPostgresPrimaryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.USE_POSTGRES_PRIMARY || '').trim().toLowerCase() === 'true';
}
