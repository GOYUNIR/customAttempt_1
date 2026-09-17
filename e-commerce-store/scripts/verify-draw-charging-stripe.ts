/**
 * STRIPE TEST-MODE DRY RUN for executeDrawWithCharging  (H6, item 4).
 *
 *   npm run verify:draw-charging
 *
 * Item 4 would make executeDrawWithCharging the decision authority for who
 * gets charged, so it is proven with REAL Stripe test-mode calls rather than
 * mocks — the same standard as the raffle checkpoint.
 *
 * It reproduces entries EXACTLY as production creates them, by calling the
 * same ensureCustomer + createRaffleEntry({ customerId }) pair the Stripe
 * webhook calls — not a hand-assembled approximation.
 *
 * The first version of this harness caught why the path was broken: the
 * webhook never passed customerId, so customer_id was always NULL and the
 * guard `if (!stripe || !customerId || !paymentMethodId)` declined every
 * winner (0 of 3 charged, 0 PaymentIntents created). It deliberately did NOT
 * hand-fill a Stripe id, because production never had one — doing so would
 * have proven the code works on inputs it never receives, which is exactly
 * how the bug stayed invisible.
 *
 * SAFETY: refuses to run against a live key; settles every PaymentIntent it
 * creates and deletes every row it writes.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    // .env.local quotes some values; a quoted key fails Stripe auth with an
    // error that looks nothing like "there are quotes in your env file".
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();
process.env.USE_POSTGRES_PRIMARY = 'true';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

async function main() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key.startsWith('sk_test')) {
    console.error('\nREFUSING TO RUN: STRIPE_SECRET_KEY is not a test key (' + (key.slice(0, 7) || 'unset') + ').\n');
    process.exit(2);
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(key, { apiVersion: '2025-08-27.basil' as never });

  const { createRaffleEntry, executeDrawWithCharging } = await import('../lib/raffle');
  const { ensureCustomer, stripeCustomerIdFor } = await import('../lib/customers');
  const { getDb } = await import('../lib/db/client');
  const { eq, inList } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');

  const db = getDb();
  const tenantId = await ensureDefaultTenant();

  console.log('\nexecuteDrawWithCharging — REAL Stripe test mode\n' + '='.repeat(68));
  console.log('     stripe key: ' + key.slice(0, 11) + '…  (test mode confirmed)');

  const variants = (await db.select<{ id: string; option_label: string; price_cents: number }>('product_variants', {
    select: ['id', 'option_label', 'price_cents'], limit: 5,
  })) as Array<{ id: string; option_label: string; price_cents: number }>;
  const variant = variants.find((v) => Number(v.price_cents) > 0) || variants[0];
  if (!variant) { console.error('No product_variants to test against.'); process.exit(2); }
  const basePriceCents = Number(variant.price_cents) || 0;
  console.log('     variant: ' + variant.option_label + '  $' + (basePriceCents / 100).toFixed(2));

  const tag = '__drawprobe__' + randomUUID().slice(0, 8);
  const emails: string[] = [];
  const createdCustomers: string[] = [];
  const createdIntents: string[] = [];
  const customerUuids: string[] = [];
  let drawId = '';

  // A real, chargeable test payment method, attached to a real test customer.
  const customer = await stripe.customers.create({ description: tag });
  createdCustomers.push(customer.id);
  await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  console.log('     a REAL chargeable test customer exists: ' + customer.id + ' + pm_card_visa');

  try {
    // ── Entries exactly as the webhook now creates them ────────────────────
    // ensureCustomer + createRaffleEntry({ customerId }) is verbatim what
    // app/api/stripe/webhook does, so this exercises the real flow rather
    // than a hand-assembled approximation of it.
    for (const label of ['a', 'b', 'c']) {
      const email = `${tag}-${label}@example.invalid`;
      emails.push(email);
      const customerUuid = await ensureCustomer(tenantId, email, customer.id);
      check(Boolean(customerUuid), 'customer record created/linked for ' + label, String(customerUuid));
      if (customerUuid) customerUuids.push(customerUuid);
      const resolved = customerUuid ? await stripeCustomerIdFor(tenantId, customerUuid) : null;
      check(resolved === customer.id, 'and it resolves back to the Stripe customer for ' + label, String(resolved));
      const r = await createRaffleEntry({
        tenantId,
        variantId: variant.id,
        customerId: customerUuid,
        email,
        paymentMethodRef: 'pm_card_visa',
      });
      check(r.ok === true, 'entry created for ' + label, JSON.stringify(r));
    }

    // Linking is idempotent: a second call for the same email must reuse the
    // row, not create a second identity for the same person.
    const relinked = await ensureCustomer(tenantId, emails[0], customer.id);
    check(relinked === customerUuids[0], 'ensureCustomer is idempotent — same person, same customer row', relinked + ' vs ' + customerUuids[0]);

    const stored = (await db.select<{ email: string; customer_id: string | null; payment_method_ref: string | null }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), email: inList(emails) },
      select: ['email', 'customer_id', 'payment_method_ref'],
    })) as Array<{ email: string; customer_id: string | null; payment_method_ref: string | null }>;
    console.log('\n     as stored in production shape:');
    for (const r of stored) console.log('       ' + String(r.email).padEnd(44) + 'customer_id=' + r.customer_id + '  payment_method_ref=' + r.payment_method_ref);
    check(stored.every((r) => r.customer_id !== null), 'every entry now carries a customer_id FK', JSON.stringify(stored.map((r) => r.customer_id)));

    // ── Count Stripe activity before, so we can prove what the draw did ────
    const before = (await stripe.paymentIntents.list({ limit: 100 })).data.length;

    // ── The real charging draw ─────────────────────────────────────────────
    const result = await executeDrawWithCharging(tenantId, variant.id, 3);
    drawId = result.draw.drawId;
    console.log('\n     draw ' + drawId + ' selected ' + result.draw.winnerCount + ' winner(s)');
    for (const c of result.charges) {
      console.log('       ' + String(c.email).padEnd(44) + c.status + (c.error ? '  (' + String(c.error).slice(0, 48) + ')' : ''));
    }

    const after = (await stripe.paymentIntents.list({ limit: 100 })).data;
    const mine = after.filter((pi) => createdCustomers.includes(String(pi.customer || '')));
    for (const pi of mine) createdIntents.push(pi.id);

    const charged = result.charges.filter((c) => c.status === 'charged').length;
    const declined = result.charges.filter((c) => c.status === 'declined').length;
    console.log('\n     charged=' + charged + '  declined=' + declined);
    console.log('     PaymentIntents created for this run: ' + mine.length);
    console.log('     (total test-mode intents before=' + before + ' after=' + after.length + ')');

    // THE POINT OF THE DRY RUN. These are the assertions item 4 has to pass
    // before it can become the charging authority.
    check(charged === result.draw.winnerCount,
      'EVERY selected winner was actually CHARGED',
      'winners=' + result.draw.winnerCount + ' charged=' + charged);
    check(mine.length === charged,
      'Stripe holds one real PaymentIntent per charged winner',
      'stripe=' + mine.length + ' charged=' + charged);
    check(!result.charges.some((c) => c.error === 'no_payment_method'),
      'no winner was declined for a missing payment method',
      JSON.stringify(result.charges.map((c) => c.error).filter(Boolean)));
  } finally {
    console.log('\n     cleaning up…');
    for (const id of [...new Set(createdIntents)]) {
      try {
        const pi = await stripe.paymentIntents.retrieve(id);
        if (pi.status === 'succeeded') { await stripe.refunds.create({ payment_intent: id }); console.log('       refunded ' + id); }
        else if (pi.status !== 'canceled') { await stripe.paymentIntents.cancel(id); console.log('       cancelled ' + id); }
      } catch (e) { console.log('       could not settle ' + id + ': ' + (e as Error).message.slice(0, 60)); }
    }
    for (const c of createdCustomers) { try { await stripe.customers.del(c); } catch { /* ignore */ } }
    try { await db.remove('raffle_entries', { where: { tenant_id: eq(tenantId), email: inList(emails) } }); } catch { /* ignore */ }
    try { await db.remove('customers', { where: { tenant_id: eq(tenantId), email: inList(emails) } }); } catch { /* ignore */ }
    if (drawId) { try { await db.remove('drop_draws', { where: { id: eq(drawId) } }); } catch { /* ignore */ } }
    const leftover = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), email: inList(emails) }, select: ['id'],
    }).catch(() => [])) as Array<{ id: string }>;
    check(leftover.length === 0, 'all probe rows removed from production', String(leftover.length));
  }

  console.log('='.repeat(68));
  console.log(fail === 0 ? 'DRAW CHARGING VERIFIED against real Stripe test mode\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', (e as Error).message); process.exit(1); });
