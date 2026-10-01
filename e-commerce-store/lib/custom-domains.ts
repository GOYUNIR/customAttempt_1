/**
 * CUSTOM DOMAINS per store (STORE-ADDRESSES.md §B, 00040).
 *
 * Gates, in order, before a domain is even registered:
 *   payments connected and verified  (a store that cannot sell gets no domain)
 *   the plan's cap                    (plans.custom_domain_limit: plan DATA)
 *   not taken by any store            (tenant_domains primary key)
 * A domain SERVES only when BOTH hold:
 *   Cloudflare reports the hostname and its certificate active (the CNAME
 *   points here), AND the store proved ownership with its own TXT token.
 * The second check is ours on purpose: Cloudflare alone would activate a
 * hostname whose previous owner left a dangling CNAME pointing here, so a
 * different store could claim it. A new claimer cannot publish the TXT
 * record in someone else's DNS.
 * Removing a domain (by the owner, by a downgrade below the cap, or the store
 * going away) deletes the Cloudflare hostname too, so nothing dangles there.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { tenantPlan } from '@/lib/billing';
import { chargeRouteForTenant } from '@/lib/connect';
import { cloudflareConfigured, createCustomHostname, getCustomHostname, deleteCustomHostname, findCustomHostname } from '@/lib/cloudflare-saas';
import { mapCloudflareDomainStatus, mapCloudflareSslStatus } from '@/lib/cloudflare-status';
import { checkHostname, ownershipRecordName, domainCapAllows } from '@/lib/custom-domain-rules';
import { recordPlatformAudit } from '@/lib/platform-audit';

export type DomainRow = {
  hostname: string; tenant_id: string; verify_token: string; cloudflare_hostname_id: string | null;
  status: string; ssl_status: string; ownership_verified_at: string | null; is_primary: boolean; created_at: string; checked_at: string | null;
};
type Fail = { ok: false; status: number; error: string };

const root = () => String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase();
/** The platform's own domains: never connectable by a store. */
export function platformRoots(): string[] {
  return [root(), ...String(process.env.PLATFORM_OLD_ROOT_DOMAINS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(Boolean);
}
/** Where a store's CNAME points (Cloudflare for SaaS fallback). Config, not code. */
export function cnameTarget(): string {
  return String(process.env.CUSTOM_DOMAIN_CNAME_TARGET || ('stores.' + root())).trim().toLowerCase();
}

export async function listDomains(tenantId: string): Promise<DomainRow[]> {
  return (await getDb().select<DomainRow>('tenant_domains', { where: { tenant_id: eq(tenantId) }, order: { column: 'created_at' }, limit: 100 })) as DomainRow[];
}

/** The cap that applies NOW (tenantPlan honours a lapsed grace period). */
export async function domainLimit(tenantId: string): Promise<{ planName: string; limit: number | null }> {
  const plan = await tenantPlan(tenantId);
  const row = ((await getDb().select<any>('plans', { where: { id: eq(plan.id) }, select: ['custom_domain_limit'], limit: 1 })) as any[])[0];
  const v = row?.custom_domain_limit;
  return { planName: plan.name, limit: v === null || v === undefined ? null : Number(v) };
}

/** The two records the merchant adds, worded for any DNS provider. */
export function dnsInstructions(d: DomainRow) {
  return [
    { type: 'CNAME', name: d.hostname, value: cnameTarget(), why: 'Sends visitors to your store.' },
    { type: 'TXT', name: ownershipRecordName(d.hostname), value: d.verify_token, why: 'Proves the domain is yours.' },
  ];
}

export async function addDomain(tenantId: string, raw: string, actor: string): Promise<{ ok: true; domain: DomainRow } | Fail> {
  const rule = checkHostname(raw, { platformRoots: platformRoots() });
  if (!rule.ok) return { ok: false, status: 400, error: rule.reason };
  const hostname = rule.hostname;
  if ((await chargeRouteForTenant(tenantId)).route !== 'connected') {
    return { ok: false, status: 409, error: 'Connect payments first: a custom domain switches on once your store can take orders.' };
  }
  const { limit, planName } = await domainLimit(tenantId);
  const mine = await listDomains(tenantId);
  if (!domainCapAllows(limit, mine.length)) {
    return { ok: false, status: 409, error: 'Your ' + planName + ' plan includes ' + limit + ' custom domain' + (limit === 1 ? '' : 's') + '. Remove one first, or choose a plan with more.' };
  }
  const taken = ((await getDb().select<any>('tenant_domains', { where: { hostname: eq(hostname) }, select: ['tenant_id'], limit: 1 })) as any[])[0];
  if (taken) return { ok: false, status: 409, error: taken.tenant_id === tenantId ? 'That domain is already connected to your store.' : 'That domain is connected to another store.' };
  if (!cloudflareConfigured()) return { ok: false, status: 503, error: 'Custom domains are not switched on yet. Your store address works in the meantime.' };

  // A leftover Cloudflare record for this exact hostname (from a removal that
  // failed half-way) is reused rather than duplicated.
  const existing = await findCustomHostname(hostname);
  const cf = existing.ok && existing.data ? { ok: true as const, data: existing.data } : await createCustomHostname(hostname);
  if (!cf.ok) return { ok: false, status: 502, error: 'The domain could not be registered right now. Try again shortly.' };
  const row = {
    hostname, tenant_id: tenantId, verify_token: 'sv-' + randomBytes(16).toString('hex'),
    cloudflare_hostname_id: cf.data.id, status: 'pending', ssl_status: 'pending', is_primary: false,
  };
  try {
    await getDb().insert('tenant_domains', row, { returning: 'minimal' } as any);
  } catch {
    // Lost a race for the same hostname: undo our Cloudflare record, say taken.
    if (!(existing.ok && existing.data)) await deleteCustomHostname(cf.data.id).catch(() => null);
    return { ok: false, status: 409, error: 'That domain is connected to another store.' };
  }
  await recordPlatformAudit({ action: 'CUSTOM_DOMAIN_ADDED', actor, tenantId, detail: { hostname } });
  return { ok: true, domain: { ...row, ownership_verified_at: null, created_at: new Date().toISOString(), checked_at: null } };
}

/** TXT values at a name, via DNS-over-HTTPS (public resolver; no secrets). */
async function txtValues(name: string): Promise<string[]> {
  try {
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT', { headers: { accept: 'application/dns-json' } });
    const body: any = await res.json();
    return (body?.Answer || []).map((a: any) => String(a?.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  } catch { return []; }
}

/** Re-check one domain: our ownership TXT + Cloudflare's hostname and SSL. */
export async function checkDomain(tenantId: string, hostname: string): Promise<{ ok: true; domain: DomainRow } | Fail> {
  const d = (await listDomains(tenantId)).find((x) => x.hostname === hostname);
  if (!d) return { ok: false, status: 404, error: 'That domain is not connected to your store.' };
  const owned = d.ownership_verified_at || ((await txtValues(ownershipRecordName(hostname))).includes(d.verify_token) ? new Date().toISOString() : null);
  let status = d.status; let ssl = d.ssl_status;
  if (d.cloudflare_hostname_id) {
    const cf = await getCustomHostname(d.cloudflare_hostname_id);
    if (cf.ok) {
      const s = mapCloudflareDomainStatus(cf.data.status); const t = mapCloudflareSslStatus(cf.data.sslStatus);
      ssl = t;
      status = s === 'active' && t === 'active' && owned ? 'active' : s === 'error' || t === 'error' ? 'error' : 'pending';
    }
  }
  const mine = await listDomains(tenantId);
  const becomePrimary = status === 'active' && !mine.some((x) => x.is_primary);
  await getDb().update('tenant_domains', { where: { hostname: eq(hostname), tenant_id: eq(tenantId) } },
    { ownership_verified_at: owned, status, ssl_status: ssl, checked_at: new Date().toISOString(), ...(becomePrimary ? { is_primary: true } : {}) }, { returning: 'minimal' } as any);
  return { ok: true, domain: { ...d, ownership_verified_at: owned, status, ssl_status: ssl, is_primary: d.is_primary || becomePrimary } };
}

export async function setPrimary(tenantId: string, hostname: string, actor: string): Promise<{ ok: true } | Fail> {
  const d = (await listDomains(tenantId)).find((x) => x.hostname === hostname);
  if (!d) return { ok: false, status: 404, error: 'That domain is not connected to your store.' };
  if (d.status !== 'active') return { ok: false, status: 409, error: 'That domain is not live yet.' };
  await getDb().update('tenant_domains', { where: { tenant_id: eq(tenantId), is_primary: eq(true) } }, { is_primary: false }, { returning: 'minimal' } as any);
  await getDb().update('tenant_domains', { where: { tenant_id: eq(tenantId), hostname: eq(hostname) } }, { is_primary: true }, { returning: 'minimal' } as any);
  await recordPlatformAudit({ action: 'CUSTOM_DOMAIN_PRIMARY', actor, tenantId, detail: { hostname } });
  return { ok: true };
}

/** Remove: Cloudflare first (so nothing dangles there), then our row. */
export async function removeDomain(tenantId: string, hostname: string, actor: string, why = 'removed by the owner'): Promise<{ ok: true } | Fail> {
  const d = (await listDomains(tenantId)).find((x) => x.hostname === hostname);
  if (!d) return { ok: false, status: 404, error: 'That domain is not connected to your store.' };
  if (d.cloudflare_hostname_id) {
    const del = await deleteCustomHostname(d.cloudflare_hostname_id);
    if (!del.ok && !del.notConfigured) return { ok: false, status: 502, error: 'The domain could not be released right now. Try again shortly.' };
  }
  await getDb().remove('tenant_domains', { where: { hostname: eq(hostname), tenant_id: eq(tenantId) } });
  await recordPlatformAudit({ action: 'CUSTOM_DOMAIN_RELEASED', actor, tenantId, detail: { hostname, why } });
  return { ok: true };
}

/**
 * Over the cap (a downgrade, or a lapsed grace period): release the newest
 * domains beyond it, keeping the primary. Called when the plan changes and
 * whenever the domains are listed, so a lapse is caught without an event.
 */
export async function enforceDomainCap(tenantId: string): Promise<string[]> {
  const { limit } = await domainLimit(tenantId);
  if (limit === null) return [];
  const mine = await listDomains(tenantId);
  if (mine.length <= limit) return [];
  const keep = [...mine].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.created_at.localeCompare(b.created_at)).slice(0, limit).map((d) => d.hostname);
  const released: string[] = [];
  for (const d of mine) if (!keep.includes(d.hostname)) { if ((await removeDomain(tenantId, d.hostname, 'platform', 'over the plan cap')).ok) released.push(d.hostname); }
  return released;
}

/** Every domain of a store (store closed/deleted). */
export async function releaseAllDomains(tenantId: string): Promise<void> {
  for (const d of await listDomains(tenantId)) await removeDomain(tenantId, d.hostname, 'platform', 'store closed');
}
