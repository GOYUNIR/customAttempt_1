/**
 * DOES withRedisLock ACTUALLY EXCLUDE?  (H4 finding)
 *
 *   npx tsx scripts/verify-lock-mutual-exclusion.ts            # fake backend
 *   npx tsx scripts/verify-lock-mutual-exclusion.ts --real     # PRODUCTION store_kv
 *
 * lib/redis-lock.ts acquires by `hincrby(lockKey, 'lock', 1)` and treats a
 * result of 1 as "I hold the lock". That is atomic on real Redis. Production
 * is NOT Redis: STORAGE_PROVIDER=supabase, so hincrby runs through
 * CloudflareKvStorageClient.mutate, which is
 *
 *     const current = await this.read(key);
 *     const next = fn(current);
 *     await this.write(key, next);
 *
 * -- a read-modify-write with no compare-and-swap, no conditional update and
 * no transaction. Two concurrent callers can both read 0, both compute 1, and
 * both believe they hold the lock.
 *
 * This measures it instead of arguing about it: run N concurrent critical
 * sections and record the MAXIMUM number inside at once. A working mutex
 * gives 1.
 *
 * --real uses the production store_kv with a uniquely-named throwaway lock key
 * (cache:lock:__exclusion_probe__*), deleted afterwards. It touches no
 * business data.
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

const REAL = process.argv.includes('--real');
const CONTENDERS = Number(process.env.LOCK_CONTENDERS || 10);

async function main() {
  let close = () => {};
  if (!REAL) {
    const db = await startFakePostgrest();
    process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.port;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'lock-key';
    close = () => db.close();
  }

  const { createKvClient } = await import('../lib/server-config');
  const { withRedisLock } = await import('../lib/redis-lock');

  const kv = createKvClient();
  if (!kv) { console.error('No storage client.'); process.exit(2); }

  console.log(`\nLock mutual exclusion — ${REAL ? 'PRODUCTION store_kv' : 'fake PostgREST'}`);
  console.log('='.repeat(66));

  const name = '__exclusion_probe__' + randomUUID();
  let inside = 0;
  let maxInside = 0;
  let acquired = 0;
  let contended = 0;

  const results = await Promise.all(
    Array.from({ length: CONTENDERS }, () =>
      withRedisLock(kv, name, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        // Hold it briefly so overlap is observable rather than theoretical.
        await new Promise((r) => setTimeout(r, 60));
        inside -= 1;
        return true;
      }, { retries: Number(process.env.LOCK_RETRIES ?? 0) }),
    ),
  );
  for (const r of results) { if (r.ok) acquired += 1; else contended += 1; }

  console.log(`  contenders           : ${CONTENDERS}`);
  console.log(`  acquired the lock    : ${acquired}`);
  console.log(`  reported contention  : ${contended}`);
  console.log(`  MAX concurrently in  : ${maxInside}   <- a working mutex gives 1`);

  // Clean up the probe key.
  await kv.del('cache:lock:' + name).catch(() => {});
  close();

  console.log('='.repeat(66));
  if (maxInside > 1) {
    console.log(`RESULT: NOT MUTUALLY EXCLUSIVE — ${maxInside} holders were inside at once.\n`);
    process.exit(1);
  }
  console.log('RESULT: mutually exclusive (max 1 holder).\n');
  process.exit(0);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
