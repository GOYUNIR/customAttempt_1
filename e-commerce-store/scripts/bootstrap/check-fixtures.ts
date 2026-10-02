/**
 * PROOF FIXTURES PRESENT? The release gate's proofs run against fixed stores
 * (scripts/verify-*.ts). On a fresh install they are recreated with the SAME
 * ids by tenant-transfer.ts (bootstrap-out/transfer/*.json from the old
 * install), so the proofs run unchanged (BOOTSTRAP-RUNBOOK.md, "Proof
 * fixtures"). This checks they are there and usable:
 *   - the Connect fixture (test4) exists, has an owner, and is connected to
 *     THIS install's Stripe (test mode) with charges enabled;
 *   - store B (goyunir-test-1) exists;
 *   - the demo store exists with live products (storefront proofs).
 *
 *   npx tsx scripts/bootstrap/check-fixtures.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

export const FIXTURES = {
  connect: { id: '13591c9e-82e4-4c23-8d94-249cef6fa775', slug: 'test4' },
  storeB: { id: 'ff8d5e59-1a07-4e83-bc13-f949c745d9de', slug: 'goyunir-test-1' },
  demo: { id: '3b6f7db1-7645-4c52-aefe-cc8be563c359', slug: 'demo' },
};

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { getDb } = await import('../../lib/db/client');
  const { eq } = await import('../../lib/db/query');
  const db = getDb();
  const tenant = async (id: string) => ((await db.select<any>('tenants', { where: { id: eq(id) }, select: ['id', 'slug', 'license_status', 'stripe_account_id', 'connect_charges_enabled'], limit: 1 })) as any[])[0];
  console.log('Proof fixtures');
  const a = await tenant(FIXTURES.connect.id);
  check(Boolean(a) && a.slug === FIXTURES.connect.slug && a.license_status === 'active', 'the Connect fixture store exists (' + FIXTURES.connect.slug + ')');
  const owner = a ? ((await db.select<any>('users', { where: { tenant_id: eq(a.id), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0] : null;
  check(Boolean(owner), 'it has an owner account (invite one to it if not: the isolation proof makes store B\'s itself)');
  check(Boolean(a?.stripe_account_id) && a?.connect_charges_enabled === true, 'it is connected to this install\'s Stripe with charges on (one manual onboarding in test mode: BOOTSTRAP-RUNBOOK "Proof fixtures")');
  if (a?.stripe_account_id) {
    const { resolveStripeClient } = await import('../../services/payment/factory');
    const stripe: any = await resolveStripeClient();
    const acct = stripe ? await stripe.v2.core.accounts.retrieve(a.stripe_account_id).catch(() => null) : null;
    check(Boolean(acct), 'that connected account belongs to THIS install\'s Stripe platform (the old platform\'s accounts do not travel)');
  }
  const b = await tenant(FIXTURES.storeB.id);
  check(Boolean(b) && b.slug === FIXTURES.storeB.slug, 'store B exists (' + FIXTURES.storeB.slug + ')');
  const d = await tenant(FIXTURES.demo.id);
  const demoLive = d ? ((await db.select<any>('products', { where: { tenant_id: eq(d.id), is_active: eq(true) }, select: ['id'], limit: 5 })) as any[]).length : 0;
  check(Boolean(d) && demoLive > 0, 'the demo store exists with live products (' + demoLive + ')');
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(String((e as Error)?.message || e)); process.exit(1); });
