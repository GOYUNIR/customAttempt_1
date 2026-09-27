/**
 * MERCHANT SESSION — the ONE gate every /api/merchant route passes first
 * (TENANCY.md "Merchant dashboard"). It answers "whose store is this?" from
 * the signed-in session and nothing else, and every merchant route acts on
 * that store only.
 *
 * Why a separate gate and a separate route tree: the /admin tree acts on the
 * ORIGINAL store and, until 2026-09-26, authorized any valid admin session —
 * a merchant owner could read and write the original store (proven, then
 * contained: lib/default-tenant.ts). Retrofitting 58 routes welded to the
 * original store's KV state would be 58 chances to miss one. Merchant routes
 * are built tenant-scoped from the first line instead, and a test
 * (tests/merchant-routes.test.ts) fails if any handler skips this gate.
 *
 * The session proves identity; the DATABASE proves membership, every time:
 *   - a valid, unexpired admin device (the verified sign-in's session);
 *   - role owner|staff; OR a platform support session (sales-team / super-
 *     admin "act as merchant" sign-in, /api/admin/impersonate), which becomes
 *     role 'support' only while the person still holds that role and, for
 *     sales roles, their assignment to THIS store still exists (removing it
 *     cuts them off at once). Support may view and edit the store, never
 *     payments or staff (owner-only routes check role === 'owner');
 *   - a store other than the original one (its staff use /admin);
 *   - the users row STILL says this email is owner/staff OF THAT STORE, so a
 *     removed or moved person's old session stops working at once;
 *   - the store exists and is active or in grace.
 * The tenant id never comes from the request: not a header, query or body.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { createKvClient } from '@/lib/server-config';
import { adminDeviceTokenFromRequest, isAdminDeviceValid, readAdminDevice } from '@/lib/admin-verify';
import { DEFAULT_TENANT_ID } from '@/lib/default-tenant';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { clientIp } from '@/lib/rate-limit';

export type MerchantSession = {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  role: 'owner' | 'staff' | 'support';
  email: string;
};

const SALES_SCOPED_ROLES = new Set(['sales', 'sales_rep', 'sales_admin', 'deal_desk']);

type GateResult = { ok: true; session: MerchantSession } | { ok: false; response: Response };

const deny = (status: number, error: string, code: string): GateResult => ({
  ok: false,
  response: new Response(JSON.stringify({ error, code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
});

export async function merchantSession(request: Request): Promise<GateResult> {
  const token = adminDeviceTokenFromRequest(request);
  if (!token) return deny(401, 'Sign in to your store.', 'NO_SESSION');
  const kv: any = createKvClient();
  if (!kv) return deny(503, 'Please try again shortly.', 'UNAVAILABLE');
  let record: any;
  try {
    if (!(await isAdminDeviceValid(kv, token))) return deny(401, 'Your session has ended. Sign in again.', 'SESSION_ENDED');
    record = await readAdminDevice(kv, token);
  } catch {
    return deny(503, 'Please try again shortly.', 'UNAVAILABLE');
  }
  if (!record) return deny(401, 'Sign in to your store.', 'NO_SESSION');
  const role = String(record.role || '');
  const tenantId = String(record.tenantId || '').trim();
  const email = String(record.email || '').trim().toLowerCase();
  const support = record.impersonating === true;
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return deny(403, 'This session is not for a merchant store.', 'NOT_A_MERCHANT_SESSION');
  if (support ? !(role === 'super_admin' || SALES_SCOPED_ROLES.has(role)) : (role !== 'owner' && role !== 'staff')) {
    return deny(403, 'This account cannot manage a store.', 'ROLE_REFUSED');
  }
  if (!email) return deny(401, 'Sign in to your store.', 'NO_SESSION');
  if (support) return supportSession(email, role, tenantId);

  try {
    const db = getDb();
    const [users, tenants] = await Promise.all([
      db.select<any>('users', { where: { email: eq(email) }, select: ['role', 'tenant_id'], limit: 1 }),
      db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['id', 'name', 'slug', 'license_status'], limit: 1 }),
    ]);
    const user = (users as any[])[0];
    const tenant = (tenants as any[])[0];
    if (!user || String(user.tenant_id || '') !== tenantId || (user.role !== 'owner' && user.role !== 'staff')) {
      return deny(403, 'You no longer have access to this store.', 'MEMBERSHIP_REVOKED');
    }
    if (!tenant || !['active', 'grace'].includes(String(tenant.license_status || ''))) {
      return deny(403, 'This store is not active.', 'STORE_INACTIVE');
    }
    return { ok: true, session: { tenantId, tenantName: tenant.name ?? null, tenantSlug: tenant.slug ?? null, role: user.role, email } };
  } catch {
    return deny(503, 'Please try again shortly.', 'UNAVAILABLE');
  }
}

/** A platform support session, re-checked in the database on every call. */
async function supportSession(email: string, role: string, tenantId: string): Promise<GateResult> {
  try {
    const db = getDb();
    const [users, tenants] = await Promise.all([
      db.select<any>('users', { where: { email: eq(email) }, select: ['id', 'role', 'is_super_admin'], limit: 1 }),
      db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['id', 'name', 'slug', 'license_status'], limit: 1 }),
    ]);
    const user = (users as any[])[0];
    const tenant = (tenants as any[])[0];
    const stillSuper = role === 'super_admin' && (user?.is_super_admin === true || user?.role === 'super_admin');
    const stillSales = SALES_SCOPED_ROLES.has(role) && user && SALES_SCOPED_ROLES.has(String(user.role));
    if (!user || !(stillSuper || stillSales)) return deny(403, 'You no longer have access to this store.', 'MEMBERSHIP_REVOKED');
    if (stillSales) {
      const assigned = (await db.select<any>('sales_tenant_assignments', { where: { sales_user_id: eq(String(user.id)), tenant_id: eq(tenantId) }, select: ['tenant_id'], limit: 1 })) as any[];
      if (assigned.length === 0) return deny(403, 'You are no longer assigned to this store.', 'ASSIGNMENT_REVOKED');
    }
    if (!tenant || !['active', 'grace'].includes(String(tenant.license_status || ''))) return deny(403, 'This store is not active.', 'STORE_INACTIVE');
    return { ok: true, session: { tenantId, tenantName: tenant.name ?? null, tenantSlug: tenant.slug ?? null, role: 'support', email } };
  } catch {
    return deny(503, 'Please try again shortly.', 'UNAVAILABLE');
  }
}

/**
 * Record a merchant-dashboard write in the PLATFORM audit table, tagged with
 * the store: who (and whether it was platform support acting for the store),
 * which store, what. Best-effort: a failed write never blocks the action.
 *
 * Never the admin audit route's helper: it also pushes to the shared-KV audit
 * list, which is the ORIGINAL store's admin audit view, so a merchant's actions
 * (and their customers' emails) would show up in another store's admin.
 * tests/merchant-routes.test.ts enforces this.
 */
export async function auditMerchant(session: MerchantSession, request: Request, action: string, detail: string): Promise<void> {
  try {
    await recordPlatformAudit({
      action: 'MERCHANT_' + action,
      actor: session.email,
      detail: { detail, role: session.role, ...(session.role === 'support' ? { support: true } : {}) },
      tenantId: session.tenantId,
      ipAddress: clientIp(request),
    });
  } catch (err) {
    console.error('[merchant-audit] could not record ' + action + ' for ' + session.tenantId, (err as Error)?.message || err);
  }
}

/** JSON response helper for merchant routes. */
export function merchantJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * Sign out: delete THIS session server-side (so the cookie is worthless even
 * if it survives in the browser) and tell the browser to drop the cookie, with
 * the same attributes the sign-in set it with. Only the caller's own session
 * token is touched.
 */
export async function endMerchantSession(request: Request): Promise<Response> {
  const { ADMIN_DEVICE_COOKIE } = await import('@/lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('@/lib/redis-keys');
  const { portalCookieAttrs, requestPortal } = await import('@/lib/portal-cookies');
  const token = adminDeviceTokenFromRequest(request);
  const kv: any = createKvClient();
  if (token && kv) await kv.hdel(ADMIN_DEVICES_KEY, token);
  const attrs: any = portalCookieAttrs(request, requestPortal(request), 0);
  const parts = [ADMIN_DEVICE_COOKIE + '=', 'Path=' + (attrs.path || '/'), 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (attrs.domain) parts.push('Domain=' + attrs.domain);
  if (attrs.secure) parts.push('Secure');
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.sameSite) parts.push('SameSite=' + String(attrs.sameSite).replace(/^./, (c: string) => c.toUpperCase()));
  return new Response(JSON.stringify({ signedOut: true }), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': parts.join('; ') },
  });
}
