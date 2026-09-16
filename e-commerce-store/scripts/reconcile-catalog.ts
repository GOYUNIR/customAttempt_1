/**
 * CATALOG RECONCILIATION (Phase G follow-up).
 *
 *   npx tsx scripts/reconcile-catalog.ts [--commit] [--allow-duplicate-labels]
 *
 * Phase G flipped the storefront to read Postgres while the existing catalog
 * still lived only in Redis/KV, so the two stores diverged: the storefront
 * rendered one product while the admin panel, checkout and the draw engines
 * saw four different ones.
 *
 * This copies every Redis product through the REAL write path
 * (lib/catalog-write.ts) so both stores hold the same catalog, and removes the
 * Phase G test artifact.
 *
 * Dry run by default. Reads the KV envelope directly ({v,e,t}) rather than
 * through the storage client, so it works against production with only the
 * Supabase credentials.
 *
 * DUPLICATE OPTION LABELS: product_variants has unique (product_id,
 * option_label), so two price categories with the same size collapse into one
 * row on upsert — the last one silently wins and the other's price, checkout
 * mode and limits are gone. A reconciliation tool that merges data and still
 * prints RECONCILED is the exact failure this work exists to eliminate, so
 * this refuses to exit 0 on a collision unless --allow-duplicate-labels says
 * the loss is understood and accepted.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i === -1) continue;
    const k = line.slice(0, i).trim(); let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadEnv();
process.env.USE_POSTGRES_PRIMARY = 'true';

const COMMIT = process.argv.includes('--commit');
const ALLOW_DUPES = process.argv.includes('--allow-duplicate-labels');
const TEST_ARTIFACT = 'phase-g-live-proof';

function decode(value: unknown): unknown {
  let v = value;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  return v;
}

/**
 * Duplicate option labels in the SOURCE, derived the same way the write path
 * derives option_label (String(cat.size).trim()) so the two cannot drift.
 */
function scanDuplicateLabels(products: Array<Record<string, unknown>>) {
  const out: Array<{ slug: string; label: string; count: number; categories: Array<{ price: unknown; checkoutMode: unknown }> }> = [];
  for (const p of products) {
    const cats = (Array.isArray(p.priceCategories) ? p.priceCategories : []) as Array<Record<string, unknown>>;
    const byLabel = new Map<string, Array<Record<string, unknown>>>();
    for (const raw of cats) {
      const cat = (raw || {}) as Record<string, unknown>;
      const label = String(cat.size || '').trim();
      if (!label) continue;
      byLabel.set(label, [...(byLabel.get(label) || []), cat]);
    }
    for (const [label, group] of byLabel) {
      if (group.length > 1) {
        out.push({ slug: String(p.slug), label, count: group.length, categories: group.map((c) => ({ price: c.price, checkoutMode: c.checkoutMode })) });
      }
    }
  }
  return out;
}

async function main() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const H = { apikey: key, Authorization: `Bearer ${key}` };

  console.log(`\nCatalog reconciliation — ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}\n${'='.repeat(58)}`);

  const kvRows = await (await fetch(`${url}/rest/v1/store_kv?key=eq.store%3Aproducts&select=value`, { headers: H })).json();
  const envelope = decode(kvRows[0]?.value) as { v?: Record<string, unknown> } | undefined;
  const raw = envelope?.v || {};
  const products = Object.values(raw).map((p) => decode(p) as Record<string, unknown>).filter((p) => p && typeof p === 'object');
  console.log(`Redis/KV catalog: ${products.length} product(s)`);
  for (const p of products) console.log(`  - ${p.slug} (${p.name}) — ${(p.priceCategories as unknown[] || []).length} size(s)`);

  // Pre-scan the SOURCE, so a dry run reports what a commit would merge
  // instead of only discovering it afterwards.
  const sourceCollisions = scanDuplicateLabels(products);
  if (sourceCollisions.length > 0) {
    console.log('\n' + '!'.repeat(58));
    console.log('DUPLICATE OPTION LABELS IN THE SOURCE CATALOG — DATA WILL BE LOST');
    console.log('!'.repeat(58));
    for (const c of sourceCollisions) {
      console.log(`  ${c.slug}: option_label '${c.label}' appears ${c.count}x`);
      c.categories.forEach((cat, i) => {
        const survives = i === c.categories.length - 1;
        console.log(`      ${survives ? 'KEPT   ' : 'DROPPED'}  price=${cat.price} mode=${cat.checkoutMode}`);
      });
    }
    console.log('  product_variants is unique on (product_id, option_label): the LAST');
    console.log('  category with a given label upserts over the earlier ones.');
    console.log('  Fix the duplicate sizes in the admin panel, or re-run with');
    console.log('  --allow-duplicate-labels to accept the loss.\n');
  }

  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { writeProductToPostgres, deleteProductFromPostgres } = await import('../lib/catalog-write');
  const tenantId = await ensureDefaultTenant();
  console.log(`\ntenant: ${tenantId}`);

  if (!COMMIT) {
    console.log('\nDRY RUN — would write the above into Postgres and delete the test artifact.');
    console.log('Re-run with --commit to apply.\n');
    return;
  }

  let ok = 0, failed = 0, mergedProducts = 0;
  for (const p of products) {
    const r = await writeProductToPostgres(tenantId, p);
    if (r.ok) {
      ok++;
      const dupes = r.duplicateLabels || [];
      const submitted = (p.priceCategories as unknown[] || []).length;
      if (dupes.length > 0) mergedProducts++;
      const note = dupes.length > 0
        ? `  <-- MERGED: ${dupes.map((d) => `'${d.label}' x${d.count}`).join(', ')} (${submitted} categories -> ${r.variantCount} rows)`
        : '';
      console.log(`  + ${p.slug}: ${r.variantCount} variant(s)${note}`);
    }
    else { failed++; console.log(`  ! ${p.slug}: ${r.error}`); }
  }
  console.log(`\nwritten: ${ok} ok, ${failed} failed`);

  const removed = await deleteProductFromPostgres(tenantId, TEST_ARTIFACT);
  console.log(`test artifact '${TEST_ARTIFACT}' removed: ${removed}`);

  const pg = await (await fetch(`${url}/rest/v1/products?select=slug&limit=100`, { headers: H })).json();
  const pgSlugs = (pg as Array<{ slug: string }>).map((r) => r.slug).sort();
  const kvSlugs = products.map((p) => String(p.slug)).sort();
  console.log(`\nPOSTGRES (${pgSlugs.length}): ${pgSlugs.join(', ')}`);
  console.log(`REDIS/KV (${kvSlugs.length}): ${kvSlugs.join(', ')}`);
  const match = JSON.stringify(pgSlugs) === JSON.stringify(kvSlugs);
  console.log('='.repeat(58));
  if (mergedProducts > 0) {
    console.log(`WARNING: ${mergedProducts} product(s) had duplicate option labels merged —`);
    console.log('         the slug lists match, but variant data was lost. See above.');
  }
  const clean = match && failed === 0 && (mergedProducts === 0 || ALLOW_DUPES);
  console.log(
    !match
      ? 'STILL DIVERGED\n'
      : mergedProducts === 0
        ? 'STORES RECONCILED — identical catalogs\n'
        : ALLOW_DUPES
          ? 'STORES RECONCILED — with accepted duplicate-label data loss\n'
          : 'NOT CLEAN — catalogs match but variant data was silently merged\n',
  );
  process.exit(clean ? 0 : 1);
}

main().catch((e) => { console.error('reconcile failed:', e); process.exit(1); });
