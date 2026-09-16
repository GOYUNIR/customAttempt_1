#!/usr/bin/env -S npx tsx
/**
 * scripts/simulate-concurrency.ts
 *
 * Chaos test for the Postgres-backed inventory/raffle locking in
 * lib/inventory.ts and lib/raffle.ts. That logic already implements
 * Redis-lock + optimistic-concurrency CAS protection, but (per its own file
 * headers) is NOT wired into any live checkout/raffle route yet — so this
 * script calls the library functions directly rather than hitting HTTP
 * routes, to prove the already-built guarantees ahead of that wiring work
 * (see DEPLOYMENT.md's "Known Gaps / Roadmap").
 *
 * Two scenarios, against a freshly-seeded, clearly-tagged test product:
 *   1. N concurrent decrementInventory() calls against a low-stock variant —
 *      asserts successful decrements never exceed the seeded stock (no
 *      oversell) and the final Postgres row matches the tally exactly.
 *   2. N concurrent createRaffleEntry() calls for the SAME email+variant —
 *      asserts the partial-unique-index dedup lets exactly one through.
 *
 * Mutates real rows in the configured Supabase project (tagged, then
 * cleaned up on exit) — requires an explicit --confirm flag.
 *
 * Usage:
 *   npx tsx scripts/simulate-concurrency.ts --confirm [--n=1000] [--stock=10]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { supabaseServiceConfigured } from '@/services/config/supabase-client';
import { createRedisClient } from '@/lib/server-config';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { decrementInventory } from '@/lib/inventory';
import { createRaffleEntry } from '@/lib/raffle';

function argNum(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return fallback;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const n = argNum('n', 1000);
  const stock = argNum('stock', 10);

  console.log('\n=== Concurrency / Chaos Test ===\n');

  if (!supabaseServiceConfigured()) {
    console.error('✖ Supabase is not configured (SUPABASE_SERVICE_ROLE_KEY missing) — nothing to test against.');
    process.exit(1);
  }
  if (!createRedisClient()) {
    console.error('✖ No Redis/KV backend configured — decrementInventory() fails closed without one, so this test would be meaningless.');
    process.exit(1);
  }
  if (!confirm) {
    console.error('✖ This script mutates real rows in the configured Supabase project. Re-run with --confirm to proceed.');
    console.error(`  npx tsx scripts/simulate-concurrency.ts --confirm --n=${n} --stock=${stock}`);
    process.exit(1);
  }

  const db = getDb();
  const tenantId = await ensureDefaultTenant();
  const tag = `concurrency-test-${Date.now()}`;

  console.log(`Seeding a test product/variant tagged "${tag}" with ${stock} unit(s) of stock…`);
  const [product] = await db.insert<{ id: string }>('products', {
    tenant_id: tenantId,
    external_id: tag,
    name: `[chaos-test] ${tag}`,
    slug: tag,
    status: 'draft',
  });
  const [variant] = await db.insert<{ id: string }>('product_variants', {
    tenant_id: tenantId,
    product_id: product.id,
    option_label: 'Standard',
    price_cents: 1000,
  });
  await db.insert('inventory_levels', {
    tenant_id: tenantId,
    variant_id: variant.id,
    quantity_available: stock,
    quantity_reserved: 0,
  });

  let exitCode = 0;

  try {
    // ── Scenario 1: N concurrent checkout attempts against `stock` units ──
    console.log(`\nScenario 1: ${n} concurrent decrementInventory() calls against ${stock} unit(s)…`);
    const latencies: number[] = [];
    const tally = { ok: 0, insufficient_stock: 0, lock_contended: 0, no_inventory_row: 0, threw: 0 };

    const results = await Promise.allSettled(
      Array.from({ length: n }, async () => {
        const start = Date.now();
        const result = await decrementInventory(tenantId, variant.id, 1);
        latencies.push(Date.now() - start);
        return result;
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        tally.threw += 1;
        continue;
      }
      if (r.value.ok) tally.ok += 1;
      else tally[r.value.reason] += 1;
    }

    latencies.sort((a, b) => a - b);
    console.log(`  ok=${tally.ok} insufficient_stock=${tally.insufficient_stock} lock_contended=${tally.lock_contended} no_inventory_row=${tally.no_inventory_row} threw=${tally.threw}`);
    console.log(`  latency ms — p50=${percentile(latencies, 50)} p95=${percentile(latencies, 95)} p99=${percentile(latencies, 99)} max=${latencies[latencies.length - 1] ?? 0}`);

    const [finalInventory] = await db.select<{ quantity_available: number }>('inventory_levels', {
      where: { variant_id: eq(variant.id) },
      select: ['quantity_available'],
      limit: 1,
    });
    const expectedRemaining = stock - tally.ok;
    console.log(`  Postgres remaining=${finalInventory.quantity_available} expected=${expectedRemaining}`);

    if (tally.ok > stock) {
      console.error(`  ✖ OVERSOLD: ${tally.ok} successful decrements against only ${stock} unit(s) of stock.`);
      exitCode = 1;
    } else if (finalInventory.quantity_available !== expectedRemaining) {
      console.error('  ✖ Postgres row does not match the success tally — a decrement was lost or double-counted.');
      exitCode = 1;
    } else {
      console.log('  ✔ No oversell — successful decrements match seeded stock exactly, and the CAS-locked row agrees.');
    }

    // ── Scenario 2: N concurrent raffle entries for the same email+variant ──
    const raffleAttempts = Math.min(n, 100); // the unique-index dedup path doesn't need 1000 attempts to prove out
    const email = `chaos-test+${tag}@example.invalid`;
    console.log(`\nScenario 2: ${raffleAttempts} concurrent createRaffleEntry() calls for the same email+variant…`);
    const raffleResults = await Promise.allSettled(
      Array.from({ length: raffleAttempts }, () => createRaffleEntry({ tenantId, variantId: variant.id, email })),
    );
    let entered = 0;
    let alreadyEntered = 0;
    let raffleErrors = 0;
    for (const r of raffleResults) {
      if (r.status === 'rejected') {
        raffleErrors += 1;
        continue;
      }
      if (r.value.ok) entered += 1;
      else if (r.value.reason === 'already_entered') alreadyEntered += 1;
      else raffleErrors += 1;
    }
    console.log(`  entered=${entered} already_entered=${alreadyEntered} errors=${raffleErrors}`);
    if (entered !== 1) {
      console.error(`  ✖ DUPLICATE ENTRY: expected exactly 1 successful entry, got ${entered}.`);
      exitCode = 1;
    } else {
      console.log('  ✔ Dedup holds — exactly one entry accepted under concurrent load.');
    }

    await db.remove('raffle_entries', { where: { variant_id: eq(variant.id) } });
  } finally {
    console.log(`\nCleaning up seeded test product "${tag}" (cascades to its variant + inventory row)…`);
    await db.remove('products', { where: { id: eq(product.id) } });
  }

  console.log(exitCode === 0 ? '\n✔ Concurrency test passed.\n' : '\n✖ Concurrency test FAILED.\n');
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Concurrency test crashed:', err?.message || err);
  process.exit(1);
});
