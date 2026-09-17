/**
 * RAFFLE ENTRY + DRAW VERIFICATION (H5).
 *
 *   npm run verify:entries              # fake PostgREST
 *   npm run verify:entries -- --real    # PRODUCTION (test emails, cleaned up)
 *
 * H5 makes raffle_entries authoritative for entry storage and
 * duplicate-entry prevention, replacing the KV list + emailBlockKey set. The
 * duplicate block is the part that matters: it decides whether one person can
 * hold two slots in a draw, so it has to hold under CONCURRENCY, not just in
 * sequence. Postgres enforces it with a partial unique index
 * (tenant_id, variant_id, email) WHERE status = 'pending' (migration 00012).
 *
 * Self-audited for the bug classes introduced during H4:
 *   - double-writes: the same entry must not land twice
 *   - missing paths: a declined/charged entry must not block re-entry
 *   - lost-update races: concurrent identical entries must yield exactly one
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakePostgrest } from './fake-postgrest';

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

const REAL = process.argv.includes('--real');

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

async function main() {
  let close = () => {};
  if (!REAL) {
    const db = await startFakePostgrest();
    process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.port;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'entries-key';
    close = () => db.close();
  }

  const { createRaffleEntry, executeDraw, findPendingEntryId, markRaffleEntryOutcome } =
    await import('../lib/raffle');
  const { getDb } = await import('../lib/db/client');
  const { eq, inList } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');

  const db = getDb();
  const tenantId = REAL ? await ensureDefaultTenant() : '00000000-0000-4000-8000-0000000000aa';

  // A variant that really exists when running against production, so the FK
  // holds; an invented uuid otherwise.
  let variantId = '00000000-0000-4000-8000-00000000v001'.replace('v', '0');
  if (REAL) {
    const vs = (await db.select<{ id: string }>('product_variants', { select: ['id'], limit: 1 })) as Array<{ id: string }>;
    if (!vs?.[0]?.id) { console.error('No product_variants in production — cannot test FK-safe entries.'); process.exit(2); }
    variantId = vs[0].id;
  }

  const tag = '__h5probe__' + randomUUID().slice(0, 8);
  const email = tag + '@example.invalid';
  const createdIds: string[] = [];

  console.log(`\nRaffle entries — ${REAL ? 'PRODUCTION' : 'fake PostgREST'}`);
  console.log('='.repeat(64));
  console.log('     variant=' + variantId);
  console.log('     probe email=' + email);

  const cleanup = async () => {
    try {
      await db.remove('raffle_entries', { where: { tenant_id: eq(tenantId), email: eq(email) } });
    } catch { /* best effort */ }
    if (createdIds.length) {
      try { await db.remove('drop_draws', { where: { id: inList(createdIds) } }); } catch { /* ignore */ }
    }
  };

  try {
    // ── 1. one entry lands ────────────────────────────────────────────────
    const first = await createRaffleEntry({ tenantId, variantId, email, paymentMethodRef: 'pm_probe' });
    check(first.ok === true, 'a first entry is accepted', JSON.stringify(first));

    const afterFirst = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), email: eq(email) }, select: ['id'],
    })) as Array<{ id: string }>;
    check(afterFirst.length === 1, 'exactly ONE row exists — no double-write', String(afterFirst.length));

    // ── 2. SEQUENTIAL duplicate ───────────────────────────────────────────
    const second = await createRaffleEntry({ tenantId, variantId, email, paymentMethodRef: 'pm_probe' });
    check(second.ok === false, 'a duplicate entry is REFUSED', JSON.stringify(second));
    check(second.ok === false && second.reason === 'already_entered',
      'and reported as already_entered, not a generic error', JSON.stringify(second));
    const afterSecond = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), email: eq(email) }, select: ['id'],
    })) as Array<{ id: string }>;
    check(afterSecond.length === 1, 'still exactly one row after the duplicate attempt', String(afterSecond.length));

    // ── 3. CONCURRENT duplicates — the real race ──────────────────────────
    const raceEmail = tag + '-race@example.invalid';
    const race = await Promise.all(
      Array.from({ length: 8 }, () => createRaffleEntry({ tenantId, variantId, email: raceEmail, paymentMethodRef: 'pm_race' })),
    );
    const accepted = race.filter((r) => r.ok).length;
    const raceRows = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), email: eq(raceEmail) }, select: ['id'],
    })) as Array<{ id: string }>;
    console.log(`     8 concurrent identical entries -> ${accepted} accepted`);
    check(accepted === 1, 'exactly ONE concurrent entry is accepted', 'accepted=' + accepted);
    check(raceRows.length === 1, 'and the database holds exactly one row — no lost-update duplicate', String(raceRows.length));
    try { await db.remove('raffle_entries', { where: { tenant_id: eq(tenantId), email: eq(raceEmail) } }); } catch {}

    // ── 4. a decided entry must not block re-entry ────────────────────────
    const pendingId = await findPendingEntryId(tenantId, variantId, email);
    check(Boolean(pendingId), 'the pending entry is findable by email', String(pendingId));
    await markRaffleEntryOutcome(tenantId, pendingId!, 'declined');
    const reentry = await createRaffleEntry({ tenantId, variantId, email, paymentMethodRef: 'pm_again' });
    check(reentry.ok === true,
      're-entry is allowed once the previous entry is DECIDED (the index is partial on pending)',
      JSON.stringify(reentry));

    // ── 5. a draw consumes pending entries and records itself ─────────────
    const drawEmails = [tag + '-a@example.invalid', tag + '-b@example.invalid', tag + '-c@example.invalid'];
    for (const e of drawEmails) await createRaffleEntry({ tenantId, variantId, email: e, paymentMethodRef: 'pm_d' });
    const draw = await executeDraw(tenantId, variantId, 2);
    createdIds.push(draw.drawId);
    check(Boolean(draw.drawId), 'the draw recorded a drop_draws row', draw.drawId);
    check(draw.winnerCount === 2, 'it selected exactly the requested 2 winners', String(draw.winnerCount));
    check(draw.winnerEntryIds.length === 2, 'and returned 2 winner entry ids', String(draw.winnerEntryIds.length));
    check(
      new Set(draw.winnerEntryIds).size === draw.winnerEntryIds.length,
      'no entry was selected twice in one draw',
      JSON.stringify(draw.winnerEntryIds),
    );
    const stillPending = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), variant_id: eq(variantId), status: eq('pending') }, select: ['id'],
    })) as Array<{ id: string }>;
    check(
      !draw.winnerEntryIds.some((id) => stillPending.some((r) => r.id === id)),
      'winners are no longer pending — a second draw cannot re-select them',
    );

    // ── 6. NON-WINNERS ROLL OVER (option 1, matching the KV engines) ──────
    const stillPendingAfter = (await db.select<{ id: string; status: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), variant_id: eq(variantId), status: eq('pending') }, select: ['id', 'status'],
    })) as Array<{ id: string; status: string }>;
    check(
      stillPendingAfter.length === draw.notSelectedEntryIds.length,
      'every non-winner is STILL PENDING after the draw — they roll over',
      'pending=' + stillPendingAfter.length + ' notSelected=' + draw.notSelectedEntryIds.length,
    );
    const noneMarkedNotSelected = (await db.select<{ id: string }>('raffle_entries', {
      where: { tenant_id: eq(tenantId), variant_id: eq(variantId), status: eq('not_selected') }, select: ['id'],
    })) as Array<{ id: string }>;
    check(noneMarkedNotSelected.length === 0, 'no entry was marked not_selected', String(noneMarkedNotSelected.length));

    // A SECOND draw must still see them — the whole point of rolling over.
    const draw2 = await executeDraw(tenantId, variantId, 1);
    createdIds.push(draw2.drawId);
    check(
      draw2.entriesCount === draw.notSelectedEntryIds.length,
      'a SECOND draw sees the rolled-over entries (' + draw.notSelectedEntryIds.length + ')',
      'entriesCount=' + draw2.entriesCount,
    );
    check(draw2.winnerCount === 1, 'and can select a winner from them', String(draw2.winnerCount));
    check(
      !draw2.winnerEntryIds.some((id) => draw.winnerEntryIds.includes(id)),
      'draw 2 did not re-select draw 1’s winner',
    );

    for (const e of drawEmails) {
      try { await db.remove('raffle_entries', { where: { tenant_id: eq(tenantId), email: eq(e) } }); } catch {}
    }
  } finally {
    await cleanup();
    const leftovers = (await db
      .select<{ id: string }>('raffle_entries', { where: { tenant_id: eq(tenantId), email: eq(email) }, select: ['id'] })
      .catch(() => [])) as Array<{ id: string }>;
    check(leftovers.length === 0, 'probe rows cleaned up', String(leftovers.length));
    close();
  }

  console.log('='.repeat(64));
  console.log(fail === 0 ? 'RAFFLE ENTRIES VERIFIED\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
