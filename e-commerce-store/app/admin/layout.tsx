import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { resolveAdminActorForPage } from '@/lib/admin-actor-from-headers';
import { actorHasPlatformAdminAccess, actorHasMerchantAccess } from '@/lib/admin-actor';
import { classifyHost } from '@/lib/edge-router';
import { recordPlatformAudit } from '@/lib/platform-audit';
import PortalForbidden from '@/components/PortalForbidden';

/**
 * Zero-trust portal RBAC for `app/admin` — wraps the existing (huge,
 * unmodified) `app/admin/page.tsx` client app. `middleware.ts`'s
 * `isPortalPathAllowed` already confirmed the Host is allowed to reach
 * `/admin*` at all (Edge-safe, coarse); this Server Component adds the
 * finer per-ROLE check, which needs `lib/admin-verify.ts` (Node's
 * `crypto`, unavailable on the Edge runtime middleware runs on):
 *
 *   - `admin.site.com` (portal 'admin')    → super_admin ONLY (actorHasPlatformAdminAccess)
 *   - `app.site.com`   (portal 'merchant') → owner/staff/super_admin (actorHasMerchantAccess)
 *   - anything else (PLATFORM_ROOT_DOMAIN unset, local dev, a preview URL)
 *     → today's behavior, unchanged: any valid admin session, no portal split.
 *
 * No session at all → redirect to `/admin/login` (the one login surface all
 * three portals share — see app/sales/page.tsx's header for why no separate
 * `/login` route was built). A session that IS authenticated but doesn't
 * satisfy the portal's role → a 403 page AND an immutable audit-log entry
 * (`recordPlatformAudit`), never a silent redirect.
 */
/** Paths that must render with NO session at all — mirrors middleware.ts's
 *  own isLoginPath/isSetupPath/isSuperLoginPath exemptions. Without this,
 *  an anonymous visit to /admin/login would redirect to /admin/login,
 *  forever. */
function isAuthExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith('/admin/login') ||
    pathname.startsWith('/admin/setup') ||
    pathname.startsWith('/admin/setup-status')
  );
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const rootDomain = process.env.PLATFORM_ROOT_DOMAIN || undefined;
  const headersList = await headers();
  const pathname = headersList.get('x-pathname') || '';

  if (isAuthExemptPath(pathname)) {
    return children;
  }

  const actor = await resolveAdminActorForPage();

  if (!actor) {
    redirect('/admin/login');
  }

  if (rootDomain) {
    const portal = classifyHost(headersList.get('host') || '', rootDomain);
    const isPlatformPortal = portal === 'admin';
    const isMerchantPortal = portal === 'merchant';
    const allowed = isPlatformPortal
      ? actorHasPlatformAdminAccess(actor)
      : isMerchantPortal
        ? actorHasMerchantAccess(actor)
        : true; // an unrecognized/storefront host reaching here at all was already blocked by middleware

    if (!allowed) {
      await recordPlatformAudit({
        action: 'unauthorized_portal_access',
        actor: actor.email || undefined,
        tenantId: actor.tenantId,
        detail: { portal, role: actor.role, impersonating: actor.impersonating },
      });
      return (
        <PortalForbidden
          portalName={isPlatformPortal ? 'the Platform Admin portal' : 'the Merchant Hub'}
          requiredRoles={isPlatformPortal ? 'the super_admin role' : 'an owner, staff, or super_admin role'}
        />
      );
    }
  }

  return children;
}
