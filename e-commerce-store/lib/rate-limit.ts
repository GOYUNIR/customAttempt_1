/**
 * Shared per-IP rate limiting for public endpoints that write state.
 *
 * The pattern (borrowed from `/api/checkout/auto-draw`) is a short-TTL Redis
 * counter keyed by `cache:rate:<namespace>:<ip>` (see lib/redis-keys.ts).
 * `incr` + lazy `expire` is atomic enough for abuse throttling, and the
 * counter lives under the `cache:` namespace so it can be deleted anytime.
 *
 * IMPORTANT: a limiter hiccup (Redis unreachable) deliberately does NOT block
 * the request — legit flows must never break because of throttling. The route
 * itself still enforces its real business rules (duplicates, caps, Stripe).
 */

import { createRedisClient } from '@/lib/server-config';
import { rateLimitKey } from '@/lib/redis-keys';

/** Best-effort client IP from the standard proxy headers (never trusted as
 *  identity — only as a coarse abuse signal). */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

/** Returns true when the caller has exceeded `max` requests in `windowS`
 *  seconds for the given namespace + IP. Never throws. */
export async function isRateLimited(
  namespace: string,
  request: Request,
  max: number,
  windowS: number,
): Promise<boolean> {
  try {
    const redis = createRedisClient();
    if (!redis) return false;
    const key = rateLimitKey(namespace, clientIp(request));
    const count = await redis.incr(key);
    if (Number(count) === 1) await redis.expire(key, windowS);
    return Number(count) > max;
  } catch {
    return false;
  }
}

/** Convenience wrapper that returns a 429 NextResponse when limited. */
export async function rateLimitedResponse(
  namespace: string,
  request: Request,
  max: number,
  windowS: number,
): Promise<Response | null> {
  if (await isRateLimited(namespace, request, max, windowS)) {
    return Response.json(
      { error: 'Too many requests from this connection. Please try again shortly.' },
      { status: 429 },
    );
  }
  return null;
}
