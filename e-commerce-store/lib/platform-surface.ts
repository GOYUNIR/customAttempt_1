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
  return matchesPrefix(pathname, PLATFORM_SURFACE_PREFIXES);
}

/**
 * The staff portals: merchant, sales and platform admin.
 *
 * SEPARATE FROM `isPlatformSurface` on purpose, because the two surfaces want
 * different things from the layout. The marketing site wants NO tenant theme at
 * all — it is not a shop and the theme blob is most of its weight. The staff
 * portals still want the theme DATA (the admin Settings screen previews a
 * merchant's live colours, and cutting it off would break the editor) but must
 * not wear the shopper CHROME.
 *
 * What that chrome looked like on a sign-in page, before this existed: the
 * sales portal's login carried the store's cart nav, its Instagram and TikTok
 * links, "Manage My Entry", "Keep scrolling ↓" and a shop copyright line —
 * beneath a form that says "For sales representatives." It read as unfinished
 * because it was the wrong page's furniture, not because anything was broken.
 *
 * `/auth/*` is deliberately ABSENT. That is the customer signing in to the
 * shop, and shop chrome is exactly right there.
 */
export const STAFF_SURFACE_PREFIXES = ['/admin', '/sales', '/app'] as const;

export function isStaffSurface(pathname: string | null | undefined): boolean {
  return matchesPrefix(pathname, STAFF_SURFACE_PREFIXES);
}

/** True when the page should render without the storefront's shopper chrome. */
export function hidesStorefrontChrome(pathname: string | null | undefined): boolean {
  return isPlatformSurface(pathname) || isStaffSurface(pathname);
}

function matchesPrefix(pathname: string | null | undefined, prefixes: readonly string[]): boolean {
  const path = String(pathname || '');
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}
