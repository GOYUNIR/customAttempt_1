import { NextResponse } from 'next/server';
import { createHash, createHmac, randomUUID } from 'crypto';
import { adminAuthorized } from '@/lib/admin-verify';

/**
 * In-panel CDN presign endpoint — issues a SHORT-LIVED, signed PUT URL so the
 * browser uploads media DIRECTLY to S3 / Cloudflare R2 (never through our app
 * server and never as base64 in Redis). The client then persists the returned
 * `publicUrl` in the product's `images` array.
 *
 * Keys live under `products/<slug>/<uuid>.<ext>` — matching the required
 * `s3://bucket/products/[slug]/` prefix. Signing is AWS Signature V4
 * (query-string auth) implemented with Node `crypto` only — no SDK dependency —
 * so it works identically against AWS S3 and Cloudflare R2's S3-compatible API.
 *
 * When object storage is NOT configured, this returns 501 and the admin client
 * falls back to the legacy base64 `/api/admin/upload` path, so existing
 * deployments keep working unchanged.
 */

export const dynamic = 'force-dynamic';

const env = (name: string): string => (process.env[name] || '').trim();

const ACCEPTED_EXTS = new Set(['png', 'jpeg', 'jpg', 'svg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'mov', 'mkv', 'avi', 'webm']);

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'product';
}

function safeExtension(filename: string): string {
  const name = String(filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = name.slice(dot + 1).replace(/[^a-z0-9]/g, '');
  return ACCEPTED_EXTS.has(ext) ? `.${ext}` : '';
}

interface PresignOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  key: string;
  expiresSeconds: number;
  endpoint?: string;
}

function presignPut(opts: PresignOptions): { uploadUrl: string; objectUrl: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;

  // Host + URI differ between path-style (R2 custom endpoint) and virtual-hosted
  // (AWS S3) addressing.
  const endpoint = opts.endpoint ? opts.endpoint.replace(/\/+$/, '') : '';
  const pathStyle = Boolean(endpoint);
  const host = pathStyle ? new URL(endpoint).host : `${opts.bucket}.s3.${opts.region}.amazonaws.com`;
  const path = pathStyle ? `/${opts.bucket}/${opts.key}` : `/${opts.key}`;
  const canonicalUri = path
    .split('/')
    .filter(Boolean)
    .map(encodeSegment)
    .join('/');

  const canonicalQuery = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    `X-Amz-Credential=${encodeURIComponent(`${opts.accessKeyId}/${credentialScope}`)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${opts.expiresSeconds}`,
    'X-Amz-SignedHeaders=host',
  ].join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['PUT', `/${canonicalUri}`, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmacHex(kSigning, stringToSign);

  const baseUrl = pathStyle ? endpoint : `https://${host}`;
  const objectUrl = `${baseUrl}/${opts.key}`;
  const uploadUrl = `${objectUrl}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { uploadUrl, objectUrl };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const accessKeyId = env('MEDIA_S3_ACCESS_KEY_ID');
    const secretAccessKey = env('MEDIA_S3_SECRET_ACCESS_KEY');
    const bucket = env('MEDIA_BUCKET') || env('MEDIA_S3_BUCKET');
    if (!accessKeyId || !secretAccessKey || !bucket) {
      return NextResponse.json(
        { error: 'Object storage is not configured (set MEDIA_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY).' },
        { status: 501 },
      );
    }

    const filename = String(body?.filename || 'file');
    const contentType = String(body?.contentType || 'application/octet-stream').slice(0, 128);
    const slug = slugify(String(body?.slug || body?.productId || ''));
    const key = `products/${slug}/${randomUUID()}${safeExtension(filename)}`;

    const region = env('MEDIA_S3_REGION') || 'auto';
    const endpoint = env('MEDIA_S3_ENDPOINT');
    const expiresSeconds = 900; // 15 minutes — plenty for a direct upload

    const { uploadUrl, objectUrl } = presignPut({
      accessKeyId,
      secretAccessKey,
      region,
      bucket,
      key,
      expiresSeconds,
      endpoint,
    });

    const publicBase = env('MEDIA_S3_PUBLIC_BASE_URL');
    const publicUrl = publicBase ? `${publicBase.replace(/\/+$/, '')}/${key}` : objectUrl;

    return NextResponse.json({
      uploadUrl,
      key,
      objectUrl,
      publicUrl,
      contentType,
      expiresIn: expiresSeconds,
    });
  } catch (err: any) {
    console.error('[media/presign] Error:', err);
    return NextResponse.json({ error: 'Could not issue an upload URL.' }, { status: 500 });
  }
}

