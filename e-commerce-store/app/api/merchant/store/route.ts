import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { chargeRouteForTenant } from '@/lib/connect';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** The signed-in merchant's store: name, address, payments status. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const s = gate.session;
  const [route, rows] = await Promise.all([
    chargeRouteForTenant(s.tenantId),
    getDb().select<any>('tenants', { where: { id: eq(s.tenantId) }, select: ['plan_id', 'stripe_account_id', 'connect_charges_enabled', 'connect_payouts_enabled', 'connect_requirements'], limit: 1 }),
  ]);
  const t = (rows as any[])[0] || {};
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim();
  return merchantJson({
    // Where a stuck merchant can write (the platform inbox, not the store's own).
    support: getSupportEmail() || null,
    store: { name: s.tenantName, slug: s.tenantSlug, address: root && s.tenantSlug ? 'https://' + s.tenantSlug + '.' + root : null, plan: t.plan_id || null },
    you: { email: s.email, role: s.role },
    payments: {
      connected: route.route === 'connected',
      status: route.route === 'connected' ? 'ready' : route.route === 'blocked' ? route.reason : 'platform',
      hasAccount: Boolean(t.stripe_account_id),
      chargesEnabled: Boolean(t.connect_charges_enabled),
      payoutsEnabled: Boolean(t.connect_payouts_enabled),
      outstandingRequirements: Number(t.connect_requirements?.outstanding || 0),
    },
  });
}
