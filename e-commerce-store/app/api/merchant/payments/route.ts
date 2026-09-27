import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { ensureConnectedAccount, chargeRouteForTenant } from '@/lib/connect';
import { resolveStripeClient } from '@/services/payment/factory';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Connect the signed-in merchant's store to Stripe: create (or reuse) THIS
 * store's connected account, then return a single-use Stripe onboarding link.
 * The country is the merchant's own statement (Stripe requires it and derives
 * the currency from it — CONNECT.md). The store is the session's; the account
 * is created with an idempotency key on that store, so a double click can't
 * make two.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can connect payments.' }, 403);
  const limited = await rateLimitedResponse('merchant_payments', request, 10, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const country = String(body?.country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return merchantJson({ error: 'Choose the country your business is registered in.' }, 400);

  const tenantId = gate.session.tenantId;
  const route = await chargeRouteForTenant(tenantId);
  if (route.route === 'connected') return merchantJson({ status: 'ready' });

  const stripe: any = await resolveStripeClient();
  if (!stripe) return merchantJson({ error: 'Payments are not available right now.' }, 503);
  let account: string;
  try {
    account = await ensureConnectedAccount(tenantId, gate.session.email, country);
  } catch (err: any) {
    const msg = err?.raw?.message || err?.message || String(err);
    console.error('[merchant/payments] account for ' + tenantId + ' failed: ' + msg);
    return merchantJson({ error: 'Stripe could not set up the account: ' + msg }, 400);
  }
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim();
  if (!root) return merchantJson({ error: 'Payments are not available right now.' }, 503);
  const link = await stripe.v2.core.accountLinks.create({
    account,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant'],
        refresh_url: 'https://app.' + root + '/app?payments=refresh',
        return_url: 'https://app.' + root + '/app?payments=return',
      },
    },
  });
  return merchantJson({ status: 'onboarding', url: link.url });
}
