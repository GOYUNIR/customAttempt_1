import { NextResponse } from 'next/server';
import {
  createRedisClient,
  findAllOpenOrders,
  adminUpdateOrderAddress,
  findLedgerEntriesByEmailVariant,
  ARCHIVE_LEDGER_KEY,
  archiveEntry,
  loadProducts,
} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { sendAccountUpdateEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const variant = String(body?.variant || '');
    const size = String(body?.size || '');
    const email = String(body?.email || '').trim().toLowerCase();
    // Admin override: always accept the address as-is regardless of the
    // customer-facing requireAddressAutofill flag (still clamped to 500 chars).
    const newAddress = String(body?.newAddress || '').trim().slice(0, 500);

    if (!variant || !size || !email || !newAddress) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    const liveProducts = await loadProducts(redis);
    const productNames = Object.values(liveProducts).map((p: any) => p.name);
    const orders = await findAllOpenOrders(redis, productNames);
    const target = orders.find(
      (o) => o.variant === variant && o.size === size && String(o.parsed.email || '').toLowerCase() === email,
    );

    if (target) {
      await adminUpdateOrderAddress(redis, target, newAddress);
      await sendAccountUpdateEmail({
        to: email,
        product: variant,
        size,
        changeType: 'address',
        newAddress,
      }).catch(() => {});
      return NextResponse.json({ success: true, message: 'Address updated.' });
    }

    // After a draw the live pool resets, so the entry may only exist on the
    // permanent ledger (ENTERED / WINNER_CHARGED). Keep admin edits working by
    // updating the durable record there instead of failing with "Entry not found".
    const ledgerRefs = await findLedgerEntriesByEmailVariant(redis, email, variant, size, ['ENTERED', 'WINNER_CHARGED']);
    if (ledgerRefs.length === 0) {
      return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
    }
    ledgerRefs.sort(
      (a, b) => new Date(b.record.registeredAt).getTime() - new Date(a.record.registeredAt).getTime(),
    );
    const latest = ledgerRefs[0];
    await redis.lset(ARCHIVE_LEDGER_KEY, latest.index, JSON.stringify({
      ...latest.record,
      shippingAddress: newAddress,
      address: newAddress,
    }));
    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress: newAddress,
      id: String(latest.record.customerId || latest.record.id || 'n/a'),
      registeredAt: new Date().toISOString(),
      type: 'ADDRESS_UPDATED',
    } as any);
    await sendAccountUpdateEmail({
      to: email,
      product: variant,
      size,
      changeType: 'address',
      newAddress,
    }).catch(() => {});
    return NextResponse.json({ success: true, message: 'Address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
