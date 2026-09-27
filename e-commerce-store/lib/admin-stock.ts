/**
 * The ORIGINAL store's stock tool (/api/admin/stock/*): the same ledger
 * operations merchants have in /app (lib/stock.ts, 00037), for the store the
 * admin tree serves. Closes the last stock go-live blocker (STRATEGY §9): the
 * admin's inventory screens used to write only the KV mirror.
 *
 * The store is ALWAYS the original store (ensureDefaultTenant), never an
 * "acting" tenant and never input: a merchant's session is already refused by
 * the admin tree (403, lib/default-tenant.ts), and a size of another store is
 * refused by the database functions themselves.
 */
import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasMerchantAccess } from '@/lib/admin-actor';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { createKvClient } from '@/lib/server-config';
import { appendAudit } from '@/app/api/admin/audit/route';

export type StockAdmin = { tenantId: string; actor: string };

/** Signed-in owner/staff/super admin of the original store, or the refusal. */
export async function stockAdmin(request: Request): Promise<{ ok: true; who: StockAdmin } | { ok: false; response: Response }> {
  if (!(await adminAuthorized(request))) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const actor = await resolveAdminActor(request);
  // Day-to-day store operators only: sales roles have no business changing stock.
  if (!actorHasMerchantAccess(actor)) return { ok: false, response: NextResponse.json({ error: 'Store access required.' }, { status: 403 }) };
  const tenantId = await ensureDefaultTenant();
  return { ok: true, who: { tenantId, actor: String(actor?.email || 'admin') } };
}

/** The original store's own admin audit (its KV list + the platform table). */
export async function auditStock(request: Request, who: StockAdmin, action: string, detail: string): Promise<void> {
  try {
    const kv: any = createKvClient();
    if (kv) await appendAudit(kv, { action, detail, actor: who.actor, email: who.actor, tenantId: who.tenantId }, request);
  } catch (err) {
    console.error('[admin-stock] audit failed for ' + action, (err as Error)?.message || err);
  }
}
