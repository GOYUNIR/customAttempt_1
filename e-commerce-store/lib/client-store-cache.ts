/**
 * Tiny client-side request cache + in-flight deduplication for the public
 * store API, hardened for slow/lossy connections.
 *
 * During a single page load several components (SiteChrome, HomePage) request
 * the same `/api/store` payload. This module turns that into one network round
 * trip and reuses the result for a few seconds, so page loads (and back/forward
 * navigation) stay snappy without any visible behavior change.
 *
 * Slow-connection behaviour:
 * - Fresh TTL (10s): cached payloads are reused within the window.
 * - Stale-while-revalidate: after the fresh window the LAST payload is served
 *   IMMEDIATELY (up to STALE_MAX_AGE) while a background refresh replaces it —
 *   a page never sits on a blank section waiting for a congested tower.
 * - Timeout: every network attempt is aborted after FETCH_TIMEOUT_MS so a dead
 *   connection can't hang the UI forever.
 * - Retry: a failed/timeout attempt is retried once after a short backoff
 *   (mobile handoffs, congested towers) before the error reaches the caller —
 *   and if ANY stale payload exists it is preferred over surfacing the error.
 */

const FRESH_TTL_MS = 10_000;
/** Oldest cache entry we are willing to serve instead of an error. */
const STALE_MAX_AGE_MS = 5 * 60 * 1000;
/** Hard cap for one network attempt. */
const FETCH_TIMEOUT_MS = 10_000;
/** Backoff between the first attempt and the retry. */
const RETRY_DELAY_MS = 700;

const inflight = new Map<string, Promise<unknown>>();
const refreshing = new Set<string>();
const cache = new Map<string, { data: unknown; at: number }>();

async function fetchWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, attempt = 0): Promise<unknown> {
  try {
    return await fetchWithTimeout(url);
  } catch (err) {
    const hit = cache.get(url);
    if (attempt === 0) {
      // Transient network blips are common on mobile connections — give the
      // request one more shot after a short backoff before giving up.
      await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
      return fetchWithRetry(url, attempt + 1);
    }
    // Still failing but we have a cached payload? Prefer stale data over an
    // error screen — the section keeps working and the background refresh on
    // the next visit will repair it.
    if (hit) return hit.data;
    throw err;
  }
}

export function fetchStoreJson<T = any>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const hit = cache.get(url);
  const now = Date.now();
  if (hit) {
    if (now - hit.at < FRESH_TTL_MS) return Promise.resolve(hit.data as T);

    // Stale-while-revalidate: return the last good payload immediately and
    // refresh in the background (one refresh per URL at a time).
    if (now - hit.at < STALE_MAX_AGE_MS && !refreshing.has(url)) {
      refreshing.add(url);
      fetchWithRetry(url)
        .then((data) => cache.set(url, { data, at: Date.now() }))
        .catch(() => {
          /* keep serving the stale payload */
        })
        .finally(() => refreshing.delete(url));
      return Promise.resolve(hit.data as T);
    }
  }

  const promise = fetchWithRetry(url)
    .then((data: unknown) => {
      cache.set(url, { data, at: Date.now() });
      return data;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise as Promise<T>;
}
