/**
 * RAFFLE DRAW DRY RUN — real Stripe test mode, fake database (Phase D4.2).
 *
 *   npm run dryrun:raffle
 *
 * Static equivalence proves the migrated lib/raffle.ts SENDS the same database
 * requests. It cannot prove the draw still behaves correctly end to end, and
 * executeDrawWithCharging decides who gets charged real money.
 *
 * Real: the Stripe customer, payment method, PaymentIntent, charge, refund —
 * all TEST MODE. Faked: Postgres, via a local server answering PostgREST-shaped
 * requests, so nothing is written to any real database.
 *
 * Refuses to run unless STRIPE_SECRET_KEY is sk_test_, and cleans up every
 * Stripe object it creates.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// .env.local loader — Next.js auto-loads this, a bare tsx process does not.
// Same loader as scripts/production-readiness-check.ts (repo convention).
function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

const TENANT = 'dryrun-tenant';
const VARIANT = 'dryrun-variant';
const PRICE_CENTS = 1234;
// Unique per RUN so a previous run's idempotency key cannot collide with this
// one's (Stripe rejects a reused key carrying different parameters). Constant
// WITHIN a run, so the replay below still reuses the same key on purpose.
const RUN_ID = 'dryrun-draw-' + Date.now().toString(36);

interface Recorded { method: string; url: string; body: unknown }
const recorded: Recorded[] = [];

function log(ok: boolean, name: string, detail = ''): number {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '\n     ' + detail : ''));
  return ok ? 0 : 1;
}

/** A fake PostgREST seeded with one pending entry pointing at real Stripe ids. */
function fakeDb(customerId: string, pmId: string, record: boolean): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (record) {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        recorded.push({ method: req.method || '', url: req.url || '', body });
      }
      const table = (req.url || '').split('/rest/v1/')[1]?.split('?')[0];
      let payload = '[]';
      if (req.method === 'GET' && table === 'raffle_entries') {
        payload = JSON.stringify([{
          id: 'dryrun-entry-1',
          email: 'dryrun-winner@example.com',
          status: 'pending',
          customer_id: customerId,
          payment_method_ref: pmId,
          discount_percent: null,
          shipping_address: null,
        }]);
      } else if (req.method === 'GET' && table === 'product_variants') {
        payload = JSON.stringify([{ option_label: 'Standard', price_cents: PRICE_CENTS, products: { name: 'Dry Run Item' } }]);
      } else if (req.method === 'POST' && table === 'drop_draws') {
        payload = JSON.stringify([{ id: RUN_ID }]);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}

function pointAtDb(port: number): void {
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:' + port;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dryrun-service-key';
}

async function main() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key.startsWith('sk_test_')) {
    console.error('REFUSING TO RUN: STRIPE_SECRET_KEY must be a TEST-MODE key (sk_test_...).');
    console.error('This creates real PaymentIntents; against a live key that is real money.');
    process.exit(2);
  }

  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe = await resolveStripeClient();
  if (!stripe) { console.error('No Stripe client resolved.'); process.exit(2); }

  console.log('\nRaffle draw dry run - real Stripe test mode, fake database');
  console.log('='.repeat(62));

  // 1. Seed real Stripe test objects.
  const customer = await stripe.customers.create({ email: 'dryrun-winner@example.com', description: 'raffle dry run' });
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  console.log('seeded: customer ' + customer.id + ', payment method ' + pm.id);

  // 2. First draw.
  const db1 = fakeDb(customer.id, pm.id, true);
  pointAtDb(await listen(db1));
  const { executeDrawWithCharging } = await import('../lib/raffle');
  const before = await stripe.paymentIntents.list({ customer: customer.id, limit: 100 });
  const result = await executeDrawWithCharging(TENANT, VARIANT, 1);
  const after = await stripe.paymentIntents.list({ customer: customer.id, limit: 100 });
  db1.close();

  const created = after.data.filter((pi) => !before.data.some((b) => b.id === pi.id));
  const pi = created[0];
  let fail = 0;
  console.log('');
  fail += log(created.length === 1, 'exactly one PaymentIntent created', created.map((p) => p.id + ' ' + p.status + ' ' + p.amount).join(', ') || 'none');
  fail += log(Boolean(pi) && pi.amount === PRICE_CENTS, 'charged the variant price', pi ? String(pi.amount) : '-');
  fail += log(Boolean(pi) && pi.status === 'succeeded', 'charge succeeded off_session', pi ? pi.status : '-');
  fail += log(result.charges?.length === 1 && result.charges[0].status === 'charged', 'draw reported winner as charged', JSON.stringify(result.charges));
  fail += log(
    recorded.some((r) => r.method === 'PATCH' && r.url.includes('raffle_entries') && JSON.stringify(r.body).includes('charged')),
    'entry status written back as charged',
  );

  // 3. Replay the SAME draw id against real Stripe - the idempotency test.
  const db2 = fakeDb(customer.id, pm.id, false);
  pointAtDb(await listen(db2));
  await executeDrawWithCharging(TENANT, VARIANT, 1);
  const afterReplay = await stripe.paymentIntents.list({ customer: customer.id, limit: 100 });
  db2.close();
  const extra = afterReplay.data.filter((x) => !after.data.some((b) => b.id === x.id));
  fail += log(extra.length === 0, 'REPLAY charged nothing extra (idempotency key held)', extra.length + ' new intent(s)');

  // 4. Clean up every real object created.
  let cleaned = 0;
  for (const p of [...created, ...extra]) {
    try {
      if (p.status === 'succeeded') { await stripe.refunds.create({ payment_intent: p.id }); cleaned++; }
      else { await stripe.paymentIntents.cancel(p.id); cleaned++; }
    } catch { /* already terminal */ }
  }
  try { await stripe.paymentMethods.detach(pm.id); } catch { /* ignore */ }
  try { await stripe.customers.del(customer.id); } catch { /* ignore */ }
  console.log('\ncleanup: ' + cleaned + ' intent(s) refunded/cancelled, payment method detached, customer deleted.');

  console.log('='.repeat(62));
  console.log(fail === 0 ? 'RAFFLE DRY RUN PASSED\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('dry run crashed:', err); process.exit(1); });
