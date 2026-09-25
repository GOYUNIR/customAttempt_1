/**
 * A fresh Stripe-hosted onboarding link for a tenant's connected account.
 *
 *   npx tsx scripts/connect-onboarding-link.ts [tenantId]      (default: test4)
 *
 * The link works ONCE and expires within minutes, so it's printed on demand
 * and opened straight away. Stripe's page is protected by hCaptcha, so a human
 * completes it; in test mode use Stripe's test values (docs.stripe.com/
 * connect/testing): phone 000 000 0000 with SMS code 000000, date of birth
 * 01/01/1901, SSN last 4 0000, address line 1 "address_full_match", and the
 * test bank account (routing 110000000, account 000123456789).
 *
 * Afterwards it prints what Stripe now reports and syncs the tenant row
 * (the same syncConnectedAccount the account.updated webhook will call).
 * Run it again with --sync to re-check without a new link.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }

const args = process.argv.slice(2);
const TENANT = args.find((a) => !a.startsWith('--')) || '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const SYNC_ONLY = args.includes('--sync');

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { syncConnectedAccount, chargeRouteForTenant } = await import('../lib/connect');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const row = ((await getDb().select<any>('tenants', { where: { id: eq(TENANT) }, select: ['id', 'name', 'stripe_account_id'], limit: 1 })) as any[])[0];
  if (!row?.stripe_account_id) throw new Error('tenant ' + TENANT + ' has no connected account yet (run verify-connect-account.ts)');
  const account = String(row.stripe_account_id);

  if (!SYNC_ONLY) {
    const stripe: any = await resolveStripeClient();
    // The platform's own domain, from the setting middleware uses (set on the
    // worker; locally, pass it: PLATFORM_ROOT_DOMAIN=<domain> npx tsx ...).
    // Stripe only redirects there afterwards; nothing is read from it.
    const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!root) throw new Error('PLATFORM_ROOT_DOMAIN is not set: run as  PLATFORM_ROOT_DOMAIN=<your platform domain> npx tsx scripts/connect-onboarding-link.ts');
    const base = 'https://' + root;
    const link = await stripe.v2.core.accountLinks.create({
      account,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: base + '/platform?connect=refresh',
          return_url: base + '/platform?connect=return',
        },
      },
    });
    console.log('\nOnboarding link for ' + row.name + ' (' + account + '), single use, open it now:\n\n  ' + link.url + '\n');
    console.log('When Stripe sends you back, run:  npx tsx scripts/connect-onboarding-link.ts ' + TENANT + ' --sync\n');
    return;
  }

  const synced = await syncConnectedAccount(account);
  console.log('synced: ' + JSON.stringify(synced));
  console.log('route:  ' + JSON.stringify(await chargeRouteForTenant(TENANT)));
})().catch((e) => { console.error(e?.raw?.message || e.message || e); process.exit(1); });
