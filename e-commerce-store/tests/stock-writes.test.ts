import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// STRUCTURAL GUARD for the stock ledger (supabase/migrations/00037,
// lib/stock.ts). On-hand stock changes ONLY through the ledger's Postgres
// functions, which lock the row and write a movement in the same transaction.
// A direct write to inventory_levels from runtime code would bypass the holds
// (oversell) and leave a gap in the stock history, so it fails here, before it
// can ship. (Two such writers existed until 2026-09-27: a raw pre-charge
// decrement and a restock; both removed.)
const ROOT = join(import.meta.dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules' || n.startsWith('.')) return [];
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
// Across newlines on purpose: `.update<{ ... }>(\n  'inventory_levels'` is one call.
const WRITE = /\.(update|insert|upsert|remove)\s*(<[^>]*>)?\s*\(\s*['"`]inventory_levels['"`]/;
const RAW_REST = /['"`]\/(rest\/v1\/)?inventory_levels\b[^'"`]*['"`][\s\S]{0,200}method:\s*['"`](POST|PATCH|PUT|DELETE)/;

test('the pattern catches a write, even split across lines', () => {
  assert.ok(WRITE.test(`await getDb().update<{ quantity_available: number }>(\n      'inventory_levels',\n      { where: {} }, {})`));
  assert.ok(WRITE.test(`db.insert('inventory_levels', { tenant_id })`));
  assert.ok(!WRITE.test(`db.select('inventory_levels', { select: ['variant_id'] })`), 'reads are fine');
  assert.ok(RAW_REST.test(`supabaseRestFetch('/inventory_levels?variant_id=eq.x', { key, method: 'PATCH', body })`));
});

test('no runtime code writes inventory_levels outside the stock ledger', () => {
  const offenders: string[] = [];
  for (const dir of ['app', 'lib', 'services', 'components']) {
    for (const f of files(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      if (WRITE.test(src) || RAW_REST.test(src)) offenders.push(f.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'these write stock directly; use lib/stock.ts (reserveStock / commitSale / setStock / adjustStock)');
});

test('the raw writers stay deleted', () => {
  const inv = readFileSync(join(ROOT, 'lib', 'inventory.ts'), 'utf8');
  assert.ok(!/export async function (decrementInventory|restockInventory)\b/.test(inv));
});
