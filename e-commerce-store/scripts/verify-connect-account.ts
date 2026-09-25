/**
 * CONNECT ACCOUNT CREATION CHECK (CONNECT.md §7 step 1).  npx tsx scripts/verify-connect-account.ts
 * Two concurrent ensureConnectedAccount calls for the test tenant `test4` must
 * produce exactly ONE connected account, stored once, with the fixed
 * responsibilities. Creates a real TEST-MODE connected account on first run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const TENANT = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
(async () => {
  const { ensureConnectedAccount, chargeRouteForTenant } = await import('../lib/connect');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe: any = await resolveStripeClient();
  console.log('route before: ' + JSON.stringify(await chargeRouteForTenant(TENANT)));
  const results = await Promise.allSettled([
    ensureConnectedAccount(TENANT, 'merchant-test4@example.com'),
    ensureConnectedAccount(TENANT, 'merchant-test4@example.com'),
  ]);
  for (const r of results) console.log(r.status === 'fulfilled' ? 'call -> ' + r.value : 'call FAILED -> ' + (r.reason?.raw?.message || r.reason?.message || r.reason));
  const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r: any) => r.value));
  console.log(ids.size === 1 ? 'PASS two concurrent calls -> ONE account' : '*** ' + ids.size + ' distinct accounts ***');
  const acct = [...ids][0];
  if (acct) {
    const a = await stripe.v2.core.accounts.retrieve(acct, { include: ['configuration.merchant', 'requirements', 'defaults'] });
    console.log('dashboard=' + a.dashboard + '  responsibilities=' + JSON.stringify(a.defaults?.responsibilities) + '  card_payments=' + a.configuration?.merchant?.capabilities?.card_payments?.status);
    console.log('requirements entries: ' + (a.requirements?.entries?.length ?? '?') + '  first: ' + JSON.stringify((a.requirements?.entries || []).slice(0, 3).map((e: any) => e.description || e.id || e)).slice(0, 400));
  }
  console.log('route after: ' + JSON.stringify(await chargeRouteForTenant(TENANT)));
})().catch((e) => { console.error(e?.raw?.message || e.message || e); process.exit(1); });
