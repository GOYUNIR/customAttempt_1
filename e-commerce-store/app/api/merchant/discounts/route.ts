import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { validateDiscountInput } from '@/lib/discount-rules';
import { discountAccess, listCodes, createCode, setCodeActive } from '@/lib/discounts';
import { chargeRouteForTenant } from '@/lib/connect';
import { resolveStripeClient } from '@/services/payment/factory';

export const dynamic = 'force-dynamic';

/**
 * This store's discount codes (DISCOUNT-CODES.md). The store comes from the
 * session; behind the plan flag (00045). GET: { enabled, limit, codes }.
 * POST { code, kind, amount, ...more } creates; POST { id, active } switches
 * one of THIS store's codes on or off. Every change is audited.
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const access = await discountAccess(gate.session.tenantId);
  return merchantJson({ ...access, codes: access.enabled ? await listCodes(gate.session.tenantId) : [] });
}

async function storeCurrency(tenantId: string): Promise<string> {
  try {
    const route = await chargeRouteForTenant(tenantId);
    if (route.route !== 'connected') return 'usd';
    const stripe: any = await resolveStripeClient();
    const acct = await stripe.v2.core.accounts.retrieve(route.stripeAccount, { include: ['defaults'] });
    return String(acct?.defaults?.currency || 'usd').toLowerCase();
  } catch { return 'usd'; }
}

export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_discounts', request, 30, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  const tenantId = gate.session.tenantId;
  if (typeof body?.id === 'string' && typeof body?.active === 'boolean' && body.code === undefined) {
    if (!/^[0-9a-f-]{36}$/.test(body.id)) return merchantJson({ error: 'Code not found.' }, 404);
    const r = await setCodeActive(tenantId, body.id, body.active);
    if (!r.ok) return merchantJson({ error: r.error }, r.status);
    await auditMerchant(gate.session, request, body.active ? 'DISCOUNT_ON' : 'DISCOUNT_OFF', body.id);
    return merchantJson({ ok: true, codes: await listCodes(tenantId) });
  }
  const check = validateDiscountInput(body);
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const r = await createCode(tenantId, check.value, check.value.kind === 'fixed' ? await storeCurrency(tenantId) : 'usd', gate.session.email);
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  await auditMerchant(gate.session, request, 'DISCOUNT_CREATED', check.value.code + ' ' + check.value.kind + ' ' + (check.value.percentBps ?? check.value.amountCents));
  return merchantJson({ ok: true, id: r.id, codes: await listCodes(tenantId) }, 201);
}
