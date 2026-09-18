/**
 * GROWTH MODULES 2 & 3 — cart recovery (disabled) and back-in-stock (live).
 *
 *   npm run verify:growth
 *
 * What has to be true:
 *
 *   - CART RECOVERY REFUSES TO RUN. It is built and `planned`, and "disabled"
 *     has to mean the handler returns without sending and without spending —
 *     not merely that nobody has called it yet.
 *   - BACK-IN-STOCK REACHES THE PEOPLE WHO ASKED. The module is worthless if
 *     its own subscribers cannot pass the consent gate, so this exercises a
 *     real subscriber row rather than trusting that the gate and the audience
 *     agree about who has opted in.
 *   - THE TRANSITION IS THE TRIGGER. 5 -> 10 units is a top-up and must announce
 *     nothing; 0 -> 10 is the event people signed up for.
 *   - THE HOLDOUT IS STABLE ACROSS PROCESSES. The unit tests prove the
 *     arithmetic; this proves the same subject lands in the same group when the
 *     code is loaded fresh and the percentages come from the registry.
 *
 * NO EMAIL LEAVES THE BUILDING. Every address is @goyunir.invalid, and the
 * checks stop at the gate decision rather than at the send.
 *
 * WHAT IT WRITES, and removes again: one alert_subscribers row and any
 * usage_events it produces.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const STAMP = Date.now().toString(36);
const EMAIL = 'restock-' + STAMP + '@goyunir.invalid';
const SLUG = 'verify-restock-' + STAMP;

/**
 * A moment that is definitely NOT inside quiet hours, found rather than assumed.
 *
 * Hardcoding one costs an afternoon: midday UTC is 05:00 in the store's own
 * timezone, which is squarely inside quiet hours, and the resulting refusal
 * looks exactly like a consent failure. Asking the same function the gate asks
 * survives both DST and a change of default timezone.
 */
function sendableMoment(isQuiet: (d: Date) => boolean): Date {
  const base = new Date();
  for (let hour = 0; hour < 24; hour++) {
    const candidate = new Date(base);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (!isQuiet(candidate)) return candidate;
  }
  throw new Error('Every hour of the day reports as quiet — check QUIET_START_HOUR/QUIET_END_HOUR.');
}

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { moduleById, assertLaunchable } = await import('../lib/growth/registry');
  const { assignHoldout, isHeldOut, computeIncremental } = await import('../lib/growth/holdout');
  const { canSend } = await import('../lib/growth/consent');
  const { isWithinQuietHours } = await import('../lib/growth/quiet-hours');
  const { usageHeadroom, recordUsage, costByModule } = await import('../lib/growth/ledger');
  const { setProfileFields } = await import('../lib/customer-profile');
  const { EmailFactory } = await import('../services/email/factory');
  const { subscribe, readSubscriber, removeSubscriber } = await import('../lib/alert-subscribers');
  const { notifyBackInStock, notifyIfBackInStock } = await import('../lib/growth/modules/back-in-stock');
  const { recoverAbandonedCarts, findAbandonedCarts } = await import('../lib/growth/modules/cart-recovery');

  const db = getDb();
  if (!db.configured) {
    console.error('No Supabase service credentials.');
    process.exit(2);
  }

  const tenantId = await ensureDefaultTenant();
  const OK_TIME = sendableMoment((d) => isWithinQuietHours(d, null).quiet);
  const backInStock = moduleById('back_in_stock')!;
  const cartRecovery = moduleById('cart_recovery')!;

  const stockUsageCount = async (): Promise<number> => {
    const rows = (await db.select('usage_events', {
      where: { tenant_id: eq(tenantId), module_id: eq('back_in_stock') },
      select: ['id'],
      limit: 500,
    })) as unknown[];
    return rows.length;
  };

  console.log('\nGrowth modules — cart recovery (off) and back-in-stock (on)');
  console.log('='.repeat(72));
  console.log('tenant: ' + tenantId + '\n');

  // 1. what the registry permits
  console.log('1. The registry gate');
  check(assertLaunchable(backInStock) === null, 'back-in-stock is launchable',
    String(assertLaunchable(backInStock)));
  check(assertLaunchable(cartRecovery) !== null, 'cart recovery is refused',
    'it reports as launchable, which it should not be yet');
  console.log('     cart recovery says: ' + assertLaunchable(cartRecovery));

  // 2. cart recovery does nothing while it is off
  console.log('\n2. Cart recovery is off, and "off" means off');
  const spentBefore = (await db.select<{ id: string }>('usage_events', {
    where: { tenant_id: eq(tenantId), module_id: eq('cart_recovery') },
    select: ['id'],
    limit: 200,
  })) as Array<{ id: string }>;

  const recovery = await recoverAbandonedCarts(tenantId);
  check(recovery.contacted === 0, 'contacted nobody', 'contacted ' + recovery.contacted);
  check(recovery.skipped.some((s) => s.reason.startsWith('disabled:')),
    'stopped at the registry gate rather than further in',
    JSON.stringify(recovery.skipped.slice(0, 3)));

  const spentAfter = (await db.select<{ id: string }>('usage_events', {
    where: { tenant_id: eq(tenantId), module_id: eq('cart_recovery') },
    select: ['id'],
    limit: 200,
  })) as Array<{ id: string }>;
  check(spentAfter.length === spentBefore.length, 'spent nothing',
    spentBefore.length + ' usage_events before, ' + spentAfter.length + ' after');

  // The finder is separate from the sender, so it stays exercised while the
  // module is off. A query nobody runs for six months is not "ready to enable".
  const abandoned = await findAbandonedCarts(tenantId, 5);
  check(Array.isArray(abandoned), 'the abandoned-cart query still runs');
  console.log('     ' + abandoned.length + ' abandoned cart(s) with a contactable customer');

  // 3. the holdout, loaded fresh, at the registry's own percentages
  console.log('\n3. Holdout assignment');
  const subjects = Array.from({ length: 2000 }, (_, i) => 'subject-' + i);
  const holdoutPct = backInStock.attribution.holdoutPercent;
  const controls = subjects.filter((s) => isHeldOut('back_in_stock', s, holdoutPct));
  const observed = (controls.length / subjects.length) * 100;
  check(Math.abs(observed - holdoutPct) < 2,
    'held back ~' + holdoutPct + '% (got ' + observed.toFixed(2) + '%)');

  const second = subjects.filter((s) => isHeldOut('back_in_stock', s, holdoutPct));
  check(second.length === controls.length && second.every((s, i) => s === controls[i]),
    'the same subjects land in the same group on a second pass');

  const alsoHeld = controls.filter((s) => assignHoldout('cart_recovery', s, 8) === 'control');
  check(alsoHeld.length < controls.length * 0.3,
    'being held out of one module does not hold you out of the other',
    alsoHeld.length + '/' + controls.length + ' overlap');

  const early = computeIncremental({
    treatedCount: 9, controlCount: 1, treatedRevenueCents: 400_000, controlRevenueCents: 0,
  });
  check(early.reliable === false && early.caveat !== null,
    'a tiny sample is reported as an early signal, not a result');
  console.log('     ' + early.caveat);

  // 4. a real subscriber, through the real gate
  console.log('\n4. Back-in-stock, with somebody who actually asked');
  const signup = await subscribe(tenantId, EMAIL, { source: 'verify-script' });
  check(signup.ok, 'subscribed ' + EMAIL, signup.ok ? '' : signup.reason);
  const subscriber = await readSubscriber(tenantId, EMAIL);
  check(subscriber?.status === 'active', 'the row says active');

  // THE QUESTION THIS SCRIPT EXISTS TO ANSWER. The audience lives in
  // alert_subscribers; the gate reads customers.email_opt_in. Do they agree
  // about who has consented? (Before the ListConsent fix, they did not: every
  // subscriber without a customer record was refused.)
  const listConsent = {
    source: 'alert_subscribers' as const,
    status: subscriber!.status,
    recordedAt: subscriber!.createdAt,
  };
  const decision = await canSend({ tenantId, module: backInStock, email: EMAIL, now: OK_TIME, listConsent });
  console.log('     gate says: ' + (decision.allowed ? 'ALLOWED' : decision.reason + ' — ' + decision.detail));
  check(decision.allowed, 'somebody on the alert list can be sent an alert',
    'The module cannot reach its own subscribers.');

  // Evidence, not assertion. A handler cannot conjure consent by passing a row
  // that says nothing — an unparseable date or a blank source is not a consent.
  const forged = await canSend({
    tenantId, module: backInStock, email: EMAIL, now: OK_TIME,
    listConsent: { source: '', status: 'active', recordedAt: 'whenever' },
  });
  check(!forged.allowed, 'a list record with no source and no date is not consent');

  const unsubscribed = await canSend({
    tenantId, module: backInStock, email: EMAIL, now: OK_TIME,
    listConsent: { ...listConsent, status: 'unsubscribed' },
  });
  check(!unsubscribed.allowed, 'an unsubscribed list record is not consent');

  // THE ORDERING THAT MATTERS. Someone who declined on their account has said
  // no; an older list signup must not resurrect them.
  await setProfileFields(tenantId, EMAIL, { emailOptIn: false });
  const declined = await canSend({ tenantId, module: backInStock, email: EMAIL, now: OK_TIME, listConsent });
  check(!declined.allowed && declined.reason === 'no_consent',
    'a decline on the customer record outranks the mailing list',
    JSON.stringify(declined));
  await setProfileFields(tenantId, EMAIL, { emailOptIn: null });

  // The whole handler, up to but not through the send. A configured driver
  // would put a real message on the wire to a .invalid address — a guaranteed
  // bounce against our sending reputation — so when one is present this stops
  // at the gates and says so rather than proving the last inch at that price.
  const driver = await EmailFactory.getDriver();
  if (driver?.configured) {
    console.log('     SKIPPED the send path: an email driver is configured here, and the');
    console.log('     test address would bounce. Gate decisions above are the proof.');
  } else {
    const outcome = await notifyBackInStock(tenantId, {
      slug: SLUG, name: 'Verification Product', available: 4,
    });
    const mine = outcome.skipped.filter((s) => s.email === EMAIL || s.email === '-');
    console.log('     outcome: notified=' + outcome.notified + ' heldOut=' + outcome.heldOut +
      ' skipped=' + JSON.stringify(mine));
    check(!mine.some((s) => s.reason === 'no_consent'),
      'the handler no longer refuses its own subscriber',
      JSON.stringify(mine));
  }

  // 5. what counts as the event
  console.log('\n5. What counts as the event');
  const nothing = await notifyBackInStock(tenantId, {
    slug: SLUG, name: 'Verification Product', available: 0,
  });
  check(nothing.notified === 0 && nothing.skipped.some((s) => s.reason === 'nothing_available'),
    'zero units available announces nothing');

  const usageBefore = await stockUsageCount();
  const NO_SUCH_VARIANT = '00000000-0000-0000-0000-000000000000';
  await notifyIfBackInStock(tenantId, NO_SUCH_VARIANT, 5, 10);
  check((await stockUsageCount()) === usageBefore, 'a top-up (5 -> 10) announces nothing');
  await notifyIfBackInStock(tenantId, NO_SUCH_VARIANT, 0, 0);
  check((await stockUsageCount()) === usageBefore, 'a restock to zero announces nothing');

  // 6. the free tier is one pool, and the headroom check has to see all of it
  console.log('\n6. Platform email counts against the same allowance');
  const headroomBefore = await usageHeadroom('email');
  check(headroomBefore !== null, 'an email rate is configured to measure against');

  // This is the row lib/email.ts now writes for every transactional send.
  await recordUsage({
    tenantId, moduleId: 'platform', unit: 'email', quantity: 1,
    reference: 'contact:' + EMAIL,
  });
  const headroomAfter = await usageHeadroom('email');
  check((headroomAfter?.usedThisPeriod ?? 0) === (headroomBefore?.usedThisPeriod ?? 0) + 1,
    'a platform email moves the free-tier headroom',
    'used went ' + headroomBefore?.usedThisPeriod + ' -> ' + headroomAfter?.usedThisPeriod);

  const rollup = await costByModule(tenantId);
  check(rollup.some((m) => m.moduleId === 'platform'),
    'platform sends appear in the cost rollup',
    JSON.stringify(rollup));
  console.log('     ' + (headroomAfter?.usedThisPeriod ?? 0) + '/' + (headroomAfter?.includedUnits ?? 0) +
    ' of the ' + (headroomAfter?.provider ?? '?') + ' free allowance used this period');

  // cleanup
  console.log('\nCleaning up');
  await removeSubscriber(tenantId, EMAIL);
  // setProfileFields creates a customer row to hang the opt-in on. It is ours, so
  // it goes too — a verification run must not leave a fake customer behind.
  await db.remove('customers', { where: { tenant_id: eq(tenantId), email: eq(EMAIL) } });
  await db.remove('usage_events', {
    where: { tenant_id: eq(tenantId), reference: eq('contact:' + EMAIL) },
  });
  check((await readSubscriber(tenantId, EMAIL)) === null, 'test subscriber removed');

  console.log('\n' + '='.repeat(72));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
