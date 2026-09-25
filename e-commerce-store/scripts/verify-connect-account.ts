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
  // Test data: the test merchant is placed in the platform account's own
  // country (read from Stripe, not assumed). A real merchant states theirs.
  const platform = await stripe.accounts.retrieve();
  const country = String(platform.country || '');
  console.log('platform ' + platform.id + ' country=' + country);
  const results = await Promise.allSettled([
    ensureConnectedAccount(TENANT, 'merchant-test4@example.com', country),
    ensureConnectedAccount(TENANT, 'merchant-test4@example.com', country),
  ]);
  for (const r of results) console.log(r.status === 'fulfilled' ? 'call -> ' + r.value : 'call FAILED -> ' + (r.reason?.raw?.message || r.reason?.message || r.reason));
  const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r: any) => r.value));
  const bothOk = results.every((r) => r.status === 'fulfilled');
  console.log(bothOk && ids.size === 1 ? 'PASS both concurrent calls -> the SAME one account' : '*** FAIL: ' + results.filter((r) => r.status === 'rejected').length + ' call(s) failed, ' + ids.size + ' distinct account(s) ***');
  const acct = [...ids][0];
  if (acct) {
    const a = await stripe.v2.core.accounts.retrieve(acct, { include: ['configuration.merchant', 'requirements', 'defaults'] });
    console.log('dashboard=' + a.dashboard + '  responsibilities=' + JSON.stringify(a.defaults?.responsibilities) + '  card_payments=' + a.configuration?.merchant?.capabilities?.card_payments?.status);
    console.log('requirements entries: ' + (a.requirements?.entries?.length ?? '?') + '  first: ' + JSON.stringify((a.requirements?.entries || []).slice(0, 3).map((e: any) => e.description || e.id || e)).slice(0, 400));
  }
  console.log('route after: ' + JSON.stringify(await chargeRouteForTenant(TENANT)));
})().catch((e) => { console.error(e?.raw?.message || e.message || e); process.exit(1); });
