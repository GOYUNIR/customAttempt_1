/**
 * BACKFILL inventory_levels FROM ops:live_state  (H4, defect A).
 *
 *   npx tsx scripts/backfill-inventory-levels.ts            # DRY RUN
 *   npx tsx scripts/backfill-inventory-levels.ts --commit
 *
 * THE BLOCKER THIS CLEARS: inventory_levels has never had a row. Nothing
 * writes it -- lib/catalog-write.ts creates products and variants but no
 * inventory -- and lib/inventory.ts's decrementInventory fails CLOSED on
 * `no_inventory_row`. So gating checkout on Postgres inventory today would
 * refuse every single purchase. That is not a migration detail; it is the
 * reason H4 exists.
 *
 * MAPPING. A live-state record carries `sourceProductId` (the product's
 * external_id) and `size` (the variant's option_label), so the mapping is done
 * from FIELDS, not by parsing the composite key -- keys like
 * `prod_x-some-slug:50ml` are ambiguous when a slug contains a colon or dash.
 *
 * quantity_available is seeded from `inventoryRemaining`, NOT totalInventory:
 * seeding the total would resurrect already-sold stock.
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

const COMMIT = process.argv.includes('--commit');

/** Map key for (product, option label). JSON so no separator can collide. */
const vKey = (productId: string, label: string) => JSON.stringify([productId, label]);

async function main() {
  const { createKvClient, listLiveStates } = await import('../lib/server-config');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq, inList } = await import('../lib/db/query');

  console.log(`\ninventory_levels backfill — ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(72));

  const kv = createKvClient();
  if (!kv) { console.error('No storage client.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();
  const db = getDb();

  const live = await listLiveStates(kv);
  console.log(`ops:live_state entries: ${live.length}`);

  const products = (await db.select<{ id: string; slug: string; external_id: string }>('products', {
    where: { tenant_id: eq(tenantId) }, select: ['id', 'slug', 'external_id'],
  })) as Array<{ id: string; slug: string; external_id: string }>;
  const productByExternal = new Map(products.map((p) => [String(p.external_id), p]));

  const variants = products.length
    ? ((await db.select<{ id: string; product_id: string; option_label: string }>('product_variants', {
        where: { product_id: inList(products.map((p) => p.id)) }, select: ['id', 'product_id', 'option_label'],
      })) as Array<{ id: string; product_id: string; option_label: string }>)
    : [];
  const variantByKey = new Map(variants.map((v) => [vKey(v.product_id, v.option_label), v]));

  const existing = (await db.select<{ variant_id: string; quantity_available: number }>('inventory_levels', {
    where: { tenant_id: eq(tenantId) }, select: ['variant_id', 'quantity_available'],
  })) as Array<{ variant_id: string; quantity_available: number }>;
  const existingByVariant = new Map(existing.map((r) => [r.variant_id, r]));
  console.log(`inventory_levels rows today: ${existing.length}`);

  const planned: Array<{ variantId: string; label: string; qty: number }> = [];
  const orphans: string[] = [];
  const pools: string[] = [];
  const alreadyThere: string[] = [];

  for (const rec of live) {
    const r = rec as unknown as Record<string, unknown>;
    const sourceId = String(r.sourceProductId || '').trim();
    const size = String(r.size || '').trim();
    const stateId = String(r.productId || '');

    // Shared pools are their own table (shared_inventory_pools), not a variant
    // row. Reported, never guessed at.
    if (!sourceId && stateId.startsWith('shared:')) { pools.push(stateId); continue; }

    const product = productByExternal.get(sourceId);
    if (!product) { orphans.push(`${stateId}  (no product with external_id=${sourceId})`); continue; }
    const variant = variantByKey.get(vKey(product.id, size));
    if (!variant) { orphans.push(`${stateId}  (product ${product.slug} has no variant "${size}")`); continue; }

    const remaining = Math.max(0, Math.floor(Number(r.inventoryRemaining) || 0));
    if (existingByVariant.has(variant.id)) {
      alreadyThere.push(`${product.slug}:${size} (row exists, available=${existingByVariant.get(variant.id)!.quantity_available}) — NOT overwritten`);
      continue;
    }
    planned.push({ variantId: variant.id, label: `${product.slug}:${size}`, qty: remaining });
  }

  console.log('\nWOULD CREATE:');
  for (const p of planned) console.log(`  ${p.label.padEnd(30)} quantity_available=${p.qty}   variant_id=${p.variantId}`);
  if (alreadyThere.length) {
    console.log('\nALREADY PRESENT (left alone — overwriting would resurrect sold stock):');
    for (const a of alreadyThere) console.log('  ' + a);
  }
  if (pools.length) {
    console.log('\nSHARED POOLS (belong in shared_inventory_pools, not handled here):');
    for (const p of pools) console.log('  ' + p);
  }
  if (orphans.length) {
    console.log('\nORPHANED live-state entries (no matching product/variant — stale, safe to ignore):');
    for (const o of orphans) console.log('  ' + o);
  }

  // A variant with NO inventory row is the blocker restated: checkout would
  // refuse it. Name them explicitly rather than implying full coverage.
  const covered = new Set([...existingByVariant.keys(), ...planned.map((p) => p.variantId)]);
  const uncovered = variants.filter((v) => !covered.has(v.id));
  if (uncovered.length) {
    console.log('\nVARIANTS THAT WOULD STILL HAVE NO INVENTORY ROW (checkout refuses these):');
    for (const v of uncovered) {
      const prod = products.find((p) => p.id === v.product_id);
      console.log(`  ${prod?.slug}:${v.option_label}  variant_id=${v.id}`);
    }
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — would create ${planned.length} row(s). Re-run with --commit.\n`);
    return;
  }

  let created = 0;
  for (const p of planned) {
    try {
      await db.insert('inventory_levels', {
        tenant_id: tenantId, variant_id: p.variantId, quantity_available: p.qty, quantity_reserved: 0,
      });
      created++;
      console.log(`  + ${p.label}: ${p.qty}`);
    } catch (err) {
      console.error(`  ! ${p.label}: FAILED — ${(err as Error)?.message || err}`);
    }
  }

  const after = (await db.select<{ variant_id: string }>('inventory_levels', {
    where: { tenant_id: eq(tenantId) }, select: ['variant_id'],
  })) as Array<{ variant_id: string }>;
  console.log(`\ncreated ${created}; inventory_levels now holds ${after.length} row(s)`);
  const everyVariantCovered = variants.every((v) => after.some((r) => r.variant_id === v.id));
  console.log((everyVariantCovered ? 'PASS ' : 'FAIL ') + 'every product variant has an inventory row (checkout fails closed without one)');
  process.exit(everyVariantCovered ? 0 : 1);
}
main().catch((e) => { console.error('failed:', e); process.exit(1); });
