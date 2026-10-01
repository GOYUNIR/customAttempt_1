import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { listDomains, addDomain, checkDomain, setPrimary, removeDomain, enforceDomainCap, domainLimit, dnsInstructions } from '@/lib/custom-domains';

export const dynamic = 'force-dynamic';

/**
 * THIS store's custom domains (STORE-ADDRESSES.md §B). Owner only; the store
 * is always the session's. Gates and the serving rule live in
 * lib/custom-domains.ts.
 *   GET            list with DNS instructions and status, plus the plan cap
 *   POST {hostname}            connect one
 *   PATCH {hostname, action}   'check' (re-verify) | 'primary'
 *   DELETE ?hostname=          release it (Cloudflare first, then ours)
 */
const notOwner = () => merchantJson({ error: 'Only the store owner can manage custom domains.' }, 403);

async function view(tenantId: string) {
  await enforceDomainCap(tenantId);  // a lapsed grace period is caught here too
  const [domains, cap] = await Promise.all([listDomains(tenantId), domainLimit(tenantId)]);
  return {
    plan: cap.planName, limit: cap.limit, used: domains.length,
    domains: domains.map((d) => ({
      hostname: d.hostname, status: d.status, ssl: d.ssl_status, ownershipVerified: Boolean(d.ownership_verified_at),
      primary: d.is_primary, checkedAt: d.checked_at, records: dnsInstructions(d),
    })),
  };
}

export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return notOwner();
  const o = { session: gate.session };
  return merchantJson(await view(o.session.tenantId));
}

export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return notOwner();
  const o = { session: gate.session };
  const limited = await rateLimitedResponse('merchant_domains', request, 10, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const r = await addDomain(o.session.tenantId, String(body?.hostname || ''), o.session.email);
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  await auditMerchant(o.session, request, 'DOMAIN_ADDED', r.domain.hostname);
  return merchantJson(await view(o.session.tenantId), 201);
}

export async function PATCH(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return notOwner();
  const o = { session: gate.session };
  const limited = await rateLimitedResponse('merchant_domains', request, 30, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const hostname = String(body?.hostname || '').toLowerCase();
  const r = body?.action === 'primary' ? await setPrimary(o.session.tenantId, hostname, o.session.email) : await checkDomain(o.session.tenantId, hostname);
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  return merchantJson(await view(o.session.tenantId));
}

export async function DELETE(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return notOwner();
  const o = { session: gate.session };
  const hostname = String(new URL(request.url).searchParams.get('hostname') || '').toLowerCase();
  const r = await removeDomain(o.session.tenantId, hostname, o.session.email);
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  await auditMerchant(o.session, request, 'DOMAIN_RELEASED', hostname);
  return merchantJson(await view(o.session.tenantId));
}
