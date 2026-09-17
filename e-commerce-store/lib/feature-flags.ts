/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FEATURE FLAGS — the Postgres cutover switch.
 *
 * `USE_POSTGRES_PRIMARY` turns on the Postgres paths. What that means has
 * changed as the migrations landed, and this comment was stale for a long
 * time — it claimed a read cutover was blocked by schema gaps
 * (`orders.checkout_mode`, raffle-entries-charged-later, shared pools) that
 * 00011, 00012 and 00013 had already closed. Verified against the live
 * database before this was rewritten; every one of those columns and tables
 * exists.
 *
 * Today the flag makes Postgres AUTHORITATIVE for the catalog (H3), inventory
 * (H4), raffle entries (H5), customers and their loyalty balance (H6/H7),
 * carts, and ORDERS (lib/order-write.ts). The Redis path remains as a mirror
 * for the surfaces not yet repointed — see ARCHITECTURE.md's phase log for
 * what is still on it. Off by default — setting the env var is the only way
 * to turn it on, and unsetting it is the only revert needed.
 *
 * Zero imports — edge-safe, `node --test`-loadable, mirrors lib/csrf.ts /
 * lib/env-schema.ts's design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function isPostgresPrimaryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.USE_POSTGRES_PRIMARY || '').trim().toLowerCase() === 'true';
}
