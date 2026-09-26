/**
 * STOREFRONT HOST — which store a Host header asks for. Pure (no imports), so
 * the rule that decides whose catalog is shown and whose checkout runs is
 * unit-tested rather than re-derived per route. Design: TENANCY.md §2–3.
 *
 * The answer is a CLAIM to be looked up, never a tenant id: a slug or custom
 * domain still has to exist in `tenants` (lib/storefront-tenant.ts).
 */

export type StorefrontHostClass =
  /** The legacy single store: listed hosts, or a deployment with no root domain. */
  | { kind: 'default' }
  /** `<slug>.<root>`: the tenant with that slug, if one exists. */
  | { kind: 'slug'; slug: string }
  /** A host outside the root: a tenant whose verified custom domain it is. */
  | { kind: 'custom'; host: string }
  /** The bare root domain: the platform's marketing site, not a store. */
  | { kind: 'marketing' }
  /** admin./app./sales.: staff portals, not stores. */
  | { kind: 'portal' }
  /** Nothing to serve: a reserved label, or a malformed host. */
  | { kind: 'not_found' };

/** Subdomains that are the platform's own and can never be a store's slug.
 *  The legacy hosts (STOREFRONT_LEGACY_HOSTS) are reserved on top of these. */
export const RESERVED_STORE_LABELS: readonly string[] = [
  'admin', 'app', 'sales', 'www', 'api', 'media', 'mail', 'email', 'smtp', 'ftp',
  'shop', 'store', 'default', 'static', 'assets', 'cdn', 'status', 'help', 'support',
  'docs', 'blog', 'dashboard', 'billing', 'auth', 'login', 'account', 'accounts',
  'platform', 'staging', 'dev', 'test', 'preview', 'localhost',
];

const PORTAL_LABELS = new Set(['admin', 'app', 'sales']);

function normalizeHost(host: string): string {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * The legacy store's hosts from the setting's raw value. An entry without a
 * dot is a label under the root ("shop" -> "shop.<root>"); an entry with one
 * is taken as a full host. Returns null when the setting is absent/empty —
 * the caller must then keep today's behaviour instead of 404ing the live
 * store (see classifyStorefrontHost).
 */
export function parseLegacyHosts(raw: string | undefined, rootDomain: string | undefined): Set<string> | null {
  const root = normalizeHost(rootDomain || '');
  const entries = String(raw || '').split(',').map((s) => normalizeHost(s)).filter(Boolean);
  if (entries.length === 0) return null;
  return new Set(entries.map((e) => (e.includes('.') || !root ? e : e + '.' + root)));
}

/** A slug a merchant may NOT take: a platform label or a legacy host's label. */
export function isReservedStoreSlug(slug: string, legacyHosts: Set<string> | null, rootDomain: string | undefined): boolean {
  const s = normalizeHost(slug);
  if (!s) return true;
  if (RESERVED_STORE_LABELS.includes(s)) return true;
  const root = normalizeHost(rootDomain || '');
  if (legacyHosts && root && legacyHosts.has(s + '.' + root)) return true;
  return false;
}

/**
 * Classify a Host header (TENANCY.md §3). `legacyHosts` null means the
 * setting is missing: unknown subdomains then stay the default store, exactly
 * as before this module existed, so a setting that failed to reach production
 * can never take the live store offline. The caller logs that loudly.
 */
export function classifyStorefrontHost(input: {
  host: string;
  rootDomain: string | undefined;
  legacyHosts: Set<string> | null;
}): StorefrontHostClass {
  const host = normalizeHost(input.host);
  const root = normalizeHost(input.rootDomain || '');
  if (!root) return { kind: 'default' }; // T6: single-domain deployment
  if (!host) return { kind: 'not_found' };
  if (host === root) return { kind: 'marketing' };
  if (input.legacyHosts && input.legacyHosts.has(host)) return { kind: 'default' }; // T2, before any slug

  if (host.endsWith('.' + root)) {
    const label = host.slice(0, -(root.length + 1));
    if (PORTAL_LABELS.has(label)) return { kind: 'portal' };
    // Only one label deep: "a.b.<root>" is nobody's store.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { kind: 'not_found' };
    if (!input.legacyHosts) return { kind: 'default' }; // setting missing: today's behaviour
    if (RESERVED_STORE_LABELS.includes(label)) return { kind: 'not_found' };
    return { kind: 'slug', slug: label };
  }

  if (host === 'localhost' || host === '127.0.0.1') return { kind: 'default' };
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return { kind: 'not_found' };
  return { kind: 'custom', host };
}
