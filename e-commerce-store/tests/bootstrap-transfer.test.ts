import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { freshInstall } from '../scripts/bootstrap/pglite-install.ts';
import { exportTenant, importTenant, TRANSFER_TABLES, type Store } from '../scripts/bootstrap/tenant-transfer.ts';

const root = join(import.meta.dirname, '..');
const SHOP = '00000000-0000-0000-0000-0000000000aa';
const NEW_ID = '00000000-0000-0000-0000-0000000000bb';

function pgStore(db: any): Store {
  const pk = (t: string) => (t === 'tenant_store_config' ? 'tenant_id' : 'id');
  return {
    async select(t, id) { return (await db.query('select * from public.' + t + ' where ' + (t === 'tenants' ? 'id' : 'tenant_id') + ' = $1', [id])).rows; },
    async insertNew(t, rows) {
      let n = 0;
      for (const r of rows) {
        const cols = Object.keys(r);
        const vals = cols.map((c) => (r[c] !== null && typeof r[c] === 'object' && !(r[c] instanceof Date) ? JSON.stringify(r[c]) : r[c]));
        const res = await db.query('insert into public.' + t + ' (' + cols.join(',') + ') values (' + cols.map((_, i) => '$' + (i + 1)).join(',') + ') on conflict (' + pk(t) + ') do nothing returning 1', vals);
        n += res.rows.length;
      }
      return n;
    },
    async stockSet(tenantId, variantId, count, note) { await db.query('select public.stock_set($1, $2, $3, $4, $5)', [tenantId, variantId, count, 'tenant-transfer', note]); },
    async onHand(tenantId, ids) {
      if (!ids.length) return {};
      const rows = (await db.query('select variant_id, quantity_available from public.inventory_levels where tenant_id = $1 and variant_id = any($2::uuid[])', [tenantId, ids])).rows;
      return Object.fromEntries(rows.map((r: any) => [r.variant_id, Number(r.quantity_available)]));
    },
  };
}

test('TRANSFER: a store\'s catalog and config move to a fresh install; old-platform ties are cut; re-running adds nothing', async () => {
  const src = (await freshInstall(root)).db;
  const dst = (await freshInstall(root)).db;
  // The source shop: connected to Stripe on the OLD platform, with a domain.
  await src.exec(`
    insert into public.tenants (id, name, slug, license_status, plan_id, stripe_account_id, connect_charges_enabled, connect_payouts_enabled, custom_domain, domain_status)
      values ('${SHOP}', 'Old Shop', 'oldshop', 'active', 'free', 'acct_OLDPLATFORM1', true, true, 'shop.example.com', 'active');
    insert into public.tenant_store_config (tenant_id, config) values ('${SHOP}', '{"branding":{"brandName":"Old Shop","logoUrl":"tenants/${SHOP}/brand/logo.png"}}');
    insert into public.products (id, tenant_id, external_id, name, slug, is_active, media_gallery)
      values ('00000000-0000-0000-0000-0000000000p1', '${SHOP}', 'prod_1', 'Ember Tee', 'ember-tee', true, '["tenants/${SHOP}/products/a.jpg"]');
    insert into public.product_variants (id, tenant_id, product_id, sku, option_label, price_cents, currency)
      values ('00000000-0000-0000-0000-0000000000v1', '${SHOP}', '00000000-0000-0000-0000-0000000000p1', 'ET-M', 'M', 2900, 'usd');
  `.replace(/0000000000p1/g, '0000000000a1').replace(/0000000000v1/g, '0000000000b1'));
  await src.query('select public.stock_set($1, $2, $3, $4, $5)', [SHOP, '00000000-0000-0000-0000-0000000000b1', 7, 'seed', 'seed']);

  const bundle = await exportTenant(pgStore(src), SHOP);
  assert.equal(bundle.stock['00000000-0000-0000-0000-0000000000b1'], 7);
  assert.ok(bundle.media.includes('tenants/' + SHOP + '/products/a.jpg') && bundle.media.includes('tenants/' + SHOP + '/brand/logo.png'), 'photos are listed for copying');

  const plan = await importTenant(pgStore(dst), bundle, { asId: NEW_ID, asSlug: 'goyunir-shop' }, false);
  assert.ok(plan.some((l) => l.startsWith('would insert')), 'dry run plans');
  assert.equal((await dst.query('select count(*)::int as n from public.tenants')).rows[0].n, 0, 'dry run writes nothing');

  const did = await importTenant(pgStore(dst), bundle, { asId: NEW_ID, asSlug: 'goyunir-shop' }, true);
  const t = (await dst.query('select * from public.tenants where id = $1', [NEW_ID])).rows[0];
  assert.equal(t.slug, 'goyunir-shop');
  assert.equal(t.stripe_account_id, null, 'the old platform\'s connected account does not travel');
  assert.equal(t.connect_charges_enabled, false);
  assert.equal(t.custom_domain, null, 'the domain is re-added and re-verified on the new platform');
  assert.equal(t.domain_status, 'unconfigured');
  assert.equal((await dst.query('select name from public.products where tenant_id = $1', [NEW_ID])).rows[0].name, 'Ember Tee');
  assert.equal((await dst.query('select on_hand from public.stock_levels where variant_id = $1', ['00000000-0000-0000-0000-0000000000b1'])).rows[0].on_hand, 7);
  assert.ok((await dst.query('select count(*)::int as n from public.stock_movements where variant_id = $1', ['00000000-0000-0000-0000-0000000000b1'])).rows[0].n >= 1, 'the count arrives with a ledger entry');
  assert.ok(did.some((l) => /connected account was NOT moved/.test(l)));

  // Idempotent.
  const again = await importTenant(pgStore(dst), bundle, { asId: NEW_ID, asSlug: 'goyunir-shop' }, true);
  for (const tname of TRANSFER_TABLES) {
    const line = again.find((l) => l.startsWith(tname + ':'));
    if (line) assert.match(line, /: 0 new/, 'second import of ' + tname + ' added rows: ' + line);
  }
  assert.match(again.find((l) => l.startsWith('stock:'))!, /: 0 variant count/);
});

test('TRANSFER: media references resolve to storage keys (full URLs on any old domain, or bare keys)', async () => {
  const { mediaKeyOf } = await import('../scripts/bootstrap/tenant-transfer.ts');
  assert.equal(mediaKeyOf('https://media.old.example/media/r2/tenants/abc/products/x.jpg'), 'tenants/abc/products/x.jpg');
  assert.equal(mediaKeyOf('tenants/abc/products/x.jpg'), 'tenants/abc/products/x.jpg');
  assert.equal(mediaKeyOf('products/brand/logo.png'), 'products/brand/logo.png');
  assert.equal(mediaKeyOf('https://cdn.elsewhere.example/x.jpg'), '', 'not ours: left alone');
});
