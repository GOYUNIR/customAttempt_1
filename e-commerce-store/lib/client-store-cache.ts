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

const PREFETCH_URL = '/api/store';

/**
 * A request an inline script already started for this URL: `/api/store` from
 * the document head (app/layout.tsx), and `/api/store?slug=…` from the product
 * page's server HTML (app/[slug]/page.tsx), keyed by the exact URL the
 * component will ask for.
 */
function takePrefetch(url: string, options?: { force?: boolean }): Promise<unknown> | null {
  if (options?.force || typeof window === 'undefined') return null;
  const w = window as unknown as {
    __GOYUNIR_STORE_PREFETCH__?: Promise<unknown>;
    __GOYUNIR_STORE_PREFETCHES__?: Record<string, Promise<unknown> | undefined>;
  };
  let p: Promise<unknown> | undefined;
  if (url === PREFETCH_URL) {
    p = w.__GOYUNIR_STORE_PREFETCH__;
    w.__GOYUNIR_STORE_PREFETCH__ = undefined; // one use: later loads must be fresh
  } else if (w.__GOYUNIR_STORE_PREFETCHES__) {
    p = w.__GOYUNIR_STORE_PREFETCHES__[url];
    delete w.__GOYUNIR_STORE_PREFETCHES__[url];
  }
  if (!p) return null;
  // The same cap as any other attempt: a hung prefetch falls back to a
  // normal request instead of holding the page on its loading state.
  return Promise.race([
    p,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
  ]);
}

export function fetchStoreJson<T = any>(url: string, options?: { force?: boolean }): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const now = Date.now();
  if (!options?.force) {
    const hit = cache.get(url);
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
  }

  // The first /api/store request of a page load was already started by an
  // inline script in the document head (app/layout.tsx). Use it once; if it
  // failed (null), fall back to the normal request with its retry.
  const prefetched = takePrefetch(url, options);

  // `force` bypasses the fresh/stale fast-paths entirely (used when a countdown
  // hit zero and the page needs to see the product's POST-draw state right away,
  // not a 10s-old snapshot).
  const promise = (prefetched
    ? prefetched.then((data) => (data == null ? fetchWithRetry(url) : data))
    : fetchWithRetry(url))
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
