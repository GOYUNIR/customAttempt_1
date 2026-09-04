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

/** Hostname of the configured site URL ('' when unset). Used to detect a
 *  SELF-fetch — round-tripping our own public origin through the edge. */
function siteOrigin(): string {
  try {
    const site = getSiteUrl();
    if (site) return new URL(site).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * True when `url` points at the store's OWN deployed domain. Fetching your own
 * origin server-side is exactly what Cloudflare's bot protection (and similar
 * edge WAFs) flag — it answers with a "Cloudflare Ray ID …" managed-challenge
 * HTML page instead of the image. We must NEVER HTTP-round-trip our own origin.
 */
function isSelfOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const self = siteOrigin();
    return Boolean(self) && host === self;
  } catch {
    return false;
  }
}

/** Map a public-file path to an image MIME type; '' for anything non-image. */
function mimeForPath(p: string): string {
  const ext = String(p.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon',
  };
  return map[ext] || '';
}

/**
 * Read a `public/` asset (root-relative path) from the LOCAL filesystem and
 * return it as a `data:` URL — the correct, challenge-free replacement for
 * self-fetching `https://self/…`. Only works on the Node runtime (Vercel /
 * `next dev` / `next start`); on Workers (no `public/` dir) it returns '' so
 * the card/favicon falls back to text-only instead of self-fetching the edge.
 */
async function readPublicFileAsDataUrl(pathname: string): Promise<string> {
  const rel = String(pathname || '').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '.')) return '';
  const mime = mimeForPath(rel);
  if (!mime) return '';
  try {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const root = path.resolve(process.cwd(), 'public');
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep)) return ''; // traversal guard
    const buf = await readFile(abs);
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return '';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Fetch a REMOTE image and return it as a `data:` URL, or '' on any failure
 * (never throws). Results are cached in-process for 60s. Self-origin URLs are
 * refused here as defense-in-depth — callers must resolve those locally.
 */
export async function fetchImageAsDataUrl(url: string): Promise<string> {
  if (isSelfOrigin(url)) return ''; // never self-fetch through our own edge
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
 *   - `data:image/…` passes straight through,
 *   - root-relative `/images/…` paths are read from the LOCAL `public/` dir
 *     (never self-fetched through the deployed/Cloudflare URL),
 *   - absolute URLs are fetched ONLY when they point elsewhere; a same-origin
 *     absolute URL is resolved from `public/` locally instead,
 *   - anything invalid/broken becomes '' (callers fall back to text-only).
 */
export async function resolveBrandImageForSatori(raw: unknown): Promise<string> {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:image\//i.test(value)) return value;

  if (value.startsWith('/')) {
    return readPublicFileAsDataUrl(value);
  }

  if (/^https?:\/\//i.test(value)) {
    if (isSelfOrigin(value)) {
      // Same-origin absolute URL — read its public path locally, no self-fetch.
      try {
        return readPublicFileAsDataUrl(new URL(value).pathname);
      } catch {
        return '';
      }
    }
    return fetchImageAsDataUrl(value);
  }

  return '';
}

