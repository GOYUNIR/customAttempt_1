import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';
import { STORED_CARTS_KEY } from '@/lib/redis-keys';

export const dynamic = 'force-dynamic';

/**
 * Signed-in cart persistence.
 *
 * The browser cart lives in localStorage (`goyunir-cart`). When a customer is
 * signed in, SiteChrome also mirrors it here under `store:carts` (hash, field =
 * user id) so the
 * same account sees the same bag on every device/browser. The client merges
 * server + local on login (once per page session) and then persists every
 * change through POST /api/cart/sync (debounced client-side).
 *
 * - GET returns the saved cart (or `[]` when signed out / nothing saved).
 * - POST upserts the cart for the signed-in user (401 when signed out).
 *   Only safe fields are persisted; values are re-normalized server-side so a
 *   tampered client payload can never store junk.
 */
function sanitizeItems(input: unknown): Array<Record<string, string | number>> {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Array<Record<string, string | number>> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item: Record<string, string | number> = {
      productId: String((raw as any).productId || ''),
      name: String((raw as any).name || ''),
      size: String((raw as any).size || 'Standard'),
      price: Math.max(0, Number((raw as any).price) || 0),
      productType: String((raw as any).productType || ''),
      checkoutMode: String((raw as any).checkoutMode || ''),
    };
    if (!item.productId || !item.size) continue;
    const key = `${item.productId}::${item.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user?.userId) return NextResponse.json({ items: [] });
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ items: [] });
    const raw = await redis.hget(STORED_CARTS_KEY, user.userId);
    const parsed = safeParseRedisItem<any>(raw);
    return NextResponse.json({ items: sanitizeItems(parsed) });
  } catch {
    return NextResponse.json({ items: [] });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionUser(request);
    if (!user?.userId) {
      return NextResponse.json({ saved: false, error: 'UNAUTHENTICATED' }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const items = sanitizeItems(body?.items);
    const redis = createRedisClient();
    if (redis) {
      await redis.hset(STORED_CARTS_KEY, { [user.userId]: JSON.stringify(items) });
    }
    return NextResponse.json({ saved: true, count: items.length });
  } catch {
    return NextResponse.json({ saved: false, error: 'CART_SYNC_FAILED' }, { status: 500 });
  }
}
