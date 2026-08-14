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
import { getSessionUser } from '@/lib/session-auth';
import { validateShippingAddress } from '@/lib/address-validation';
import { sendAccountUpdateEmail } from '@/lib/email';
import { appendAudit } from '../../admin/audit/route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Login required.' }, { status: 401 });

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const email = sessionUser.email;
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();
    const newAddress = String(body?.newAddress || '').trim();

    if (!email || !variant || !size || !newAddress) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    const addrError = validateShippingAddress(newAddress);
    if (addrError) {
      return NextResponse.json({ error: addrError }, { status: 400 });
    }

    const liveProducts = await loadProducts(redis);
    const productNames = Object.values(liveProducts).map((p: any) => p.name);
    const orders = await findAllOpenOrders(redis, productNames);
    const target = orders.find(
      (o) => o.variant === variant && o.size === size && String(o.parsed.email || '').toLowerCase() === email,
    );

    if (target) {
      // Also verify last4 if provided (optional)
      if (last4 && String(target.parsed.cardLast4 || '') !== last4) {
        return NextResponse.json({ error: 'Card last4 does not match.' }, { status: 403 });
      }
      await adminUpdateOrderAddress(redis, target, newAddress);
      await sendAccountUpdateEmail({
        to: email,
        product: variant,
        size,
        changeType: 'address',
        newAddress,
      }).catch(() => {});
      try {
        await appendAudit(redis, {
          action: 'ACCOUNT_ADDRESS_UPDATED',
          detail: `${variant} / ${size} → ${newAddress}`,
          actor: 'user',
          email,
        });
      } catch {}
      return NextResponse.json({ success: true, message: 'Shipping address updated.' });
    }

    // The live pool may have been reset by a draw — fall back to the durable
    // ledger so customers can still fix their address on an entry or a won order.
    const ledgerRefs = await findLedgerEntriesByEmailVariant(redis, email, variant, size, ['ENTERED', 'WINNER_CHARGED']);
    if (ledgerRefs.length === 0) {
      return NextResponse.json({ error: 'Entry not found.' }, { status: 404 });
    }
    ledgerRefs.sort(
      (a, b) => new Date(b.record.registeredAt).getTime() - new Date(a.record.registeredAt).getTime(),
    );
    const latest = ledgerRefs[0];
    if (last4 && String(latest.record.cardLast4 || '') !== last4) {
      return NextResponse.json({ error: 'Card last4 does not match.' }, { status: 403 });
    }
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
    try {
      await appendAudit(redis, {
        action: 'ACCOUNT_ADDRESS_UPDATED',
        detail: `${variant} / ${size} → ${newAddress} (ledger fallback)`,
        actor: 'user',
        email,
      });
    } catch {}
    return NextResponse.json({ success: true, message: 'Shipping address updated.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
