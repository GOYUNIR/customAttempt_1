/**
 * Edge-cache response headers that work across hosting platforms.
 *
 * Each platform's CDN reads a different header:
 *
 *   - Vercel honors `s-maxage` inside `Cache-Control`.
 *   - Netlify's CDN honors the `CDN-Cache-Control` response header (when
 *     present it is authoritative over `Cache-Control`'s `s-maxage`).
 *   - Cloudflare honors both `s-maxage` and `CDN-Cache-Control`.
 *
 * Shipping both headers is safe everywhere: platforms that ignore one simply
 * use the other, so a body rendered once at the origin is served by every
 * platform's edge network instead of being streamed on every request. Browsers
 * always see `Cache-Control` (so JSON routes keep their no-`max-age` rule —
 * only the CDN layer is told to hold the body).
 */
export function edgeCacheHeaders(cacheControl: string): Record<string, string> {
  return {
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
  };
}
