/**
 * SUBREQUEST METER — how close an invocation is to the Worker's ceiling.
 *
 * WHY THIS EXISTS. A Cloudflare Worker gets a fixed budget of outbound
 * subrequests per invocation (50 on the free plan, 1000 on paid), and every
 * PostgREST call spends one. In production `STORAGE_PROVIDER` is `supabase`,
 * so the KV-shaped API in lib/storage/supabase.ts is ALSO PostgREST — a
 * `withRedisLock` costs four HTTP round trips, an `archiveEntry` two per unit.
 *
 * The checkout webhook exhausted that budget on a ONE-ITEM cart and wrote no
 * order, returning 200 to Stripe with the sale unrecorded. The failure was
 * invisible because nothing counted the calls: the only symptom was an
 * exception thrown by whichever call happened to be the one over the line.
 *
 * So this counts them. It is deliberately the crudest thing that works:
 *
 *   - A MONOTONIC PROCESS-WIDE COUNTER, not per-request. Two invocations
 *     sharing an isolate inflate each other's delta. That over-reports, never
 *     under-reports, which is the right direction for a ceiling warning — it
 *     cannot tell you that you are safe when you are not.
 *   - No AsyncLocalStorage, no request context plumbing. Both would be more
 *     accurate and both would cost more than the problem is worth for a
 *     number whose only job is to say "this path is near its limit".
 *
 * Read it with `subrequestCount()` at the start and end of a handler and log
 * the delta. `meteredFetch` is a drop-in for `fetch` at the two places that
 * actually talk to Supabase.
 */

let total = 0;

/** Total outbound calls this isolate has made. Monotonic; compare deltas. */
export function subrequestCount(): number {
  return total;
}

/** `fetch`, counted. Same signature, same behaviour, including on throw. */
export function meteredFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  total += 1;
  return fetch(input as any, init);
}

/**
 * Cloudflare's documented per-invocation ceilings. Used only to decide when a
 * run is worth warning about — never to gate behaviour, because the runtime
 * enforces the real limit and guessing wrong here must not change what runs.
 */
export const SUBREQUEST_LIMIT_FREE = 50;
export const SUBREQUEST_LIMIT_PAID = 1000;

/**
 * Log how much of the budget a handler used. Warns past half the FREE ceiling,
 * because that is the point where one more cart line can push a run over.
 */
export function reportSubrequests(label: string, startedAt: number): number {
  const used = total - startedAt;
  if (used >= SUBREQUEST_LIMIT_FREE) {
    console.error('[subrequests] ' + label + ' used ' + used +
      ' — AT OR OVER the free-plan ceiling of ' + SUBREQUEST_LIMIT_FREE +
      '; work at the end of this handler was dropped');
  } else if (used >= SUBREQUEST_LIMIT_FREE / 2) {
    console.warn('[subrequests] ' + label + ' used ' + used + ' of ' +
      SUBREQUEST_LIMIT_FREE + ' (free plan) — one more line item may exhaust it');
  } else {
    console.log('[subrequests] ' + label + ' used ' + used);
  }
  return used;
}
