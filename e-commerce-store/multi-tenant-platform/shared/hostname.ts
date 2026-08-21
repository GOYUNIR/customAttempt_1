/**
 * Hostname → tenant resolution + KV cache-key derivation.
 *
 * Pure and dependency-free so the Cloudflare Worker and the Admin Portal
 * (cache invalidation) agree on every key. Unit-tested with `node --test`.
 */

export interface ResolvedSite {
  /** Normalized hostname that produced this resolution (lowercased, no port). */
  hostname: string;
  /** 'platform' = *.yourplatform.com subdomain; 'custom' = the tenant's own domain. */
  kind: 'platform' | 'custom';
  /** Value used to build the KV cache key (`site_cache:v<N>:<siteKey>`). */
  siteKey: string;
  /** Present when kind === 'platform'. */
  subdomain: string | null;
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Lowercase, strip any port and ALL trailing dots (`example.com.` is a valid FQDN). */
export function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .split(':')[0] ?? '';
}

/**
 * Resolve a request hostname to a tenant:
 *  - `demo.yourplatform.com` → platform tenant with siteKey `demo`
 *  - `shop.acme.com`        → custom-domain tenant with siteKey `shop.acme.com`
 *  - `www.shop.acme.com`    → same tenant as `shop.acme.com`
 * Returns null for the platform apex, bare/local hosts, or malformed subdomains.
 */
export function resolveSiteKey(hostname: string, platformRootDomain: string): ResolvedSite | null {
  const host = normalizeHostname(hostname);
  const root = platformRootDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.$/, '');
  if (!host || !root) return null;

  const isPlatformHost = host === root || host.endsWith(`.${root}`);
  if (isPlatformHost) {
    // The apex is the platform's own marketing/login domain, never a tenant.
    if (host === root) return null;
    const subdomain = host.slice(0, -(root.length + 1));
    if (!SUBDOMAIN_RE.test(subdomain)) return null;
    return { hostname: host, kind: 'platform', siteKey: subdomain, subdomain };
  }

  // Custom domain: treat `www.` as an alias of the bare domain.
  const withoutWww = host.startsWith('www.') ? host.slice(4) : host;
  if (!withoutWww.includes('.') || withoutWww === 'localhost') return null;
  // Raw IPv4 (and IPv6, which contains no dots) are never tenants.
  if (IPV4_RE.test(withoutWww) || withoutWww.includes(':')) return null;
  return { hostname: host, kind: 'custom', siteKey: withoutWww, subdomain: null };
}

/** The exact KV key for a tenant. `cacheVersion` lets a shape change self-invalidate. */
export function cacheKeyForSite(siteKey: string, cacheVersion: number): string {
  return `site_cache:v${cacheVersion}:${siteKey}`;
}
