/**
 * TEMPORARY: restock, then replay a real checkout.session.completed at
 * production with the cart trimmed to N items, to measure subrequest cost.
 *   npx tsx scripts/tmp-measure.ts <cs_id> <items>
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();
process.env.USE_POSTGRES_PRIMARY = 'true';

const TARGET = 'https://goyunir.com/api/stripe/webhook';
const STOCK = [
  { ext: 'prod_mtfks8ha', size: 'sample', qty: 3 },
  { ext: 'prod_mtfjuf1n', size: 'sample', qty: 3 },
];

async function main() {
  const csId = process.argv[2];
  const items = Number(process.argv[3] || 1);

  const { resolveStripeClient, resolvePaymentWebhookSecret } = await import('../services/payment/factory');
  const { createKvClient, loadProducts, getLiveProductState, saveLiveState } = await import('../lib/server-config');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');

  const stripe = await resolveStripeClient();
  const secret = await resolvePaymentWebhookSecret();
  const redis = createKvClient();
  if (!stripe || !secret || !redis) throw new Error('stripe/secret/redis missing');
  const db = getDb();
  const tenantId = await ensureDefaultTenant();
  const products = await loadProducts(redis);

  for (const s of STOCK) {
    const prow = (await db.select('products', { where: { tenant_id: eq(tenantId), external_id: eq(s.ext) }, select: ['id'], limit: 1 })) as any[];
    const vrow = (await db.select('product_variants', { where: { product_id: eq(prow[0].id), option_label: eq(s.size) }, select: ['id'], limit: 1 })) as any[];
    await db.update('inventory_levels', { where: { tenant_id: eq(tenantId), variant_id: eq(vrow[0].id) } }, { quantity_available: s.qty });
    await db.update('products', { where: { tenant_id: eq(tenantId), id: eq(prow[0].id) } }, { max_per_email: 3 });
    const prod = (Object.values(products) as any[]).find((p) => String(p.id) === s.ext);
    const live = await getLiveProductState(redis, prod, s.size);
    live.inventoryRemaining = s.qty;
    await saveLiveState(redis, live);
  }

  const list: any = await stripe.events.list({ limit: 60, type: 'checkout.session.completed' });
  const event = list.data.find((e: any) => e.data?.object?.id === csId);
  if (!event) throw new Error('no event for ' + csId);
  const session = event.data.object;

  const cart = JSON.parse(String(session.metadata.cartItems || '[]')).slice(0, items);
  session.metadata.cartItems = JSON.stringify(cart);
  session.id = session.id + '_m' + Date.now().toString(36);
  console.log('replaying ' + cart.length + ' item(s): '
    + cart.map((i: any) => i.variant + '/' + i.size + ' x' + i.quantity).join(', '));

  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(ts + '.' + payload, 'utf8').digest('hex');
  const started = Date.now();
  const res = await fetch(TARGET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=' + ts + ',v1=' + sig, 'x-forwarded-host': 'goyunir.com' },
    body: payload,
  });
  console.log('status ' + res.status + ' in ' + (Date.now() - started) + 'ms  body=' + (await res.text()).slice(0, 200));
}
main().catch((e) => { console.error(e); process.exit(1); });
