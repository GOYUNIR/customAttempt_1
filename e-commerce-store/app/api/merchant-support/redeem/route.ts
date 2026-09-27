import { NextResponse } from 'next/server';
import { createKvClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { readAdminDevice } from '@/lib/admin-verify';
import { redeemSupportHandoff } from '@/lib/merchant-support-handoff';
import { portalCookieAttrs } from '@/lib/portal-cookies';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST { code } on app.<root> only (lib/edge-router.ts): exchange a one-time
 * support handoff code (lib/merchant-support-handoff.ts) for the support
 * session's cookie on this host. Only an impersonation session for a store can
 * be handed over; what it may then do is decided by lib/merchant-session.ts on
 * every call.
 */
export async function POST(request: Request) {
  const limited = await rateLimitedResponse('merchant_support_redeem', request, 20, 60);
  if (limited) return limited;
  const kv: any = createKvClient();
  if (!kv) return NextResponse.json({ error: 'Please try again shortly.' }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const handed = await redeemSupportHandoff(kv, String(body?.code || ''));
  const refuse = () => NextResponse.json({ error: 'This link has expired or was already used. Start again from the sales hub.' }, { status: 401 });
  if (!handed) return refuse();
  const record = await readAdminDevice(kv, handed.token).catch(() => null);
  if (!record || record.impersonating !== true || String(record.tenantId || '') !== handed.tenantId) return refuse();
  const remaining = Math.max(60, Math.floor((Number(record.expiresAt || 0) - Date.now()) / 1000));
  const response = NextResponse.json({ ok: true, next: '/app' });
  response.cookies.set(ADMIN_DEVICE_COOKIE, handed.token, portalCookieAttrs(request, 'merchant', remaining));
  return response;
}
