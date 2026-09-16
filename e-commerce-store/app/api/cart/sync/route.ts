import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';
import { STORED_CARTS_KEY } from '@/lib/redis-keys';
import { readCartItemsFromPostgres } from '@/lib/postgres-read-fallback';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';

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
    if (out.length >= 100) break; // never let a payload bloat the stored cart
    if (!raw || typeof raw !== 'object') continue;
    const item: Record<string, string | number> = {
      productId: String((raw as any).productId || '').slice(0, 200),
      name: String((raw as any).name || '').slice(0, 200),
      size: String((raw as any).size || 'Standard').slice(0, 50),
      price: Math.max(0, Number((raw as any).price) || 0),
      productType: String((raw as any).productType || '').slice(0, 40),
      checkoutMode: String((raw as any).checkoutMode || '').slice(0, 20),
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

    // Postgres-primary read, with fallback (lib/postgres-read-fallback.ts):
    // returns null (never throws) whenever the flag is off, Supabase isn't
    // configured, or this customer simply hasn't been backfilled into
    // Postgres yet — every one of those falls straight through to the
    // exact Redis read that already ran here before this cutover existed.
    // The flag check gates even calling ensureDefaultTenant() — with the
    // flag off (the default) this route makes zero Postgres calls at all,
    // same as before this cutover existed.
    if (isPostgresPrimaryEnabled()) {
      try {
        const tenantId = await ensureDefaultTenant();
        const pgItems = await readCartItemsFromPostgres(tenantId, user.email);
        if (pgItems) return NextResponse.json({ items: pgItems, source: 'postgres' });
      } catch {
        /* fall through to Redis */
      }
    }

    const redis = createKvClient();
    if (!redis) return NextResponse.json({ items: [] });
    const raw = await redis.hget(STORED_CARTS_KEY, user.userId);
    const parsed = safeParseKvItem<any>(raw);
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
    const redis = createKvClient();
    if (redis) {
      await redis.hset(STORED_CARTS_KEY, { [user.userId]: JSON.stringify(items) });
    }
    return NextResponse.json({ saved: true, count: items.length });
  } catch {
    return NextResponse.json({ saved: false, error: 'CART_SYNC_FAILED' }, { status: 500 });
  }
}
