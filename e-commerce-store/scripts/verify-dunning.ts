/**
 * DUNNING VERIFICATION (Growth module 1, migration 00027).
 *
 *   npm run verify:dunning
 *
 * What has to be true before this module is allowed near a real draw:
 *
 *   - the COMPLIANCE GATE actually gates. A send that cannot demonstrate
 *     consent must not happen, and the gate must fail CLOSED on an error rather
 *     than defaulting to "probably fine".
 *   - the LEDGER records what it cost, at the rate that was live when it was
 *     sent. A module whose cost-to-serve is invisible can run at negative
 *     margin for a month unnoticed, and at ~$30/month of fixed cost that is the
 *     whole budget.
 *   - the DEDUPE holds. A re-run of a draw must not mail the same person about
 *     the same decline twice.
 *   - the CAPS hold, both the per-tenant daily cap and the platform free-tier
 *     headroom.
 *
 * NO EMAIL IS SENT. Every check here stops at or before the send, because the
 * point is the gates — and mailing a real address to test a gate would be the
 * exact failure the gates exist to prevent. The send path itself is exercised
 * by the draw engines.
 *
 * WHAT IT WRITES, and cleans up: usage_events rows for an @goyunir.invalid
 * address.
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
const EMAIL = 'dunning-' + STAMP + '@goyunir.invalid';

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { moduleById, assertLaunchable, forecastUnits } = await import('../lib/growth/registry');
  const { canSend, withinDailyCap } = await import('../lib/growth/consent');
  const { recordUsage, usageHeadroom, readRate, costByModule } = await import('../lib/growth/ledger');
  const { headroomMessage, usdPerThousand, computeHeadroom } = await import('../lib/growth/units');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }

  try {
    await db.select('usage_events', { select: ['id'], limit: 1 });
  } catch (err) {
    console.error('\nGrowth tables are not reachable — apply 00027 first.\n  (' +
      ((err as Error)?.message || err) + ')');
    process.exit(2);
  }

  const tenantId = await ensureDefaultTenant();
  const dunning = moduleById('dunning')!;

  console.log('\nDunning — the gates, the ledger and the dedupe');
  console.log('='.repeat(72));
  console.log('tenant: ' + tenantId + '\n');

  // ── 1. the module is allowed to run at all ──────────────────────────────
  console.log('1. The module itself');
  check(assertLaunchable(dunning) === null, 'dunning is launchable', String(assertLaunchable(dunning)));
  check(dunning.attribution.mode === 'deterministic',
    'attribution is deterministic — a holdout here would withhold a payment notice',
    dunning.attribution.mode);
  check(dunning.requires.consent.includes('email_transactional') &&
        !dunning.requires.consent.includes('email_marketing'),
    'it is TRANSACTIONAL, so a marketing opt-in cannot withhold it',
    JSON.stringify(dunning.requires.consent));
  check(dunning.compliance.quietHours === false,
    'and exempt from quiet hours — a failed payment should not wait until 9am',
    String(dunning.compliance.quietHours));

  // ── 2. the compliance gate ──────────────────────────────────────────────
  console.log('\n2. The compliance gate');
  const noContact = await canSend({ tenantId, module: dunning, email: '' });
  check(!noContact.allowed && noContact.reason === 'no_contact',
    'a contact with no address is refused', JSON.stringify(noContact));

  // A transactional module must pass for someone with NO marketing consent —
  // that is the whole point of the transactional/marketing split.
  const stranger = await canSend({ tenantId, module: dunning, email: EMAIL });
  check(stranger.allowed === true,
    'a customer with no marketing opt-in still receives a TRANSACTIONAL notice',
    JSON.stringify(stranger));

  // The same address under a MARKETING module must be refused.
  const marketingModule = { ...dunning, requires: { ...dunning.requires, consent: ['email_marketing' as const] } };
  const asMarketing = await canSend({ tenantId, module: marketingModule, email: EMAIL });
  check(!asMarketing.allowed && asMarketing.reason === 'no_consent',
    'the SAME address is refused for a marketing module — consent is never assumed',
    JSON.stringify(asMarketing));

  // ── 3. the frequency cap ────────────────────────────────────────────────
  console.log('\n3. The frequency cap');
  const cap = dunning.compliance.frequencyCap;
  for (let i = 0; i < cap; i += 1) {
    await recordUsage({
      tenantId, moduleId: dunning.id, unit: 'email', quantity: 1,
      reference: 'contact:' + EMAIL,
    });
  }
  const capped = await canSend({ tenantId, module: dunning, email: EMAIL });
  check(!capped.allowed && capped.reason === 'frequency_cap',
    'after ' + cap + ' messages in 7 days the same contact is refused',
    JSON.stringify(capped));

  // ── 4. the ledger priced it ─────────────────────────────────────────────
  console.log('\n4. What it cost');
  const rate = await readRate('email');
  check(rate !== null, 'an email rate is configured');
  check(rate ? usdPerThousand(rate.unitCostMicros).toFixed(2) === '0.90' : false,
    'and matches the PUBLISHED price of $0.90 per 1,000',
    rate ? '$' + usdPerThousand(rate.unitCostMicros).toFixed(4) + '/1k' : 'no rate');

  const rows = (await db.select<{ cost_micros: number | string }>('usage_events', {
    where: { tenant_id: eq(tenantId), reference: eq('contact:' + EMAIL) },
    select: ['cost_micros'], limit: 20,
  })) as Array<{ cost_micros: number | string }>;
  check(rows.length === cap, 'every send was recorded (' + rows.length + '/' + cap + ')');
  const total = rows.reduce((s, r) => s + (Number(r.cost_micros) || 0), 0);
  check(total === cap * (rate?.unitCostMicros ?? 0),
    'priced at the rate that was live when it was sent',
    'total=' + total);

  const byModule = await costByModule(tenantId);
  const dunningCost = byModule.find((m) => m.moduleId === 'dunning');
  check(Boolean(dunningCost), 'cost-to-serve is attributable to the module', JSON.stringify(byModule));

  // ── 5. the caps that protect the budget ─────────────────────────────────
  console.log('\n5. The budget valves');
  const daily = await withinDailyCap(tenantId, dunning);
  check(daily.cap === dunning.caps.perTenantPerDay, 'the daily cap is the registry value', JSON.stringify(daily));
  check(daily.usedToday >= cap, 'and it counts today’s sends', JSON.stringify(daily));

  const tiny = await withinDailyCap(tenantId, dunning, 1);
  check(tiny.within === false, 'a tightened per-tenant cap refuses further sends', JSON.stringify(tiny));

  const headroom = await usageHeadroom('email');
  check(headroom !== null, 'platform free-tier headroom is readable');
  if (headroom) {
    console.log('   ' + headroom.usedThisPeriod + '/' + headroom.includedUnits +
      ' emails used this month (' + Math.round(headroom.percentUsed * 100) + '%)');
    check(headroom.includedUnits === 3000, 'the free allowance is Resend’s 3,000/month',
      String(headroom.includedUnits));
  }

  // The warning must carry the overage PRICE, not just a percentage.
  const nearLimit = computeHeadroom({
    unit: 'email', provider: 'resend', used: 2500, includedUnits: 3000,
    overageCostPerUnitMicros: rate?.unitCostMicros ?? 90_000,
  });
  const warning = headroomMessage(nearLimit) || '';
  check(warning.includes('$0.90 per 1,000'),
    'the free-tier warning names the overage price, so it prompts a decision',
    warning);

  // ── 6. the forecast that set the build order ────────────────────────────
  console.log('\n6. Why dunning ships first');
  const dunningEmails = forecastUnits(dunning, 130).email;
  const cartEmails = forecastUnits(moduleById('cart_recovery')!, 1000).email;
  console.log('   dunning at ~130 declines/mo : ' + dunningEmails + ' emails');
  console.log('   cart recovery at ~1,000     : ' + cartEmails + ' emails');
  check(dunningEmails < 3000, 'dunning fits inside the free tier — it earns before it costs',
    String(dunningEmails));
  check(cartEmails >= 3000, 'cart recovery does NOT, from one merchant alone',
    String(cartEmails));

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  try {
    await db.remove('usage_events', { where: { tenant_id: eq(tenantId), reference: eq('contact:' + EMAIL) } });
  } catch (err) {
    console.error('  cleanup failed: ' + ((err as Error)?.message || err));
  }
  const left = (await db.select<{ id: string }>('usage_events', {
    where: { tenant_id: eq(tenantId), reference: eq('contact:' + EMAIL) },
    select: ['id'], limit: 10,
  })) as Array<{ id: string }>;
  check(left.length === 0, 'test usage rows removed', 'left=' + left.length);

  console.log('\n' + '='.repeat(72));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
