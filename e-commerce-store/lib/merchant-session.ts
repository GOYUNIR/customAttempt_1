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
 *   - role owner|staff, not impersonation (staff impersonation is refused
 *     until it has its own isolation proof);
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

export type MerchantSession = {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  role: 'owner' | 'staff';
  email: string;
};

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
  if (record.impersonating === true) return deny(403, 'Staff impersonation is not available for store dashboards yet.', 'IMPERSONATION_REFUSED');
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return deny(403, 'This session is not for a merchant store.', 'NOT_A_MERCHANT_SESSION');
  if (role !== 'owner' && role !== 'staff') return deny(403, 'This account cannot manage a store.', 'ROLE_REFUSED');
  if (!email) return deny(401, 'Sign in to your store.', 'NO_SESSION');

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

/** JSON response helper for merchant routes. */
export function merchantJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
