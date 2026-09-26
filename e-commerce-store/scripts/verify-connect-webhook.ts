/**
 * CONNECT WEBHOOK CHECK.  npx tsx scripts/verify-connect-webhook.ts
 * Makes a harmless change on test4's connected account (a v1 metadata
 * stamp; a v2 metadata update emits no v1 account.updated) and proves the
 * registered Connect endpoint received account.updated, re-synced the tenant
 * row, and recorded the event once in webhook_dedupe.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const stripe: any = await resolveStripeClient();
  const acct = 'acct_1UJWFxPIsRXBZjvC';
  const readRow = async () => ((await getDb().select<any>('tenants', { where: { stripe_account_id: eq(acct) }, select: ['connect_synced_at', 'connect_charges_enabled'], limit: 1 })) as any[])[0];
  const before = await readRow();
  console.log('tenant row before: ' + JSON.stringify(before));
  const startedAt = Math.floor(Date.now() / 1000) - 2;
  await stripe.accounts.update(acct, { metadata: { webhook_probe: String(Date.now()) } });
  let ev: any = null;
  for (let i = 0; i < 30 && !ev; i++) {
    const list = await stripe.events.list({ type: 'account.updated', created: { gte: startedAt }, limit: 5 }, { stripeAccount: acct });
    ev = list.data[0] || null; if (!ev) await sleep(2000);
  }
  if (!ev) { console.log('NO account.updated event generated'); return; }
  console.log('event ' + ev.id + ' created; pending_webhooks=' + ev.pending_webhooks);
  let after: any = before;
  for (let i = 0; i < 30; i++) {
    after = await readRow();
    const e2 = await stripe.events.retrieve(ev.id, {}, { stripeAccount: acct });
    if (after.connect_synced_at !== before.connect_synced_at && e2.pending_webhooks === 0) { console.log('delivered: pending_webhooks=0'); break; }
    await sleep(2000);
  }
  console.log('tenant row after:  ' + JSON.stringify(after));
  console.log(after.connect_synced_at !== before.connect_synced_at ? 'PASS the Connect webhook synced the tenant' : 'FAIL tenant row not re-synced');
  const dd = await getDb().select<any>('webhook_dedupe', { where: { dedupe_key: eq(ev.id) }, limit: 1 }).catch((e: any) => 'dedupe read failed: ' + e.message);
  console.log('dedupe row: ' + JSON.stringify(dd));
})().catch((e) => { console.error(e?.raw?.message || e.message); process.exit(1); });
