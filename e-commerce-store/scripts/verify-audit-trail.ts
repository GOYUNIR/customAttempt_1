/**
 * PLATFORM AUDIT TRAIL VERIFICATION (H8).
 *
 *   npm run verify:audit            # READ-ONLY diagnosis
 *   npm run verify:audit -- --probe # ALSO writes ONE PERMANENT row
 *
 * WHY THIS EXISTS. `public.audit_logs` is the tamper-resistant record of admin
 * actions, and it had zero rows. Three explanations were possible and only one
 * of them is a bug, so they were separated before anything was written:
 *
 *   1. the deployed Worker lacks SUPABASE_SERVICE_ROLE_KEY, so
 *      `getDb().configured` is false and recordPlatformAudit returns in
 *      silence                                    -- RULED OUT, both secrets present
 *   2. the deployed build predates the dual write -- RULED OUT, it landed 73
 *      commits before the deployed tip
 *   3. no admin action has happened since it shipped -- CONFIRMED: every one of
 *      the 86 `admin:audit_log` entries is dated 2026-08-30..2026-09-06, and
 *      the dual write landed 2026-09-14
 *
 * So the empty table is CORRECT. What it is not is PROVEN: a path that has
 * never executed in production is a path nobody has seen work, which is how
 * every other blocker in this project was found. --probe executes it once,
 * deliberately, instead of letting the first real admin action be the first
 * attempt.
 *
 * THE PROBE ROW IS PERMANENT. 00008 puts triggers on audit_logs that block
 * UPDATE and DELETE unconditionally, service-role key included. That is the
 * point of the table. The row is therefore written with an action and a detail
 * that explain themselves to whoever reads the audit log later, because no one
 * can remove it. --probe is opt-in for exactly this reason.
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

const PROBE = process.argv.includes('--probe');

/** The commit that added the appendAudit -> recordPlatformAudit dual write. */
const DUAL_WRITE_LANDED = '2026-09-14T00:00:00.000Z';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

async function main() {
  const { createKvClient, AUDIT_LOG_KEY, safeParseKvItem } = await import('../lib/server-config');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { recordPlatformAudit } = await import('../lib/platform-audit');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const kv = createKvClient();
  const tenantId = await ensureDefaultTenant();

  console.log('\nPlatform audit trail — is the permanent record actually recording?');
  console.log('='.repeat(72));
  console.log('tenant: ' + tenantId);
  console.log('mode:   ' + (PROBE ? 'PROBE (writes one permanent row)' : 'read-only diagnosis') + '\n');

  // ── 1. the schema recordPlatformAudit writes into ────────────────────────
  console.log('1. Every column recordPlatformAudit writes exists and is readable');
  const cols = ['id', 'tenant_id', 'target_tenant_id', 'actor', 'staff_id', 'action', 'detail', 'payload', 'ip_address', 'created_at'];
  for (const c of cols) {
    let ok = true;
    try { await db.select('audit_logs', { select: [c], limit: 1 }); } catch { ok = false; }
    check(ok, '   ' + c);
  }

  // ── 2. why the table is empty ────────────────────────────────────────────
  console.log('\n2. Reconciling the KV list against the permanent table');
  const before = (await db.select<{ id: string }>('audit_logs', { select: ['id'], limit: 1000 })) as Array<{ id: string }>;
  console.log('   audit_logs rows: ' + before.length);

  if (kv) {
    const rows: string[] = await kv.lrange(AUDIT_LOG_KEY, 0, -1);
    const parsed = (rows.map((r) => safeParseKvItem<any>(r)).filter(Boolean) as any[])
      .filter((e) => e?.at)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const after = parsed.filter((e) => String(e.at) >= DUAL_WRITE_LANDED);
    console.log('   admin:audit_log entries: ' + parsed.length +
      (parsed.length ? ' (' + parsed[0].at + ' .. ' + parsed[parsed.length - 1].at + ')' : ''));
    console.log('   of those, written since the dual write landed: ' + after.length);
    check(
      after.length === before.length,
      '   the two agree: ' + after.length + ' admin action(s) since the dual write, ' +
        before.length + ' permanent row(s)',
      'KV-since=' + after.length + ' pg=' + before.length +
        ' — a mismatch means the dual write ran and was silently dropped',
    );
  }

  // ── 3. does the write path actually work? ────────────────────────────────
  if (!PROBE) {
    console.log('\n3. The write path is NOT exercised in read-only mode.');
    console.log('   It has never run in production (see section 2), so "it works" is');
    console.log('   currently an assumption. Re-run with --probe to settle it:');
    console.log('     npm run verify:audit -- --probe');
    console.log('   That writes ONE row which can never be deleted (00008 blocks it).');
  } else {
    console.log('\n3. Exercising recordPlatformAudit for real');
    const marker = 'h8-verification-' + Date.now().toString(36);
    await recordPlatformAudit({
      action: 'audit_trail_verified',
      actor: 'h8-verification',
      tenantId,
      detail: {
        why: 'public.audit_logs had zero rows. Confirmed correct (no admin action had ' +
          'occurred since the dual write shipped on 2026-09-14), but the write path had ' +
          'therefore never executed. This row proves it does, rather than letting the ' +
          'first real admin action be the first attempt.',
        marker,
        script: 'scripts/verify-audit-trail.ts',
      },
      ipAddress: null,
    });

    const found = (await db.select<{ id: string; action: string; actor: string; detail: any }>('audit_logs', {
      where: { tenant_id: eq(tenantId), action: eq('audit_trail_verified') },
      select: ['id', 'action', 'actor', 'detail'],
      limit: 10,
    })) as Array<{ id: string; action: string; actor: string; detail: any }>;
    const mine = found.filter((r) => r?.detail?.marker === marker);

    check(mine.length === 1, 'recordPlatformAudit really wrote a row', 'found=' + mine.length);
    check(mine[0]?.actor === 'h8-verification', 'with the actor it was given', JSON.stringify(mine[0]?.actor));

    // ── 4. is it actually tamper-resistant? ────────────────────────────────
    // 00008 claims UPDATE and DELETE are blocked unconditionally, for the
    // service-role key too. Nothing has ever tested that claim. If the trigger
    // is missing this DELETE succeeds — which removes the probe row (harmless)
    // and reveals that the "immutable" audit trail is editable (not harmless).
    if (mine.length === 1) {
      console.log('\n4. Is the append-only trigger (00008) real?');
      let deleteBlocked = false;
      try {
        await db.remove('audit_logs', { where: { tenant_id: eq(tenantId), id: eq(mine[0].id) } });
      } catch {
        deleteBlocked = true;
      }
      const still = (await db.select<{ id: string }>('audit_logs', {
        where: { id: eq(mine[0].id) }, select: ['id'], limit: 1,
      })) as Array<{ id: string }>;
      check(
        deleteBlocked || still.length === 1,
        'DELETE is refused even with the service-role key — the trail is tamper-resistant',
        'The row was DELETED. audit_logs is NOT append-only; 00008\'s trigger is missing.',
      );
      check(still.length === 1, 'and the row is still there afterwards', 'rows=' + still.length);
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
