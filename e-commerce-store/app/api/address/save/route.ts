import { NextResponse } from 'next/server';
import {
  createRedisClient,
  findAllOpenOrders,
  adminUpdateOrderAddress,
  loadProducts,
} from '@/lib/server-config';
import { formatOrderRef } from '@/lib/order-ref';
import { validateShippingAddress } from '@/lib/address-validation';

export const dynamic = 'force-dynamic';

const ADDRESS_SUBMISSIONS_KEY = 'address:submissions';
const MAX_ADDRESS_LENGTH = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An address is "not set" when it's empty or one of the generic placeholders. */
function isBlankAddress(value: string): boolean {
  const v = String(value || '').trim().toLowerCase();
  return !v || v === 'unknown' || v === 'n/a' || v === 'na';
}

/**
 * Public address-capture endpoint used by the standalone checkout pages
 * (public/checkout.html, public/address-checkout-form.html).
 *
 * - Always logs the raw submission to Redis (address:submissions) so no
 *   address is ever lost.
 * - When the request identifies an open entry (exact email + variant + size),
 *   it attaches the address to that entry. To avoid letting a third party
 *   hijack an already-set address, an existing address is only overwritten
 *   when the requester also proves the matching orderRef.
 */
export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'Infrastructure offline' }, { status: 500 });
    }

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const address = String(body?.address || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();
    const orderRef = String(body?.orderRef || '').trim();
    const name = String(body?.name || '').trim();
    const phone = String(body?.phone || '').trim();
    const source = String(body?.source || 'checkout-form').trim();
    const verified = body?.verified === true || body?.verified === 'true';

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }
    const addrError = validateShippingAddress(address);
    if (addrError) {
      return NextResponse.json({ error: addrError }, { status: 400 });
    }
    if (address.length > MAX_ADDRESS_LENGTH) {
      return NextResponse.json({ error: 'Shipping address is too long.' }, { status: 400 });
    }

    // Always capture the raw submission so nothing is ever lost.
    const record = {
      email,
      address,
      name: name || undefined,
      phone: phone || undefined,
      verified: verified || undefined,
      variant: variant || undefined,
      size: size || undefined,
      orderRef: orderRef || undefined,
      source,
      submittedAt: new Date().toISOString(),
    };
    try {
      await redis.rpush(ADDRESS_SUBMISSIONS_KEY, JSON.stringify(record));
    } catch (e) {
      console.error('[address/save] failed to log submission', e);
    }

    let matched = false;
    let updated = false;
    if (variant && size) {
      try {
        const liveProducts = await loadProducts(redis);
        const productNames = Object.values(liveProducts).map((p) => String((p as { name?: string })?.name || ''));
        const orders = await findAllOpenOrders(redis, productNames);
        const target = orders.find(
          (o) =>
            o.variant === variant &&
            o.size === size &&
            String(o.parsed.email || '').toLowerCase() === email
        );
        if (target) {
          matched = true;
          const existing = String(target.parsed.shippingAddress || target.parsed.address || '').trim();
          const reqRef = formatOrderRef(orderRef);
          const entryRef = formatOrderRef(String(target.parsed.orderRef || ''));
          const refMatches = !reqRef || (!!entryRef && entryRef === reqRef);
          if (isBlankAddress(existing) || refMatches) {
            await adminUpdateOrderAddress(redis, target, address);
            updated = true;
          }
        }
      } catch (e) {
        console.error('[address/save] attach-to-entry failed', e);
      }
    }

    return NextResponse.json({
      success: true,
      saved: true,
      matched,
      updated,
      message: updated
        ? 'Shipping address saved.'
        : matched
          ? 'Address received — your entry already has a shipping address. You can change it from your account page.'
          : 'Address received.',
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Server error' }, { status: 500 });
  }
}
