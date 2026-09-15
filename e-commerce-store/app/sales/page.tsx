import { redirect } from 'next/navigation';
import { resolveAdminActorForPage } from '@/lib/admin-actor-from-headers';
import { actorHasSalesAccess } from '@/lib/admin-actor';
import { recordPlatformAudit } from '@/lib/platform-audit';
import SalesHubView from '@/components/sales/SalesHubView';

/**
 * SALES HUB — standalone deal-desk portal (app/sales).
 *
 * `middleware.ts`'s `isSalesPath` gate already confirms this is a valid
 * admin session of SOME kind before this Server Component ever renders
 * (readiness, Basic Auth / login-session / device cookie, 2FA — the coarse
 * check, Edge-safe). The finer check — is this actor SPECIFICALLY
 * sales-scoped (`sales_rep`/`sales_admin`/`deal_desk`/`sales`/`super_admin`,
 * not a generic `owner`/`staff` admin session) — can't run in middleware
 * (`resolveAdminActor` needs Node's `crypto`, unavailable on the Edge
 * runtime), so it runs here, same as every other role-sensitive decision in
 * this codebase (route-level via `actorHasFullAdminAccess`/
 * `actorHasSalesAccess`, never middleware-level).
 */
export default async function SalesHubPage() {
  const actor = await resolveAdminActorForPage();
  if (!actorHasSalesAccess(actor)) {
    if (actor) {
      // Authenticated but the wrong role — record it. (No actor at all means
      // middleware's coarse gate somehow let an unauthenticated request
      // through, which would itself be a bug worth an audit trail catching,
      // but there's no actor identity to attach to that case.)
      await recordPlatformAudit({
        action: 'unauthorized_portal_access',
        actor: actor.email || undefined,
        tenantId: actor.tenantId,
        detail: { portal: 'sales', role: actor.role, impersonating: actor.impersonating },
      });
    }
    redirect('/admin?error=sales_access_required');
  }
  return <SalesHubView />;
}
