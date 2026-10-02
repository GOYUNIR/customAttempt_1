import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { freshInstall, migrationFiles } from '../scripts/bootstrap/pglite-install.ts';
import { diffSchemas, tablesWithoutRls } from '../scripts/bootstrap/schema-parity.ts';

const root = join(import.meta.dirname, '..');

test('FRESH INSTALL: every migration applies, in order, to an empty database', async () => {
  const { db, applied } = await freshInstall(root);
  assert.equal(applied.length, migrationFiles(root).length);
  // Reference data comes from the migrations alone (no hand-run SQL).
  const plans = (await db.query('select id from public.plans order by id')).rows.map((r: any) => r.id);
  assert.deepEqual(plans, ['free', 'growth', 'scale', 'starter']);
  assert.ok(Number((await db.query('select count(*)::int as n from public.platform_policies')).rows[0].n) > 0, 'signup policies seeded');
  assert.ok(Number((await db.query('select count(*)::int as n from public.email_provider_plans')).rows[0].n) > 0, 'email limits seeded');
  // No tenant rows: the default-tenant shell is created by the code on first
  // use (lib/tenant-context.ts ensureDefaultTenant, insert-if-missing) and by
  // bootstrap's database step; a fresh install starts with no stores.
  assert.equal((await db.query('select count(*)::int as n from public.tenants')).rows[0].n, 0);
  // Discount codes stay OFF on every plan.
  assert.ok((await db.query('select discount_codes_enabled from public.plans')).rows.every((r: any) => r.discount_codes_enabled === false));
});

test('FRESH INSTALL: every public table enables row level security itself (00046)', async () => {
  const { db } = await freshInstall(root);
  assert.deepEqual(await tablesWithoutRls(db), []);
});

test('schema diff names what is missing on either side', () => {
  const d = diffSchemas(
    { tables: { a: ['id', 'x'], b: ['id'] }, functions: ['f', 'g'] },
    { tables: { a: ['id', 'y'], c: ['id'] }, functions: ['f', 'h'] },
  );
  assert.deepEqual(d.sort(), [
    'column missing in live: a.x',
    'column only in live (not in any migration): a.y',
    'function missing in live: g',
    'function only in live (not in any migration): h',
    'table missing in live: b',
    'table only in live (not in any migration): c',
  ]);
});
