import { getSiteUrl } from '@/lib/env';
import { getRequestSiteUrl } from '@/lib/request-url';

/**
 * Server-only image-source resolver for the ImageResponse routes
 * (`app/og/route.ts`, `app/icon.tsx`).
 *
 * `next/og`'s ImageResponse only accepts ABSOLUTE image sources — an
 * `http(s)://` URL or a `data:` URL. The admin Branding → Logo URL and Share
 * image fields are free text, so a broken placeholder (e.g. the string
 * `"a image url"`) used to crash the ENTIRE social share card with
 * `Image source must be an absolute URL` (a 500 on `/opengraph-image` — which
 * is exactly why link previews showed nothing).
 *
 * Returns '' (callers then fall back to text-only rendering) unless:
 *   - the value is an absolute `http(s)://` or `data:image/…` URL, or
 *   - the value is a root-relative path (`/images/…`, `/uploads/…`) that can
 *     be resolved against the real deployed site URL (env → request host).
 * Anything else is dropped so the card / favicon ALWAYS renders.
 */
export async function resolveBrandImageSource(raw: unknown): Promise<string> {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  if (!value.startsWith('/')) return '';
  const base = String(getSiteUrl() || (await getRequestSiteUrl()) || '').replace(/\/+$/, '');
  return base ? `${base}${value}` : '';
}

// ---------------------------------------------------------------------------
// Safe image loading for satori (ImageResponse).
//
// Even a VALID-format absolute URL can crash the whole card if the remote
// server is slow, down, hotlink-protected or returns a 404/HTML page — satori
// fetches <img> sources itself and throws on any failure, which turns the
// share-card route into a 500 and kills EVERY link preview. We therefore fetch
// remote/relative images OURSELVES (short timeout, content-type + size guard)
// and feed satori only `data:` URLs it can never fail on.
// ---------------------------------------------------------------------------

const REMOTE_IMAGE_TTL_MS = 60_000;
const MAX_IMAGE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 4_000;
const remoteImageCache = new Map<string, { dataUrl: string; expiresAt: number }>();

/**
 * Fetch a remote/relative image and return it as a `data:` URL, or '' on any
 * failure (never throws). Results are cached in-process for 60s so the card
 * route stays fast on warm instances.
 */
export async function fetchImageAsDataUrl(url: string): Promise<string> {
  const cached = remoteImageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.dataUrl;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return '';
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return '';
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return '';
    const dataUrl = `data:${contentType};base64,${Buffer.from(buf).toString('base64')}`;
    remoteImageCache.set(url, { dataUrl, expiresAt: Date.now() + REMOTE_IMAGE_TTL_MS });
    return dataUrl;
  } catch {
    return '';
  }
}

/**
 * Resolve an admin image value to something satori can ALWAYS render:
 * data URLs pass through, remote/relative images are fetched and converted to
 * data URLs, and anything invalid/broken becomes '' (callers fall back to
 * text-only rendering instead of 500ing the route).
 */
export async function resolveBrandImageForSatori(raw: unknown): Promise<string> {
  const resolved = await resolveBrandImageSource(raw);
  if (!resolved) return '';
  if (/^data:image\//i.test(resolved)) return resolved;
  return fetchImageAsDataUrl(resolved);
}

