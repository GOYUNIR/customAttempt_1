/**
 * STOREFRONT TENANT — the tenant a storefront request is for, from its Host
 * header (TENANCY.md). The pure rule is lib/storefront-host.ts; this adds the
 * lookup and a short per-isolate cache.
 *
 * Never from a client-supplied header, query or body (T5): whoever sends the
 * request must not choose whose store it buys from.
 *
 * Our own surfaces (marketing apex, admin/app/sales portals) resolve to the
 * default store, as they always have: the admin preview and the marketing
 * site read /api/store from them. A merchant can never be served there.
 */
import { getDb } from '@/lib/db/client';
import { eq, type FilterOp } from '@/lib/db/query';
import { DEFAULT_TENANT_ID } from '@/lib/tenant-context';
import { classifyStorefrontHost, parseLegacyHosts } from '@/lib/storefront-host';
export { withNeutralHero } from '@/lib/storefront-host';

export type StorefrontTenant =
  | { kind: 'store'; tenantId: string; isDefault: boolean; slug: string | null; name: string | null }
  /** No store at this host: an unknown slug or domain, a reserved label, an expired store. */
  | { kind: 'none' }
  /** The lookup failed. Not "no store" and never "the default store": retry. */
  | { kind: 'unavailable' };

const DEFAULT_STORE: StorefrontTenant = { kind: 'store', tenantId: DEFAULT_TENANT_ID, isDefault: true, slug: null, name: null };
/** Stores that may be served. 'expired' is closed (TENANCY.md, owner may revisit). */
const SERVABLE = new Set(['active', 'grace']);

const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 15_000;
const cache = new Map<string, { value: StorefrontTenant; at: number }>();
let warnedMissingSetting = false;

function legacyHosts() {
  const root = process.env.PLATFORM_ROOT_DOMAIN;
  const parsed = parseLegacyHosts(process.env.STOREFRONT_LEGACY_HOSTS, root);
  if (!parsed && root && !warnedMissingSetting) {
    warnedMissingSetting = true;
    console.error('[storefront-tenant] STOREFRONT_LEGACY_HOSTS is not set: every unknown subdomain of ' + root +
      ' is being served as the default store (the pre-tenancy behaviour). Set it (wrangler.jsonc vars).');
  }
  return parsed;
}

async function lookup(where: Record<string, FilterOp>): Promise<StorefrontTenant> {
  const rows = (await getDb().select<any>('tenants', {
    where, select: ['id', 'slug', 'name', 'license_status'], limit: 1,
  })) as any[];
  const row = rows[0];
  if (!row || !SERVABLE.has(String(row.license_status || ''))) return { kind: 'none' };
  const tenantId = String(row.id);
  return { kind: 'store', tenantId, isDefault: tenantId === DEFAULT_TENANT_ID, slug: row.slug ?? null, name: row.name ?? null };
}

/** The tenant for a Host header value. */
export async function storefrontTenantForHost(hostHeader: string | null | undefined): Promise<StorefrontTenant> {
  const cls = classifyStorefrontHost({ host: String(hostHeader || ''), rootDomain: process.env.PLATFORM_ROOT_DOMAIN, legacyHosts: legacyHosts() });
  if (cls.kind === 'default' || cls.kind === 'marketing' || cls.kind === 'portal') return DEFAULT_STORE;
  if (cls.kind === 'not_found') return { kind: 'none' };

  const key = cls.kind === 'slug' ? 'slug:' + cls.slug : 'host:' + cls.host;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value.kind === 'store' ? HIT_TTL_MS : MISS_TTL_MS)) return hit.value;

  let value: StorefrontTenant;
  try {
    value = cls.kind === 'slug'
      ? await lookup({ slug: eq(cls.slug) })
      : await lookup({ custom_domain: eq(cls.host), domain_status: eq('active') });
  } catch (err) {
    console.error('[storefront-tenant] lookup failed for ' + key, (err as Error)?.message || err);
    return { kind: 'unavailable' }; // not cached: the next request retries
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

/** The tenant for a route handler's request. */
export function storefrontTenantForRequest(request: Request): Promise<StorefrontTenant> {
  return storefrontTenantForHost(request.headers.get('host'));
}

/** The tenant for a server component (reads the incoming Host header). */
export async function storefrontTenantFromHeaders(): Promise<StorefrontTenant> {
  const { headers } = await import('next/headers');
  return storefrontTenantForHost((await headers()).get('host'));
}

/**
 * Phase-1 guard for routes that are not tenant-aware yet (checkout, customer
 * accounts): they may only run for the default store. Anywhere else they would
 * act on the DEFAULT store's data (or money) from another store's address.
 * Returns a Response to send, or null to proceed.
 */
export async function refuseUnlessDefaultStore(request: Request): Promise<Response | null> {
  const who = await storefrontTenantForRequest(request);
  if (who.kind === 'store' && who.isDefault) return null;
  const status = who.kind === 'unavailable' ? 503 : who.kind === 'none' ? 404 : 409;
  const error = who.kind === 'store' ? 'This store cannot take orders yet.' : who.kind === 'none' ? 'Store not found.' : 'Please try again shortly.';
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

