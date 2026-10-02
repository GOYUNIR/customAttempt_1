import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STEPS, databaseStep, cloudflareStep, firstAdminStep, type Ctx } from '../scripts/bootstrap/steps.ts';
import { fakeWorld, fakeHttp, type FakeWorld } from '../scripts/bootstrap/fakes.ts';
import { resolveInputs } from '../scripts/bootstrap/inputs.ts';
import { migrationFiles, SUPABASE_PRELUDE } from '../scripts/bootstrap/pglite-install.ts';

const root = join(import.meta.dirname, '..');
const inputs = resolveInputs({ name: 'Larkspur Commerce', domain: 'larkspur.example', cloudflareAccountId: 'acc', adminEmail: 'owner@larkspur.example' });
const SECRET_VALUES = ['sk_test_FAKE_DO_NOT_PRINT', 're_FAKE_DO_NOT_PRINT', 'eyFAKE_SERVICE_ROLE_DO_NOT_PRINT', 'admin-password-FAKE-123'];

async function makeCtx(world: FakeWorld, envOver: Record<string, string> = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db: any = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_PRELUDE);
  const stored = new Map<string, string>();
  const env: Record<string, string> = {
    CLOUDFLARE_BOOTSTRAP_TOKEN: 'cf_FAKE_TOKEN_VALUE', RESEND_BOOTSTRAP_KEY: 're_FAKE_BOOTSTRAP_VALUE', STRIPE_BOOTSTRAP_KEY: 'sk_test_FAKE_BOOTSTRAP_VALUE',
    SUPABASE_URL: 'https://fakeproject.supabase.co', SUPABASE_ANON_KEY: 'eyFAKE_ANON_VALUE', SUPABASE_SERVICE_ROLE_KEY: SECRET_VALUES[2],
    MEDIA_S3_ACCESS_KEY_ID: 'FAKE_R2_ACCESS_KEY_ID', MEDIA_S3_SECRET_ACCESS_KEY: 'FAKE_R2_SECRET_ACCESS_KEY', BOOTSTRAP_ADMIN_PASSWORD: SECRET_VALUES[3],
    STRIPE_SECRET_KEY: SECRET_VALUES[0], RESEND_API_KEY: SECRET_VALUES[1], ...envOver,
  };
  const ctx: Ctx = {
    inputs, http: fakeHttp(world), env: (n) => env[n] || '',
    migrations: migrationFiles(root).map((f) => [f.split(/[\\/]/).pop()!, readFileSync(f, 'utf8')] as [string, string]),
    sql: async (q) => { if (/^\s*notify\b/i.test(q)) return []; const r = await db.exec(q); return r[r.length - 1]?.rows || []; },
    random: () => 'generated-' + Math.random(),
    putSecret: async (place, name, value) => { stored.set(place + ':' + name, value); },
    workerSecretNames: async () => new Set([...stored.keys()].filter((k) => k.startsWith('worker:')).map((k) => k.slice(7))),
  };
  return { ctx, db, stored };
}

async function applyAll(ctx: Ctx) {
  const described: string[] = [];
  for (const s of STEPS) {
    const p = await s.plan(ctx);
    assert.equal(p.blocked, undefined, s.id + ' blocked: ' + p.blocked);
    for (const a of p.todo) { described.push(a.describe); described.push(await a.run()); }
  }
  return described;
}

test('BOOTSTRAP: every step applies against fakes, and a second run finds nothing to do', async () => {
  const world = fakeWorld(inputs.domain);
  const { ctx, db, stored } = await makeCtx(world);
  const said = await applyAll(ctx);
  // What it built.
  assert.equal((await db.query("select count(*)::int as n from supabase_migrations.schema_migrations")).rows[0].n, migrationFiles(root).length);
  assert.equal((await db.query("select name from public.tenants where id = '00000000-0000-0000-0000-00000000000d'")).rows[0].name, 'Larkspur Commerce');
  assert.deepEqual(world.dns.filter((r) => r.type === 'AAAA').map((r) => r.name).sort(), ['*.larkspur.example', 'larkspur.example']);
  assert.deepEqual(world.buckets, ['larkspur-platform-media']);
  assert.equal(world.webhooks.length, 2);
  assert.ok(world.webhooks.find((w) => w.connect)?.url.endsWith('/api/stripe/connect-webhook'));
  assert.equal(world.setupCalls.length, 1);
  assert.equal(world.setupCalls[0].payment_provider, 'stripe');
  assert.ok(stored.has('database:payment_webhook_secret') && stored.has('database:payment_connect_webhook_secret') && stored.has('worker:TURNSTILE_SECRET_KEY') && stored.has('worker:CRON_SECRET'));
  // Nothing secret in anything it said.
  for (const line of said) for (const v of [...SECRET_VALUES, ...stored.values()]) assert.ok(!line.includes(v), 'a value leaked into: ' + line);
  // Idempotent: a second run plans nothing, and CRON_SECRET is not rotated.
  const cron = stored.get('worker:CRON_SECRET');
  for (const s of STEPS) assert.equal((await s.plan(ctx)).todo.length, 0, s.id + ' planned work on the second run');
  assert.equal(stored.get('worker:CRON_SECRET'), cron);
});

test('BOOTSTRAP: refuses to replay migrations over a schema it did not install (the old project)', async () => {
  const { ctx, db } = await makeCtx(fakeWorld(inputs.domain));
  await db.exec('create table public.tenants (id uuid primary key)');
  const p = await databaseStep.plan(ctx);
  assert.match(String(p.blocked), /already has a schema/);
  assert.equal(p.todo.length, 0);
});

test('BOOTSTRAP: blocked steps say what they need instead of guessing', async () => {
  const { ctx } = await makeCtx(fakeWorld('someone-else.example'));
  assert.match(String((await cloudflareStep.plan(ctx)).blocked), /zone larkspur\.example is not on this Cloudflare account/);
  const short = await makeCtx(fakeWorld(inputs.domain), { BOOTSTRAP_ADMIN_PASSWORD: 'short' });
  assert.match(String((await firstAdminStep.plan(short.ctx)).blocked), /at least 12/);
  const none = await makeCtx(fakeWorld(inputs.domain), { STRIPE_BOOTSTRAP_KEY: '' });
  assert.match(String((await STEPS.find((s) => s.id === 'stripe-webhooks')!.plan(none.ctx)).blocked), /needs STRIPE_BOOTSTRAP_KEY/);
});
