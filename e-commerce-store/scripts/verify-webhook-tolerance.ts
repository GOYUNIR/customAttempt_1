/**
 * WEBHOOKS TOLERATE WHAT WE NO LONGER HAVE (after a launch reset): a signed
 * Connect event for an account no store owns, and a refund for a payment
 * whose order was deleted, are each acknowledged with a 2xx (so Stripe does
 * not retry forever), logged, and change nothing. Events are signed with the
 * real (test-mode) Connect webhook secret and sent to production.
 *
 *   npx tsx scripts/verify-webhook-tolerance.ts
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);

(async () => {
  const { resolveConnectWebhookSecret } = await import('../lib/connect');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const secret = await resolveConnectWebhookSecret();
  if (!/^whsec_/.test(secret)) throw new Error('no Connect webhook secret');
  const send = async (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(t + '.' + payload).digest('hex');
    const r = await fetch('https://' + ROOT + '/api/stripe/connect-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=' + t + ',v1=' + sig }, body: payload });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };
  const base = { object: 'event', api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), livemode: false };

  console.log('\nAn account no store owns');
  const ordersBefore = ((await db().select<any>('orders', { select: ['id'] })) as any[]).length;
  function db() { return getDb(); }
  const r1 = await send({ ...base, id: 'evt_tol_acct_' + run, type: 'account.updated', account: 'acct_tolerance' + run, data: { object: { id: 'acct_tolerance' + run, object: 'account' } } });
  check(r1.status === 200 && Boolean(r1.body?.ignored), 'account.updated: 200, ignored (' + JSON.stringify(r1.body) + ')');
  const r2 = await send({ ...base, id: 'evt_tol_cs_' + run, type: 'checkout.session.completed', account: 'acct_tolerance' + run, data: { object: { id: 'cs_test_tol' + run, object: 'checkout.session', mode: 'payment', payment_status: 'paid', metadata: { tenant_id: '00000000-0000-0000-0000-0000000000aa' } } } });
  check(r2.status === 200 && Boolean(r2.body?.refused), 'a paid checkout on it: 200, refused, nothing written (' + JSON.stringify(r2.body) + ')');
  check(((await db().select<any>('orders', { select: ['id'] })) as any[]).length === ordersBefore, 'no order was created');

  console.log('\nA refund for a payment whose order was deleted');
  const test4 = ((await db().select<any>('tenants', { where: { slug: eq('test4') }, select: ['id', 'stripe_account_id'], limit: 1 }).catch(() => [])) as any[])[0];
  const acct = test4?.stripe_account_id;
  if (!acct) { console.log('  (no Connect account on test4: skipped)'); }
  else {
    const r3 = await send({ ...base, id: 'evt_tol_ref_' + run, type: 'charge.refunded', account: acct, data: { object: { id: 'ch_tol' + run, object: 'charge', amount: 1900, amount_refunded: 1900, payment_intent: 'pi_deleted_' + run, metadata: { tenant_id: test4.id } } } });
    check(r3.status === 200, 'charge.refunded for an order that no longer exists: 200, no error loop (' + JSON.stringify(r3.body) + ')');
    const again = await send({ ...base, id: 'evt_tol_ref_' + run, type: 'charge.refunded', account: acct, data: { object: { id: 'ch_tol' + run, object: 'charge', amount: 1900, amount_refunded: 1900, payment_intent: 'pi_deleted_' + run, metadata: { tenant_id: test4.id } } } });
    check(again.status === 200 && again.body?.skipped === 'already_processed', 'the same event again: deduplicated');
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
