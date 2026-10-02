/**
 * STRIPE TEST-MODE CLEANUP (part of the launch reset). DRY RUN unless --apply.
 * Refuses to run with a live key.
 *
 *   npx tsx scripts/stripe-test-cleanup.ts [--apply]
 *
 * Deletes, in TEST MODE only:
 *   - connected accounts no store owns (tenants.stripe_account_id);
 *   - customers on proof/test email domains, on the platform account and on
 *     every kept store's connected account.
 * Keeps: the kept stores' connected accounts; any customer on a real address.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
const APPLY = process.argv.includes('--apply');
const PROOF_EMAIL = /@([a-z0-9-]+\.)*(invalid|test|example|localhost)$|@(example\.(com|net|org)|resend\.dev)$|@proof\.[a-z0-9.-]+$/i;

(async () => {
  const { resolveStripeClient, stripeIsTestMode } = await import('../services/payment/factory');
  if (!(await stripeIsTestMode())) { console.error('REFUSED: the Stripe key is not a test key.'); process.exit(2); }
  const stripe: any = await resolveStripeClient();
  const { getDb } = await import('../lib/db/client');
  const owned = new Set(((await getDb().select<any>('tenants', { select: ['stripe_account_id'] })) as any[]).map((t) => t.stripe_account_id).filter(Boolean));
  console.log('STRIPE TEST CLEANUP ' + (APPLY ? 'APPLY' : 'DRY RUN') + '  (kept stores own ' + owned.size + ' connected account(s))');

  const accounts: any[] = [];
  for await (const a of stripe.accounts.list({ limit: 100 })) accounts.push(a);
  const orphanAccounts = accounts.filter((a) => !owned.has(a.id));
  console.log('  connected accounts: ' + accounts.length + ', not owned by any store: ' + orphanAccounts.length);

  const scopes: Array<{ label: string; opts: any }> = [{ label: 'platform', opts: {} }, ...[...owned].map((id) => ({ label: id, opts: { stripeAccount: id } }))];
  const customers: Array<{ id: string; scope: any; label: string }> = [];
  for (const s of scopes) {
    let n = 0;
    for await (const c of stripe.customers.list({ limit: 100 }, s.opts)) { n++; if (PROOF_EMAIL.test(String(c.email || ''))) customers.push({ id: c.id, scope: s.opts, label: s.label }); }
    console.log('  customers on ' + s.label + ': ' + n + ', on proof addresses: ' + customers.filter((c) => c.label === s.label).length);
  }
  if (!APPLY) { console.log('\nDRY RUN: nothing changed. Re-run with --apply.'); return; }

  let a = 0, c = 0;
  for (const acc of orphanAccounts) {
    try { await stripe.accounts.del(acc.id); a++; }
    catch (e) {
      // Accounts v2 (with customer/merchant configurations) are CLOSED, not deleted.
      if (!/v2\/core\/accounts\/:id\/close/.test((e as Error).message)) { console.error('  could not delete ' + acc.id + ': ' + (e as Error).message); continue; }
      try {
        const v2: any = await stripe.rawRequest('GET', '/v2/core/accounts/' + acc.id, {});
        const applied = (v2?.applied_configurations || []) as string[];
        await stripe.rawRequest('POST', '/v2/core/accounts/' + acc.id + '/close', { applied_configurations: applied });
        a++;
      }
      catch (e2) { console.error('  could not close v2 account ' + acc.id + ': ' + (e2 as Error).message); }
    }
  }
  for (const cu of customers) { try { await stripe.customers.del(cu.id, {}, cu.scope); c++; } catch (e) { console.error('  could not delete customer ' + cu.id + ': ' + (e as Error).message); } }
  console.log('\nDeleted ' + a + ' connected account(s) and ' + c + ' customer(s).');
})().catch((e) => { console.error(e); process.exit(1); });
