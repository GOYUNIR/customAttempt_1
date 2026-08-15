import { NextResponse } from 'next/server';
import { runAutoDraws } from '@/lib/auto-draw';
import { createRedisClient, autoDrawRateLimitKey } from '@/lib/server-config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Public auto-draw trigger.
 *
 * The storefront's countdown fires this endpoint the moment a product's raffle
 * timer hits zero, so a drop happens IMMEDIATELY — no cron, no waiting for a
 * scheduled job. The draw engine (`lib/auto-draw.ts`) decides whether each pool
 * is actually due (releaseEndsAt passed / archived / schedule cadence) and
 * enforces a 90s per-pool cooldown, so a stampede of visitors pinging at the
 * same second cannot double-draw.
 *
 * A filter is strongly recommended: `productId`, `productName` or `slug` (from
 * the client countdown). Omitting it runs every due pool (used by the admin
 * self-test / ping). `dryRun=1` simulates the draw without charging anyone —
 * useful for validation and support.
 *
 * HARDENING: the endpoint is public, so every call (dry-run or not) is
 * rate-limited per IP via a short-TTL Redis counter. A runaway tab or a script
 * can never hammer the draw engine / Redis scan. Legit visitors only fire this
 * once per product per page session.
 */
const RATE_LIMIT_MAX = 8; // requests per window per IP
const RATE_LIMIT_WINDOW_S = 60;

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

async function rateLimited(request: Request): Promise<boolean> {
  try {
    const redis = createRedisClient();
    if (!redis) return false;
    const key = autoDrawRateLimitKey(clientIp(request));
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_S);
    return Number(count) > RATE_LIMIT_MAX;
  } catch {
    // If Redis is unreachable the draw engine will fail loudly anyway; never
    // block a legitimate drop because of a limiter hiccup.
    return false;
  }
}

export async function POST(request: Request) {
  if (await rateLimited(request)) {
    return NextResponse.json(
      { success: false, error: 'Too many draw triggers from this connection. Try again shortly.' },
      { status: 429 },
    );
  }
  try {
    const body = await request.json().catch(() => ({}));
    const result = await runAutoDraws({
      request,
      onlyProductId: String(body?.productId || '').trim() || undefined,
      onlyProductName: String(body?.productName || '').trim() || undefined,
      onlySlug: String(body?.slug || '').trim() || undefined,
      dryRun: body?.dryRun === true || body?.dryRun === '1' || body?.dryRun === 1,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Draw trigger failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (await rateLimited(request)) {
    return NextResponse.json(
      { success: false, error: 'Too many draw triggers from this connection. Try again shortly.' },
      { status: 429 },
    );
  }
  const url = new URL(request.url);
  const result = await runAutoDraws({
    request,
    onlyProductId: url.searchParams.get('productId') || undefined,
    onlyProductName: url.searchParams.get('productName') || undefined,
    onlySlug: url.searchParams.get('slug') || undefined,
    dryRun: url.searchParams.get('dryRun') === '1',
  }).catch((err: any) => ({ success: false, error: err?.message || 'Draw trigger failed' }));
  return NextResponse.json(result);
}
