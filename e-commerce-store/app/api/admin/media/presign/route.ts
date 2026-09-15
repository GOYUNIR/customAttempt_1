import { NextResponse } from 'next/server';
import { adminAuthorized } from '@/lib/admin-verify';
import { newMediaObjectKey, presignPut, publicUrlForKey, readMediaS3Config } from '@/lib/media-s3';

/**
 * In-panel CDN presign endpoint — issues a SHORT-LIVED, signed PUT URL so the
 * browser uploads media DIRECTLY to S3 / Cloudflare R2 (never through our app
 * server and never as base64 in Redis). The client then persists the returned
 * `publicUrl` in the product's `images` array.
 *
 * Keys live under `products/<slug>/<uuid>.<ext>`. SigV4 signing lives in
 * lib/media-s3.ts, shared with scripts/backfill-media-to-r2.ts so the two
 * cannot drift apart.
 *
 * When object storage is NOT configured, this returns 501 and the admin client
 * falls back to the legacy base64 `/api/admin/upload` path, so existing
 * deployments keep working unchanged.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const config = readMediaS3Config();
    if (!config) {
      return NextResponse.json(
        { error: 'Object storage is not configured (set MEDIA_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY).' },
        { status: 501 },
      );
    }

    const filename = String(body?.filename || 'file');
    const contentType = String(body?.contentType || 'application/octet-stream').slice(0, 128);
    const key = newMediaObjectKey(String(body?.slug || body?.productId || ''), filename);
    const expiresSeconds = 900; // 15 minutes — plenty for a direct upload

    const { uploadUrl, objectUrl } = presignPut({ config, key, expiresSeconds });

    return NextResponse.json({
      uploadUrl,
      key,
      objectUrl,
      publicUrl: publicUrlForKey(config, key, objectUrl),
      contentType,
      expiresIn: expiresSeconds,
    });
  } catch (err: any) {
    console.error('[media/presign] Error:', err);
    return NextResponse.json({ error: 'Could not issue an upload URL.' }, { status: 500 });
  }
}
