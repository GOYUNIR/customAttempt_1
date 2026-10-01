import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { getDb } from '@/lib/db/client';
import { eq, gt } from '@/lib/db/query';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { checkStoreAddress, STORE_ADDRESS_RULES } from '@/lib/store-address';
import { parseLegacyHosts } from '@/lib/storefront-host';

export const dynamic = 'force-dynamic';

/**
 * THIS store's web address (<slug>.<root>), self-serve (STORE-ADDRESSES.md §A).
 * Owner only: the address is the store's identity. The store is always the
 * session's; nothing in the request names it.
 *   GET  ?slug=  — is this name available? (rules, then taken / held), plus
 *                  the preview URL and how many changes are left.
 *   POST {slug}  — change it (00039 change_store_slug: all-or-nothing; the old
 *                  address redirects and stays reserved for 90 days).
 */
const root = () => String(process.env.PLATFORM_ROOT_DOMAIN || '').trim();
const urlOf = (slug: string) => 'https://' + slug + '.' + root();
const ctx = () => ({ legacyHosts: parseLegacyHosts(process.env.STOREFRONT_LEGACY_HOSTS, root()), rootDomain: root() });

async function changesUsed(tenantId: string): Promise<number> {
  const since = new Date(Date.now() - STORE_ADDRESS_RULES.windowDays * 86_400_000).toISOString();
  const rows = (await getDb().select<any>('tenant_slug_changes', { where: { tenant_id: eq(tenantId), changed_at: gt(since) }, select: ['id'], limit: 50 })) as any[];
  return rows.length;
}

export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can change the store address.' }, 403);
  const limited = await rateLimitedResponse('merchant_address_check', request, 120, 60);
  if (limited) return limited;
  const tenantId = gate.session.tenantId;
  const current = String(gate.session.tenantSlug || '');
  const left = Math.max(0, STORE_ADDRESS_RULES.maxChanges - (await changesUsed(tenantId)));
  const base = { current: { slug: current, url: urlOf(current) }, changesLeft: left, holdDays: STORE_ADDRESS_RULES.holdDays };
  const raw = new URL(request.url).searchParams.get('slug');
  if (raw === null) return merchantJson(base);

  const rule = checkStoreAddress(raw, ctx());
  const candidate = { slug: rule.slug, url: urlOf(rule.slug) };
  if (!rule.ok) return merchantJson({ ...base, candidate: { ...candidate, available: false, reason: rule.reason } });
  if (rule.slug === current) return merchantJson({ ...base, candidate: { ...candidate, available: false, reason: 'This is your address now.' } });
  const [owner, hold] = await Promise.all([
    getDb().select<any>('tenants', { where: { slug: eq(rule.slug) }, select: ['id'], limit: 1 }),
    getDb().select<any>('tenant_slug_aliases', { where: { slug: eq(rule.slug), expires_at: gt(new Date().toISOString()) }, select: ['tenant_id'], limit: 1 }),
  ]);
  if ((owner as any[]).length) return merchantJson({ ...base, candidate: { ...candidate, available: false, reason: 'Another store uses that name.' } });
  const heldBy = (hold as any[])[0]?.tenant_id;
  if (heldBy && heldBy !== tenantId) return merchantJson({ ...base, candidate: { ...candidate, available: false, reason: 'Another store used that name recently; it becomes free again later.' } });
  return merchantJson({ ...base, candidate: { ...candidate, available: true, reason: heldBy ? 'Your previous address: you can switch back to it.' : 'Available.' } });
}

export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can change the store address.' }, 403);
  const limited = await rateLimitedResponse('merchant_address_change', request, 10, 60);
  if (limited) return limited;
  if (!root()) return merchantJson({ error: 'Store addresses are not available right now.' }, 503);
  const body = await request.json().catch(() => ({}));
  const rule = checkStoreAddress(String(body?.slug || ''), ctx());
  if (!rule.ok) return merchantJson({ error: rule.reason }, 400);

  const tenantId = gate.session.tenantId;
  const rows = (await supabaseRestFetch('/rpc/change_store_slug', {
    key: readSupabaseEnv().serviceRoleKey, method: 'POST', prefer: 'return=representation',
    body: { p_tenant: tenantId, p_new: rule.slug, p_hold_days: STORE_ADDRESS_RULES.holdDays, p_max_changes: STORE_ADDRESS_RULES.maxChanges, p_window_days: STORE_ADDRESS_RULES.windowDays },
  })) as any[];
  const r = Array.isArray(rows) ? rows[0] : rows;
  const messages: Record<string, [number, string]> = {
    unchanged: [409, 'This is your address now.'],
    taken: [409, 'Another store uses that name.'],
    held: [409, 'Another store used that name recently; it becomes free again later.'],
    limit: [429, 'You can change your address ' + STORE_ADDRESS_RULES.maxChanges + ' times in ' + STORE_ADDRESS_RULES.windowDays + ' days. Try again later.'],
    unknown_store: [404, 'Your store could not be found.'],
  };
  if (r?.result !== 'changed') {
    const [status, error] = messages[String(r?.result)] || [500, 'The address could not be changed. Try again.'];
    return merchantJson({ error }, status);
  }
  await auditMerchant(gate.session, request, 'ADDRESS_CHANGED', r.old_slug + ' -> ' + r.new_slug);
  return merchantJson({ changed: true, url: urlOf(r.new_slug), previous: urlOf(r.old_slug), holdDays: STORE_ADDRESS_RULES.holdDays });
}
