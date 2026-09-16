/**
 * loadProducts PARITY (H3).
 *
 *   npx tsx scripts/verify-loadproducts-parity.ts
 *
 * loadProducts(redis) is called by 26 files, including every money path
 * (checkout/*, stripe/webhook, auto-draw, draw, trigger-drop). Switching its
 * source from the KV blob to Postgres migrates all 26 at once, which is the
 * only sane way to do it -- and also means a shape mismatch breaks checkout.
 *
 * So this compares the two sources on the REAL production catalog, key by key
 * and field by field, BEFORE the switch. Not "does it compile", not "does it
 * return something": does it return the SAME thing.
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
// Production runs with this set (a Worker var, not in .env.local). Without it
// isPostgresPrimaryEnabled() refuses and the harness would compare KV to null.
process.env.USE_POSTGRES_PRIMARY = 'true';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

/**
 * Canonicalize before comparing: JSON.stringify is key-ORDER sensitive, and
 * Postgres jsonb does not preserve insertion order. Comparing raw strings
 * reported every object in the catalog as different, which is the harness
 * being wrong, not the data. Sort keys recursively so only real differences
 * survive.
 */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as any)[k];
      if (val === undefined) continue; // absent and undefined are the same thing here
      out[k] = canon(val);
    }
    return out;
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Deep diff, returning dotted paths that differ. */
function diff(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (same(a, b)) return out;
  const aObj = a && typeof a === 'object' && !Array.isArray(a);
  const bObj = b && typeof b === 'object' && !Array.isArray(b);
  if (aObj && bObj) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    for (const k of keys) diff((a as any)[k], (b as any)[k], path ? path + '.' + k : k, out);
    return out;
  }
  out.push(`${path}: KV=${JSON.stringify(a)?.slice(0, 60)} PG=${JSON.stringify(b)?.slice(0, 60)}`);
  return out;
}

async function main() {
  console.log('\nloadProducts parity — KV blob vs Postgres, real catalog\n' + '='.repeat(64));

  const { createKvClient, loadProducts } = await import('../lib/server-config');

  // BOTH sides go through loadProducts, so the SAME normalization runs over
  // each and only the source differs. Comparing normalized KV against RAW
  // Postgres previously reported winnerTiers as lost on every product --
  // normalizePriceCategory defaults it to '0' when absent, so that difference
  // was the harness, not the data.
  const kv = createKvClient();
  check(Boolean(kv), 'KV client available');
  const fromKv = await loadProducts(kv, { source: 'kv' });
  const kvIds = Object.keys(fromKv).sort();
  console.log('     KV products: ' + kvIds.length + ' (' + kvIds.join(', ') + ')');

  const fromPg = await loadProducts(kv, { source: 'postgres' });
  check(Object.keys(fromPg).length > 0, 'Postgres product read succeeded');
  const pgIds = Object.keys(fromPg).sort();
  console.log('     PG products: ' + pgIds.length + ' (' + pgIds.join(', ') + ')');

  check(JSON.stringify(kvIds) === JSON.stringify(pgIds), 'the SAME product ids, in the same set',
    'KV=' + kvIds.join(',') + '  PG=' + pgIds.join(','));

  // Fields that are REQUIRED to match, because money or lifecycle depends on
  // them. Presentation drift is reported but not failed.
  const CRITICAL = ['id', 'slug', 'name', 'isActive', 'isArchived', 'isUpcoming', 'checkoutMode',
    'isRaffle', 'maxPerEmail', 'maxPerCart', 'maxRaffleAllocationLimit', 'totalInventory',
    'goLiveAt', 'releaseEndsAt', 'priceCategories'];

  let criticalMismatches = 0;
  const cosmetic: string[] = [];
  for (const id of kvIds) {
    if (!fromPg[id]) continue;
    const paths = diff(fromKv[id], fromPg[id]);
    for (const d of paths) {
      const field = d.split(':')[0].split('.')[0].replace(/\[.*/, '');
      if (CRITICAL.includes(field)) { criticalMismatches++; console.log('  CRITICAL ' + id + '.' + d); }
      else cosmetic.push(id + '.' + d);
    }
  }
  check(criticalMismatches === 0, 'no CRITICAL field differs (money + lifecycle fields)', criticalMismatches + ' mismatch(es)');

  console.log('\n     cosmetic/non-critical differences: ' + cosmetic.length);
  for (const c of cosmetic.slice(0, 25)) console.log('       ' + c);
  if (cosmetic.length > 25) console.log('       … and ' + (cosmetic.length - 25) + ' more');

  console.log('='.repeat(64));
  console.log(fail === 0 ? 'PARITY OK on critical fields\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
