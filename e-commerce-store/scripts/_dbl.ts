import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const stock = await import('../lib/stock');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe: any = await resolveStripeClient();
  const A = '13591c9e-82e4-4c23-8d94-249cef6fa775';
  const v = String(await resolveVariantId(A, 'prod_tenant_test_1', 'One Size'));
  const before = (await stock.stockLevels(A, [v])).get(v)!.onHand;
  await stock.setStock(A, v, 1, 'dbl-probe', 'probe');
  const email = 'delivered+dbl' + Date.now().toString(36) + '@resend.dev';
  const co = () => fetch('https://test4.goyunir.com/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test4.goyunir.com' }, body: JSON.stringify({ productId: 'prod_tenant_test_1', size: 'One Size', email, address: '1600 Pennsylvania Avenue NW, Washington, DC 20500, United States' }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), t: new Date().toISOString() }));
  const sessions: string[] = [];
  try {
    const a = await co(); console.log('tap 1', a.t, a.status, JSON.stringify(a.body).slice(0, 140)); if (a.body?.sessionId) sessions.push(a.body.sessionId);
    const b = await co(); console.log('tap 2', b.t, b.status, JSON.stringify(b.body).slice(0, 140)); if (b.body?.sessionId) sessions.push(b.body.sessionId);
    const holds = await getDb().select<any>('stock_holds', { where: { tenant_id: eq(A), reference: eq('buyer:' + email) }, select: ['hold_key', 'status', 'created_at'] });
    console.log('holds', JSON.stringify(holds));
  } finally {
    for (const s of new Set(sessions)) await stripe.checkout.sessions.expire(s, {}, { stripeAccount: 'acct_1UJWFxPIsRXBZjvC' }).catch(() => null);
    const hs = (await getDb().select<any>('stock_holds', { where: { tenant_id: eq(A), reference: eq('buyer:' + email) }, select: ['hold_key', 'status'] })) as any[];
    for (const h of hs) if (h.status === 'active') await stock.releaseStock(A, h.hold_key);
    await stock.setStock(A, v, before, 'dbl-probe', 'restore');
  }
})();
