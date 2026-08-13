/**
 * Tiny client-side request cache + in-flight deduplication for the public
 * store API.
 *
 * During a single page load several components (SiteChrome, HomePage) request
 * the same `/api/store` payload. This module turns that into one network round
 * trip and reuses the result for a few seconds, so page loads (and back/forward
 * navigation) stay snappy without any visible behavior change.
 */

const DEFAULT_TTL_MS = 10_000;
const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { data: unknown; at: number }>();

export function fetchStoreJson<T = any>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < DEFAULT_TTL_MS) return Promise.resolve(hit.data as T);

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    })
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
