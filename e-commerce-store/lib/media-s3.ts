/**
 * OBJECT STORAGE (R2 / S3) — signing + key helpers.
 *
 * Extracted from app/api/admin/media/presign/route.ts so the presign endpoint
 * and scripts/backfill-media-to-r2.ts share ONE implementation of SigV4
 * query-string signing. Duplicating request signing across two callers is how
 * they silently drift apart.
 *
 * AWS Signature V4, implemented with Node `crypto` only (no SDK), so it works
 * identically against AWS S3 and Cloudflare R2's S3-compatible API.
 *
 * Runtime note: this module imports `crypto` and is therefore Node-runtime
 * only. It must never be imported from middleware.ts or any Edge-runtime path.
 * The pure, dependency-free helpers (slugify / extension / key building) are
 * split into lib/media-s3-keys.ts so they stay testable under `node --test`.
 */
import { createHash, createHmac, randomUUID } from 'crypto';
import { buildMediaObjectKey, safeMediaExtension, slugifyMediaSegment } from './media-s3-keys.ts';

export { buildMediaObjectKey, safeMediaExtension, slugifyMediaSegment };

export interface MediaS3Config {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint: string;
  publicBaseUrl: string;
}

const env = (name: string): string => (process.env[name] || '').trim();

/**
 * Read object-storage config from the environment. Returns null when it is not
 * configured — every caller treats that as "fall back to base64", never as an
 * error, so existing deployments keep working untouched.
 */
export function readMediaS3Config(): MediaS3Config | null {
  const accessKeyId = env('MEDIA_S3_ACCESS_KEY_ID');
  const secretAccessKey = env('MEDIA_S3_SECRET_ACCESS_KEY');
  const bucket = env('MEDIA_BUCKET') || env('MEDIA_S3_BUCKET');
  if (!accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region: env('MEDIA_S3_REGION') || 'auto',
    endpoint: env('MEDIA_S3_ENDPOINT'),
    publicBaseUrl: env('MEDIA_S3_PUBLIC_BASE_URL'),
  };
}

export function mediaObjectStorageConfigured(): boolean {
  return readMediaS3Config() !== null;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** URL-encode a path segment the way SigV4's canonical URI expects. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%20/g, '+');
}

/** A random object key under `products/<slug>/`. */
export function newMediaObjectKey(slug: string, filename: string): string {
  return buildMediaObjectKey(slug, randomUUID(), filename);
}

/** The public URL an object key is served from. */
export function publicUrlForKey(config: MediaS3Config, key: string, objectUrl: string): string {
  return config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, '')}/${key}` : objectUrl;
}

export interface PresignResult {
  uploadUrl: string;
  objectUrl: string;
}

/**
 * Presign a PUT. Host + URI differ between path-style (R2 custom endpoint)
 * and virtual-hosted (AWS S3) addressing.
 */
export function presignPut(opts: {
  config: MediaS3Config;
  key: string;
  expiresSeconds: number;
  now?: Date;
}): PresignResult {
  const { config, key, expiresSeconds } = opts;
  const now = opts.now || new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`;

  const endpoint = config.endpoint ? config.endpoint.replace(/\/+$/, '') : '';
  const pathStyle = Boolean(endpoint);
  const host = pathStyle ? new URL(endpoint).host : `${config.bucket}.s3.${config.region}.amazonaws.com`;
  const path = pathStyle ? `/${config.bucket}/${key}` : `/${key}`;
  const canonicalUri = path.split('/').filter(Boolean).map(encodeSegment).join('/');

  const canonicalQuery = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    `X-Amz-Credential=${encodeURIComponent(`${config.accessKeyId}/${credentialScope}`)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${expiresSeconds}`,
    'X-Amz-SignedHeaders=host',
  ].join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['PUT', `/${canonicalUri}`, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmacHex(kSigning, stringToSign);

  // Build the object URL from the SAME path that was signed. Deriving it
  // independently is how the signature and the request URI drift apart: the
  // pre-extraction version built `${endpoint}/${key}`, omitting the bucket
  // that the canonical request included, so every path-style (R2) upload was
  // signed for /bucket/key but sent to /key — a guaranteed
  // SignatureDoesNotMatch. Using `origin` also means a MEDIA_S3_ENDPOINT that
  // already carries a /bucket path suffix cannot double it.
  const origin = pathStyle ? new URL(endpoint).origin : `https://${host}`;
  const objectUrl = `${origin}${path}`;
  return { uploadUrl: `${objectUrl}?${canonicalQuery}&X-Amz-Signature=${signature}`, objectUrl };
}

/**
 * Upload bytes directly (server-side). Used by the backfill; the browser uses
 * the presigned URL instead so media never transits this app's server.
 * Returns the object's public URL, or throws with the storage error text.
 */
export async function putMediaObject(
  config: MediaS3Config,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const { uploadUrl, objectUrl } = presignPut({ config, key, expiresSeconds: 900 });
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Object storage PUT failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return publicUrlForKey(config, key, objectUrl);
}
