import {
  createRedisClient,
  loadStoreConfigCached,
  safeParseRedisItem,
  PRODUCTS_KEY,
} from '@/lib/server-config';
import { edgeCacheHeaders } from '@/lib/cache-headers';

/**
 * Serves product gallery media + the brand logo as REAL files.
 *
 * Product images/videos and the logo are stored in Redis as base64 `data:`
 * URLs. Instead of shipping those megabytes through every `/api/store` JSON
 * payload (and every SSR HTML page), public payloads carry small refs:
 *
 *   - `/media/<productId>/<index>.<ext>?v=<hash>`  → a product image/video
 *   - `/media/logo?v=<hash>`                       → the brand logo
 *
 * This route reads the source bytes from Redis and returns them with a
 * year-long `Cache-Control`, so Vercel's edge network serves each asset after
 * a SINGLE origin hit. The `?v=` cache-buster changes whenever the admin
 * replaces an asset, so stale copies are never served.
 *
 * Hardening: everything is wrapped in try/catch and any miss/malformed value
 * returns a plain 404 — a broken admin field can never 500 the storefront.
 */
export const dynamic = 'force-dynamic';

const MEDIA_DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/i;
/** Safety cap above the admin 18MB video limit — reject absurd payloads. */
const MAX_ENCODED_BYTES = 30_000_000;

/**
 * Decode a base64 payload into a plain `ArrayBuffer`-backed `Uint8Array`
 * (no Buffer dependency; TS 5.7's strict `BlobPart` typing requires the
 * `ArrayBuffer` view). Returns null on any malformed input.
 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeDataUrl(src: unknown): { mime: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const s = String(src || '');
  const match = MEDIA_DATA_URL_RE.exec(s);
  if (!match) return null;
  const [, mime, b64] = match;
  if (!b64 || b64.length > MAX_ENCODED_BYTES) return null;
  const bytes = base64ToBytes(b64);
  if (!bytes || bytes.length === 0) return null;
  return { mime, bytes };
}

function serve(media: { mime: string; bytes: Uint8Array<ArrayBuffer> }): Response {
  // Blob gives the Response constructor a body type that satisfies TS's
  // strict Uint8Array<ArrayBuffer> checks across TS versions.
  return new Response(new Blob([media.bytes], { type: media.mime }), {
    status: 200,
    headers: {
      'Content-Type': media.mime,
      'Content-Length': String(media.bytes.byteLength),
      ...edgeCacheHeaders('public, max-age=31536000, s-maxage=31536000, immutable'),
    },
  });
}

function notFound(): Response {
  // 404s are safe to cache briefly so a bot storm can't hammer the function.
  return new Response('Not found', { status: 404, headers: edgeCacheHeaders('public, max-age=300') });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ parts: string[] }> },
): Promise<Response> {
  try {
    const { parts } = await ctx.params;
    if (!Array.isArray(parts) || parts.length === 0) return notFound();

    const redis = createRedisClient();

    // /media/logo → the brand logo from store:config.
    if (parts[0] === 'logo') {
      if (parts.length !== 1) return notFound();
      const config = await loadStoreConfigCached(redis);
      const media = decodeDataUrl(config?.branding?.logoUrl);
      return media ? serve(media) : notFound();
    }

    // /media/<productId>/<index>.<ext> → one product image/video.
    if (parts.length === 2) {
      const productId = String(parts[0] || '');
      const index = parseInt(parts[1], 10);
      if (!productId || productId.includes('/') || productId.length > 200) return notFound();
      if (!Number.isInteger(index) || index < 0 || index > 99) return notFound();

      const raw = redis ? await redis.hget(PRODUCTS_KEY, productId) : null;
      const product = raw ? safeParseRedisItem<any>(raw) : null;
      const media = decodeDataUrl(product?.images?.[index]);
      return media ? serve(media) : notFound();
    }

    return notFound();
  } catch {
    return notFound();
  }
}
