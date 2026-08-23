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

test('full plan targets all four migrations in order', () => {
  const plan = buildSchemaFixPlan("Could not find the table 'public.global_platform_settings' in the schema cache");
  assert.equal(plan.kind, 'full');
  assert.equal(plan.migrations.length, 4);
  assert.deepEqual(
    plan.migrations.map((m) => m.file),
    [
      'supabase/migrations/00001_init.sql',
      'supabase/migrations/00002_setup_operational.sql',
      'supabase/migrations/00003_tenant_routing.sql',
      'supabase/migrations/00004_ai_secondary.sql',
    ],
  );
});
