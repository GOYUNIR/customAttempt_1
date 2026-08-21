/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RBAC + 4-TIER MULTI-TENANT ROUTING CORE.
 *
 * The single source of truth for the platform's role hierarchy and route
 * prefixes. The 4 tiers map to dedicated entry points:
 *
 *   Tier 1  maindomain.com/a   Super Admin Portal — platform metrics, system
 *                              health, master configuration, tenant overrides,
 *                              audit logs.
 *   Tier 2  maindomain.com/s   Sales Team Portal — merchant onboarding,
 *                              assigned-client management, commission metrics.
 *   Tier 3  maindomain.com/b   Business Owner Portal — store configuration,
 *                              inventory/item management, orders/appointments,
 *                              staff + custom-domain mapping.
 *   Tier 4  customdomain.com   End-Customer Storefront — fully-branded public
 *                              interface per business custom domain.
 *
 * DESIGN — ZERO imports (no `@/`, no Node builtins) so `middleware.ts` (Edge
 * runtime) and the `node --test` runner both load it directly, exactly like
 * `lib/env-discovery.ts` / `lib/license.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The platform's RBAC roles (mirrors the `users.role` SQL check constraint). */
export type PortalRole = 'super_admin' | 'sales' | 'owner' | 'staff' | 'customer';

/** The 4 architectural tiers. */
export type PortalTier = 1 | 2 | 3 | 4;

export const PORTAL_ROLES: readonly PortalRole[] = [
  'super_admin',
  'sales',
  'owner',
  'staff',
  'customer',
];

/** Route prefix per administrative tier. Tier 4 has no prefix (public/custom). */
export const TIER_PREFIXES: Record<1 | 2 | 3, string> = {
  1: '/a',
  2: '/s',
  3: '/b',
};

/** Fine-grained capabilities a role may hold. */
export type Capability =
  | 'platform.metrics.read'
  | 'platform.config.write'
  | 'platform.audit.read'
  | 'tenant.manage'
  | 'sales.manage'
  | 'business.config.write'
  | 'item.manage'
  | 'order.manage'
  | 'customer.self';

export const CAPABILITIES: readonly Capability[] = [
  'platform.metrics.read',
  'platform.config.write',
  'platform.audit.read',
  'tenant.manage',
  'sales.manage',
  'business.config.write',
  'item.manage',
  'order.manage',
  'customer.self',
];

/** Coerce an untrusted value into a PortalRole (null when invalid). */
export function sanitizeRole(value: unknown): PortalRole | null {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  return (PORTAL_ROLES as readonly string[]).includes(v) ? (v as PortalRole) : null;
}

/**
 * Classify a request pathname into a tier. `/a*` → 1, `/s*` → 2, `/b*` → 3,
 * everything else → 4 (public site + customer storefront).
 */
export function tierFromPathname(pathname: string): PortalTier {
  const p = String(pathname || '/').toLowerCase();
  if (p === '/a' || p.startsWith('/a/')) return 1;
  if (p === '/s' || p.startsWith('/s/')) return 2;
  if (p === '/b' || p.startsWith('/b/')) return 3;
  return 4;
}

/** The URL prefix for an administrative tier (null for Tier 4). */
export function portalPrefixForTier(tier: PortalTier): string | null {
  return tier === 4 ? null : TIER_PREFIXES[tier];
}

/** Every tier a given role is permitted to enter. */
export function roleTiers(role: PortalRole): PortalTier[] {
  switch (role) {
    case 'super_admin':
      return [1, 2, 3, 4];
    case 'sales':
      return [2, 3, 4];
    case 'owner':
    case 'staff':
      return [3, 4];
    case 'customer':
      return [4];
  }
}

/** Whether a role may access a tier. */
export function roleCanAccessTier(role: PortalRole | null, tier: PortalTier): boolean {
  if (!role) return tier === 4; // unauthenticated → public tier only
  return roleTiers(role).includes(tier);
}

/** Every capability a role holds. */
export function roleCapabilities(role: PortalRole | null): Capability[] {
  switch (role) {
    case 'super_admin':
      return CAPABILITIES.slice();
    case 'sales':
      return ['platform.metrics.read', 'tenant.manage', 'sales.manage'];
    case 'owner':
      return ['business.config.write', 'item.manage', 'order.manage'];
    case 'staff':
      return ['item.manage', 'order.manage'];
    case 'customer':
      return ['customer.self'];
    default:
      return [];
  }
}

/** Whether a role holds a capability. */
export function roleHasCapability(role: PortalRole | null, capability: Capability): boolean {
  return roleCapabilities(role).includes(capability);
}

/** The actor context used for tenant-scope + permission checks. */
export interface Actor {
  role: PortalRole | null;
  /** The actor's own tenant id (owner/staff/customer). */
  tenantId: string | null;
  /** For sales roles — the tenant ids they are assigned to manage. */
  assignedTenantIds?: string[];
}

/**
 * Tenant-boundary guard. Returns true when `actor` is allowed to operate on
 * `targetTenantId`. Super admins are unrestricted; sales may touch only their
 * assigned tenants; owner/staff/customer are confined to their own tenant.
 * Fails closed when the target is missing.
 */
export function canAccessTenant(actor: Actor, targetTenantId: string | null | undefined): boolean {
  if (!targetTenantId) return false;
  if (!actor.role) return false; // unauthenticated → fail closed
  if (actor.role === 'super_admin') return true;
  if (actor.role === 'sales') {
    return Boolean(actor.assignedTenantIds && actor.assignedTenantIds.includes(targetTenantId));
  }
  return actor.tenantId === targetTenantId;
}


/** Lowercase + strip protocol/port/trailing-dot from a hostname. */
export function normalizeHostname(host: string): string {
  let h = String(host || '').trim().toLowerCase();
  if (!h) return '';
  // strip protocol
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // strip path + trailing slash
  h = h.split('/')[0];
  // strip port
  h = h.replace(/:\d+$/, '');
  // strip trailing dot
  h = h.replace(/\.$/, '');
  return h;
}

/**
 * Whether a hostname is the PLATFORM's own domain (apex only). Subdomains are
 * treated as tenant sites (Tier 4 custom domains), matching the "custom
 * domain per business" model. When no platform domains are configured every
 * host is treated as platform (fail-safe: never mis-route a tenant storefront).
 */
export function isPlatformDomain(hostname: string, platformDomains: string[] = []): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  const domains = (platformDomains || []).map(normalizeHostname).filter(Boolean);
  if (domains.length === 0) return true;
  return domains.includes(host);
}

export interface RequestClassification {
  tier: PortalTier;
  /** True when the hostname is NOT the platform domain (a tenant storefront). */
  isCustomDomain: boolean;
  /** The admin portal prefix for this request (null for Tier 4). */
  portalPrefix: string | null;
}

/**
 * Classify a request: custom domains are always Tier 4 storefronts; on the
 * platform domain the pathname prefix selects the admin tier.
 */
export function classifyRequest(
  hostname: string,
  pathname: string,
  platformDomains: string[] = [],
): RequestClassification {
  const isCustomDomain = !isPlatformDomain(hostname, platformDomains);
  const tier: PortalTier = isCustomDomain ? 4 : tierFromPathname(pathname);
  return { tier, isCustomDomain, portalPrefix: portalPrefixForTier(tier) };
}
