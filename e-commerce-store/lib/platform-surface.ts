/**
 * Which paths belong to the PLATFORM's own marketing site rather than to a
 * merchant's shop.
 *
 * The root layout wraps every page in `SiteChrome` — the storefront's cart
 * drawer, its "MORE" nav, its brand mark and its shopper-facing footer. That is
 * correct for a shop and wrong for the page where a business evaluates the
 * software: it put two brand marks on the screen and a link into a tenant's
 * catalog on our own homepage.
 *
 * Kept as a shared predicate rather than a check inside SiteChrome so that the
 * marketing surface is defined in ONE place. The next page that needs to escape
 * the storefront chrome adds a prefix here instead of finding this logic buried
 * in a component.
 *
 * Zero imports so it can be used from a client component, a server component or
 * middleware without dragging anything along.
 */

/** Path prefixes that render the platform's own chrome, not a shop's. */
export const PLATFORM_SURFACE_PREFIXES = ['/platform'] as const;

export function isPlatformSurface(pathname: string | null | undefined): boolean {
  const path = String(pathname || '');
  return PLATFORM_SURFACE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/'),
  );
}
