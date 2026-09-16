/**
 * CLOUDFLARE FOR SAAS — Custom Hostnames API client.
 *
 * Wraps `/zones/:zone_id/custom_hostnames` (register a merchant's domain,
 * check its DNS/SSL verification status, remove it) and persists the
 * resolved status onto the owning tenant's row
 * (supabase/migrations/00010_custom_domains.sql). Status mapping is pure
 * logic in lib/cloudflare-status.ts (tested independently).
 *
 * CLEAN FALLBACK: every exported function checks `cloudflareConfigured()`
 * first and returns a typed `{ ok: false, notConfigured: true }` result
 * instead of throwing when `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` are
 * unset — local dev and the test suite never need real Cloudflare
 * credentials to import or call this module; callers (the admin domain
 * panel) render a "connect Cloudflare" prompt on that result instead of a
 * crash.
 */

import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { mapCloudflareDomainStatus, mapCloudflareSslStatus, type DomainStatus, type SslStatus } from '@/lib/cloudflare-status';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export type CloudflareResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; notConfigured?: boolean };

export interface CustomHostname {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  /** The CNAME target + TXT ownership-verification records the operator
   *  must add at their DNS provider — surfaced as-is from Cloudflare's
   *  response so the admin panel can render exact copy-paste values. */
  verificationRecords: Array<{ type: string; name: string; value: string }>;
}

export function cloudflareConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID);
}

function notConfiguredResult<T>(): CloudflareResult<T> {
  return {
    ok: false,
    notConfigured: true,
    error: 'Cloudflare for SaaS is not configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID to enable custom domains.',
  };
}

type CfCustomHostnameRaw = {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; validation_records?: Array<{ txt_name?: string; txt_value?: string }> };
  ownership_verification?: { type?: string; name?: string; value?: string };
};

function normalizeCustomHostname(raw: CfCustomHostnameRaw): CustomHostname {
  const records: CustomHostname['verificationRecords'] = [];
  if (raw.ownership_verification?.name && raw.ownership_verification?.value) {
    records.push({
      type: raw.ownership_verification.type || 'TXT',
      name: raw.ownership_verification.name,
      value: raw.ownership_verification.value,
    });
  }
  for (const rec of raw.ssl?.validation_records || []) {
    if (rec.txt_name && rec.txt_value) {
      records.push({ type: 'TXT', name: rec.txt_name, value: rec.txt_value });
    }
  }
  return {
    id: raw.id,
    hostname: raw.hostname,
    status: raw.status,
    sslStatus: raw.ssl?.status || '',
    verificationRecords: records,
  };
}

async function cfFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<CloudflareResult<any>> {
  if (!cloudflareConfigured()) return notConfiguredResult();
  try {
    const res = await fetch(`${CF_API_BASE}/zones/${process.env.CLOUDFLARE_ZONE_ID}${path}`, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null;
    if (!res.ok || !json?.success) {
      const message = json?.errors?.[0]?.message || `Cloudflare API error (HTTP ${res.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, data: json.result };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'Cloudflare API request failed' };
  }
}

/** Register a merchant's domain with Cloudflare for SaaS. Idempotent from
 *  the caller's point of view: if the hostname is already registered,
 *  Cloudflare returns a 409-ish error — callers should follow up with
 *  `findCustomHostname()` rather than treat that as fatal. */
export async function createCustomHostname(hostname: string): Promise<CloudflareResult<CustomHostname>> {
  const result = await cfFetch('/custom_hostnames', {
    method: 'POST',
    body: { hostname, ssl: { method: 'http', type: 'dv' } },
  });
  if (!result.ok) return result;
  return { ok: true, data: normalizeCustomHostname(result.data) };
}

export async function getCustomHostname(customHostnameId: string): Promise<CloudflareResult<CustomHostname>> {
  const result = await cfFetch(`/custom_hostnames/${encodeURIComponent(customHostnameId)}`);
  if (!result.ok) return result;
  return { ok: true, data: normalizeCustomHostname(result.data) };
}

export async function findCustomHostname(hostname: string): Promise<CloudflareResult<CustomHostname | null>> {
  const result = await cfFetch(`/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  if (!result.ok) return result;
  const rows = Array.isArray(result.data) ? result.data : [];
  return { ok: true, data: rows.length > 0 ? normalizeCustomHostname(rows[0]) : null };
}

export async function deleteCustomHostname(customHostnameId: string): Promise<CloudflareResult<null>> {
  const result = await cfFetch(`/custom_hostnames/${encodeURIComponent(customHostnameId)}`, { method: 'DELETE' });
  if (!result.ok) return result;
  return { ok: true, data: null };
}

export interface TenantDomainSyncResult {
  domainStatus: DomainStatus;
  sslStatus: SslStatus;
  verificationRecords: CustomHostname['verificationRecords'];
}

/**
 * The admin domain panel's single entry point: register (if not already
 * registered) or refresh `hostname` for `tenantId`, map its Cloudflare
 * status onto this app's trimmed-down status vocabulary, and persist it
 * onto the tenant's row. Returns the persisted status so the caller can
 * render it immediately without a second round-trip.
 */
export async function syncTenantDomainStatus(tenantId: string, hostname: string): Promise<CloudflareResult<TenantDomainSyncResult>> {
  if (!cloudflareConfigured()) return notConfiguredResult();
  if (!getDb().configured) {
    return { ok: false, error: 'Supabase is not configured — cannot persist domain status.' };
  }

  let hostnameResult = await findCustomHostname(hostname);
  if (!hostnameResult.ok) return hostnameResult;
  if (!hostnameResult.data) {
    const created = await createCustomHostname(hostname);
    if (!created.ok) return created;
    hostnameResult = { ok: true, data: created.data };
  }
  const record = hostnameResult.data!;

  const domainStatus = mapCloudflareDomainStatus(record.status);
  const sslStatus = mapCloudflareSslStatus(record.sslStatus);

  // returning: 'default' — the legacy PATCH sent no Prefer header at all, and
  // this caller ignores the response, so asking for the rows back would change
  // the request during a refactor meant to change nothing.
  await getDb().update(
    'tenants',
    { where: { id: eq(tenantId) } },
    {
      custom_domain: hostname,
      cloudflare_hostname_id: record.id,
      domain_status: domainStatus,
      ssl_status: sslStatus,
      domain_verification: { records: record.verificationRecords },
      domain_checked_at: new Date().toISOString(),
    },
    { returning: 'default' },
  );

  return { ok: true, data: { domainStatus, sslStatus, verificationRecords: record.verificationRecords } };
}
