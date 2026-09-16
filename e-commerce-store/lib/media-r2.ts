/**
 * R2 OBJECT READS — the serving half of Phase H1.
 *
 * The bucket is PRIVATE. Nothing is served from R2's own custom domain, for a
 * concrete reason discovered by testing rather than reading: this Worker owns
 * the route `*.goyunir.com/*` (wrangler.jsonc, added in Phase C so tenant
 * subdomains resolve), and a Workers route SHADOWS an R2 custom domain on the
 * same hostname. An upload would succeed and the public fetch would 404 —
 * which is exactly what happened, and which presign/upload checks alone could
 * never have caught.
 *
 * So objects are served THROUGH the Worker, by app/media/[...parts]. That also
 * means the bucket needs no public access at all, and this app controls the
 * cache headers rather than inheriting R2's.
 *
 * Two read paths, in order:
 *   1. The R2 BINDING (`MEDIA_BUCKET_R2` in wrangler.jsonc) — no signing, no
 *      egress over the public internet. This is the production path.
 *   2. A presigned GET against the S3 API — used when no binding exists
 *      (`next dev`, `node`-hosted deploys, verification scripts). Same bytes,
 *      slower, and it needs the credentials the binding does not.
 *
 * Never throws: a miss or an error returns null so a broken asset can never
 * 500 a page — the same contract app/media/[...parts] already had for base64.
 */
import { readMediaS3Config, presignGet } from './media-s3.ts';

export interface MediaObject {
  body: ArrayBuffer;
  contentType: string;
}

/** The R2 binding, when running on Workers. Null anywhere else. */
async function r2Binding(): Promise<R2BucketLike | null> {
  try {
    const mod = (await import('@opennextjs/cloudflare')) as unknown as {
      getCloudflareContext?: (...args: unknown[]) => { env?: Record<string, unknown> } | undefined;
    };
    const env = mod.getCloudflareContext?.()?.env;
    const bucket = env?.MEDIA_BUCKET_R2 as R2BucketLike | undefined;
    return bucket && typeof bucket.get === 'function' ? bucket : null;
  } catch {
    // Not running on Workers (or the context is unavailable at this point in
    // the request lifecycle) — the signed-GET path below still works.
    return null;
  }
}

interface R2BucketLike {
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
}

/**
 * Read one object by key. Returns null when it does not exist, when object
 * storage is not configured, or on any transport error.
 */
export async function readMediaObject(key: string): Promise<MediaObject | null> {
  const cleanKey = String(key || '').replace(/^\/+/, '');
  if (!cleanKey) return null;

  const bucket = await r2Binding();
  if (bucket) {
    try {
      const obj = await bucket.get(cleanKey);
      if (!obj) return null;
      return {
        body: await obj.arrayBuffer(),
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  const config = readMediaS3Config();
  if (!config) return null;
  try {
    const res = await fetch(presignGet(config, cleanKey, 300));
    if (!res.ok) return null;
    return {
      body: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/** Whether a read would use the binding (production) or a signed GET. */
export async function mediaReadPath(): Promise<'binding' | 'signed-get' | 'unavailable'> {
  if (await r2Binding()) return 'binding';
  return readMediaS3Config() ? 'signed-get' : 'unavailable';
}
