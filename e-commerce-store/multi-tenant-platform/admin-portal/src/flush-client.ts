/**
 * Admin Portal → Worker `/api/flush-cache` client.
 *
 * Alternative to the direct Cloudflare API purge (`cloudflare-kv.ts`): instead
 * of needing `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_KV_NAMESPACE_ID` /
 * `CLOUDFLARE_API_TOKEN`, this simply POSTs the site's hostname to the Worker's
 * `/api/flush-cache` route with a shared bearer secret (the Worker's
 * `FLUSH_CACHE_SECRET`). The result is identical — the next visitor is served
 * a freshly compiled payload. Pick whichever invalidation path you prefer.
 */

export interface FlushCacheResponse {
  ok: boolean;
  hostname?: string;
  siteKey?: string;
  flushedKeys?: string[];
  error?: string;
}

export class FlushCacheError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FlushCacheError';
    this.status = status;
  }
}

/**
 * Invalidate a tenant's KV cache through the Worker.
 *
 * @param workerBaseUrl  e.g. `https://template-edge-renderer.<account>.workers.dev`
 * @param flushSecret    the Worker's `FLUSH_CACHE_SECRET` (same value everywhere)
 * @param hostname       full host, bare subdomain, or custom domain of the site
 */
export async function flushSiteCache(
  workerBaseUrl: string,
  flushSecret: string,
  hostname: string,
): Promise<FlushCacheResponse> {
  const base = workerBaseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new FlushCacheError('workerBaseUrl is required', 400);
  const trimmed = hostname.trim();
  if (!trimmed) throw new FlushCacheError('hostname is required', 400);

  const response = await fetch(`${base}/api/flush-cache`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${flushSecret}`,
    },
    body: JSON.stringify({ hostname: trimmed }),
  });

  const payload = (await response.json().catch(() => null)) as FlushCacheResponse | null;
  if (!response.ok || !payload?.ok) {
    throw new FlushCacheError(payload?.error ?? `Flush failed with status ${response.status}`, response.status);
  }
  return payload;
}
