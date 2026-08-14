import { NextResponse } from 'next/server';
import {
  createRedisClient,
  findAllOpenOrders,
  adminCancelOrder,
  ArchiveRecord,
  loadProducts,
  getAdminPassword,
} from '@/lib/server-config';
import { sendAccountUpdateEmail } from '@/lib/email';
import { appendAudit } from '@/app/api/admin/audit/route';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const variant = String(body?.variant || '');
    const size = String(body?.size || '');
    const email = String(body?.email || '').trim().toLowerCase();
    const reason = String(body?.reason || 'Cancelled by admin');

    if (!variant || !size || !email) {
      return NextResponse.json({ error: 'Missing entry identification.' }, { status: 400 });
    }

    const liveProducts = await loadProducts(redis);
    const productNames = Object.values(liveProducts).map((p: any) => p.name);
    const orders = await findAllOpenOrders(redis, productNames);
    const target = orders.find(
      (o) => o.variant === variant && o.size === size && String(o.parsed.email || '').toLowerCase() === email,
    );

    if (!target) {
      return NextResponse.json({ error: 'Entry not found — it may have already been cancelled or charged.' }, { status: 404 });
    }

    // Get the promo code before cancelling
    const promoCode = target.parsed.promoCode || null;

    await adminCancelOrder(redis, target, reason);

    // Best-effort audit trail so the admin portal's Action Audit Log shows this.
    try {
      await appendAudit(redis, {
        action: 'ENTRY_CANCELLED',
        detail: `${variant} / ${size} — ${email}${reason && reason !== 'Cancelled by admin' ? ` (${reason})` : ''}`,
        actor: 'admin',
        email,
      });
    } catch {}

    // Release the promo code if it was used
    if (promoCode) {
      try {
        await redis.srem(usedEmailsKey(promoCode), email);
        const raw = await redis.hget(PROMOS_KEY, promoCode);
        const promo = JSON.parse(typeof raw === 'string' ? raw : 'null');
        if (promo && promo.uses > 0) {
          promo.uses = Math.max(0, promo.uses - 1);
          await redis.hset(PROMOS_KEY, { [promoCode]: JSON.stringify(promo) });
        }
      } catch {}
    }

    // Send cancellation email
    try {
      await sendAccountUpdateEmail({
        to: email,
        product: variant,
        size: size,
        changeType: 'cancelled',
        newAddress: `Cancelled by admin: ${reason}`,
      });
    } catch (e) {
      console.error('[admin-cancel] email failed', e);
    }

    return NextResponse.json({ success: true, message: 'Entry cancelled.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}