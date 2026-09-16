/**
 * STORAGE FAIL-CLOSED VERIFICATION (Phase H0).
 *
 *   npx tsx scripts/verify-storage-failclosed.ts
 *
 * The hazard this pins: createSingleClient used to fall back to Upstash when
 * STORAGE_PROVIDER=supabase but Supabase env was missing. On any machine
 * holding BOTH credential sets -- a dev box, a half-migrated deploy -- a
 * mistyped SUPABASE_URL silently sent every write to a different datastore
 * while the app reported success.
 *
 * Exercised, not asserted from reading: the client is actually constructed
 * under each env combination and its identity checked.
 */
let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const SUPA = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
const UPSTASH = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'upstash-token' };
const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'STORAGE_PROVIDER', 'STORAGE_REPLICAS'];

function withEnv(env: Record<string, string>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function main() {
  const { createStorageClient } = await import('../lib/storage/index');
  console.log('\nStorage fail-closed\n' + '='.repeat(56));

  // THE DANGEROUS CASE: both credential sets present, Supabase selected but
  // its URL missing. The old code returned a live Upstash client here.
  withEnv({ STORAGE_PROVIDER: 'supabase', ...UPSTASH }, () => {
    const c = createStorageClient();
    check(c === null, 'supabase selected + unconfigured + Upstash available => NULL, not an Upstash client',
      'got ' + (c ? c.constructor.name : 'null'));
  });

  withEnv({ ...UPSTASH }, () => {
    const c = createStorageClient();
    check(c === null, 'provider UNSET (defaults to supabase) + Upstash available => still NULL',
      'got ' + (c ? c.constructor.name : 'null'));
  });

  // The legitimate configurations must keep working.
  withEnv({ STORAGE_PROVIDER: 'supabase', ...SUPA }, () => {
    check(createStorageClient() !== null, 'supabase selected + configured => a client');
  });
  withEnv({ STORAGE_PROVIDER: 'upstash', ...UPSTASH }, () => {
    check(createStorageClient() !== null, 'upstash EXPLICITLY selected + configured => a client');
  });
  withEnv({ STORAGE_PROVIDER: 'upstash' }, () => {
    check(createStorageClient() === null, 'upstash selected + unconfigured => null');
  });
  // An explicit replica list is a deliberate opt-in and must still mirror.
  withEnv({ STORAGE_PROVIDER: 'supabase', STORAGE_REPLICAS: 'upstash', ...SUPA, ...UPSTASH }, () => {
    check(createStorageClient() !== null, 'explicit STORAGE_REPLICAS=upstash still mirrors (opt-in, not a fallback)');
  });

  console.log('='.repeat(56));
  console.log(fail === 0 ? 'STORAGE FAILS CLOSED\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
