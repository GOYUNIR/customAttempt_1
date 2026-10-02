import { NextResponse } from 'next/server';
import { edgeCacheHeaders } from '@/lib/cache-headers';
import { storefrontTenantForRequest } from '@/lib/storefront-tenant';
import { storePayloadFor, withReleasedSizes } from '@/lib/store-payload';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedSlug = String(url.searchParams.get('slug') || '').trim();

    // Whose store (TENANCY.md): from the Host header, never from the client.
    // An unknown address is a 404, not the default store.
    const who = await storefrontTenantForRequest(request);
    if (who.kind === 'none') return NextResponse.json({ error: 'Store not found.' }, { status: 404 });
    if (who.kind === 'unavailable') return NextResponse.json({ error: 'Store unavailable. Please try again.' }, { status: 503 });

    const payload = await storePayloadFor(who, requestedSlug);

    // Slim the product-page payload: a slug request only needs the ONE product
    // + config (the page never reads the other products). Before this change a
    // product page downloaded the ENTIRE catalog on every load.
    const body = requestedSlug
      ? {
          config: payload.config,
          product: withReleasedSizes(payload.product, payload.allProducts),
          scheduleOverride: payload.scheduleOverride,
          socialOverride: payload.socialOverride,
          timestamp: payload.timestamp,
        }
      : payload;

    // Edge-cache the (now small) payload: Vercel's CDN serves it instead of
    // streaming it from the origin on every request — the single biggest Fast
    // Origin Transfer saving. Fresh within the documented ~10s window (same as
    // the server-side TTL cache). No max-age, so browsers always revalidate.
    return NextResponse.json(body, {
      headers: edgeCacheHeaders('public, s-maxage=10, stale-while-revalidate=30'),
    });
  } catch (err: any) {
    console.error('[store] failed', err?.message || err);
    return NextResponse.json({ error: 'Store unavailable. Please try again.' }, { status: 500 });
  }
}
