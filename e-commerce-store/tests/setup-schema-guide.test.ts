/**
 * setup-schema-guide — the Setup Wizard's "Supabase schema not applied" fix.
 *
 * Verifies: (1) schema-error detection, (2) the ai_secondary vs full plan
 * branching, and (3) that the SQL string constants embedded in the shared
 * module stay byte-for-byte identical to the real supabase/migrations/*.sql
 * files (so a migration edit can never silently drift from what the wizard
 * tells an operator to paste).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSchemaError,
  buildSchemaFixPlan,
  MIGRATION_00001,
  MIGRATION_00002,
  MIGRATION_00003,
  MIGRATION_00004,
  MIGRATION_00005,
  MIGRATION_00006,
  MIGRATION_00007,
  MIGRATION_00008,
  MIGRATION_00009,
  MIGRATION_00010,
  MIGRATION_00011,
  MIGRATION_00012,
} from '../lib/setup-schema-guide.ts';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

test('isSchemaError matches the schema-not-applied error shapes', () => {
  assert.equal(isSchemaError("Could not find the 'ai_api_key_secondary' column of 'global_platform_settings' in the schema cache"), true);
  assert.equal(isSchemaError("Could not find the table 'public.global_platform_settings' in the schema cache"), true);
  assert.equal(isSchemaError('PGRST204'), true);
  assert.equal(isSchemaError('PGRST205'), true);
  assert.equal(isSchemaError('relation does not exist'), true);
  assert.equal(isSchemaError('Your Supabase credentials are invalid'), false);
});

test('embedded migration SQL is byte-for-byte identical to the real files', () => {
  assert.equal(MIGRATION_00001, readMigration('00001_init.sql'));
  assert.equal(MIGRATION_00002, readMigration('00002_setup_operational.sql'));
  assert.equal(MIGRATION_00003, readMigration('00003_tenant_routing.sql'));
  assert.equal(MIGRATION_00004, readMigration('00004_ai_secondary.sql'));
  assert.equal(MIGRATION_00005, readMigration('00005_stripe_price_id.sql'));
  assert.equal(MIGRATION_00006, readMigration('00006_ai_3d_mesh.sql'));
  assert.equal(MIGRATION_00007, readMigration('00007_ai3d_model.sql'));
  assert.equal(MIGRATION_00008, readMigration('00008_platform_rbac_hardening.sql'));
  assert.equal(MIGRATION_00009, readMigration('00009_commerce_b2b_core.sql'));
  assert.equal(MIGRATION_00010, readMigration('00010_custom_domains.sql'));
  assert.equal(MIGRATION_00011, readMigration('00011_variant_order_metadata.sql'));
  assert.equal(MIGRATION_00012, readMigration('00012_drop_mode_schema.sql'));
});

test('ai_secondary plan targets only 00004 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the 'ai_provider_secondary' column in the schema cache");
  assert.equal(plan.kind, 'ai_secondary');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00004_ai_secondary.sql');
  assert.ok(plan.migrations[0].sql.includes('add column if not exists ai_api_key_secondary text'));
  assert.ok(plan.steps.length >= 8);
  assert.ok(plan.verify.length > 0);
  assert.ok(plan.cli.includes('supabase db push'));
});

test('full plan targets all twelve migrations in order', () => {
  const plan = buildSchemaFixPlan("Could not find the table 'public.global_platform_settings' in the schema cache");
  assert.equal(plan.kind, 'full');
  assert.equal(plan.migrations.length, 12);
  assert.deepEqual(
    plan.migrations.map((m) => m.file),
    [
      'supabase/migrations/00001_init.sql',
      'supabase/migrations/00002_setup_operational.sql',
      'supabase/migrations/00003_tenant_routing.sql',
      'supabase/migrations/00004_ai_secondary.sql',
      'supabase/migrations/00005_stripe_price_id.sql',
      'supabase/migrations/00006_ai_3d_mesh.sql',
      'supabase/migrations/00007_ai3d_model.sql',
      'supabase/migrations/00008_platform_rbac_hardening.sql',
      'supabase/migrations/00009_commerce_b2b_core.sql',
      'supabase/migrations/00010_custom_domains.sql',
      'supabase/migrations/00011_variant_order_metadata.sql',
      'supabase/migrations/00012_drop_mode_schema.sql',
    ],
  );
});

test('drop_mode_schema plan targets only 00012 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the table 'public.raffle_entries' in the schema cache");
  assert.equal(plan.kind, 'drop_mode_schema');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00012_drop_mode_schema.sql');
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.raffle_entries'));
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.shared_inventory_pools'));
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.waitlist_entries'));
  assert.ok(plan.migrations[0].sql.includes("checkout_mode text not null default 'fcfs'"));
});

test('variant_order_metadata plan targets only 00011 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the 'metadata' column of 'product_variants' in the schema cache");
  assert.equal(plan.kind, 'variant_order_metadata');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00011_variant_order_metadata.sql');
  assert.ok(plan.migrations[0].sql.includes('add column if not exists metadata jsonb'));
});

test('custom_domains plan targets only 00010 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the 'domain_status' column of 'tenants' in the schema cache");
  assert.equal(plan.kind, 'custom_domains');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00010_custom_domains.sql');
  assert.ok(plan.migrations[0].sql.includes('cloudflare_hostname_id'));
});

test('rbac_hardening plan targets only 00008 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the table 'public.sales_tenant_assignments' in the schema cache");
  assert.equal(plan.kind, 'rbac_hardening');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00008_platform_rbac_hardening.sql');
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.sales_tenant_assignments'));
});

test('commerce_b2b plan targets only 00009 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the table 'public.companies' in the schema cache");
  assert.equal(plan.kind, 'commerce_b2b');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00009_commerce_b2b_core.sql');
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.companies'));
  assert.ok(plan.migrations[0].sql.includes('create table if not exists public.quotes'));
  assert.ok(plan.migrations[0].sql.includes("alter table public.audit_logs add column if not exists payload jsonb"));
});

test('ai_3d_mesh plan targets 00006 + 00007 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the 'ai3d_provider' column of 'global_platform_settings' in the schema cache");
  assert.equal(plan.kind, 'ai_3d_mesh');
  assert.equal(plan.migrations.length, 2);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00006_ai_3d_mesh.sql');
  assert.equal(plan.migrations[1].file, 'supabase/migrations/00007_ai3d_model.sql');
  assert.ok(plan.migrations[0].sql.includes('add column if not exists ai3d_provider text'));
  assert.ok(plan.migrations[1].sql.includes('add column if not exists ai3d_model text'));
});

test('stripe_price_id plan targets only 00005 with the right SQL', () => {
  const plan = buildSchemaFixPlan("Could not find the 'stripe_price_id' column of 'global_platform_settings' in the schema cache");
  assert.equal(plan.kind, 'stripe_price_id');
  assert.equal(plan.migrations.length, 1);
  assert.equal(plan.migrations[0].file, 'supabase/migrations/00005_stripe_price_id.sql');
  assert.ok(plan.migrations[0].sql.includes('add column if not exists stripe_price_id text'));
});
