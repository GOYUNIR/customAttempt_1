#!/usr/bin/env -S npx tsx
/**
 * scripts/production-readiness-check.ts
 *
 * Pre-flight validation before a production deploy/cutover. Reuses the
 * EXACT SAME checks as the admin "System Health & Security Diagnostic
 * Panel" (lib/system-diagnostics.ts) plus two checks that only make sense
 * as an explicit CLI run: a LIVE Cloudflare API call (the admin panel
 * intentionally avoids a network round-trip to Cloudflare on every page
 * load), and confirming no destructive-admin opt-in was left on.
 *
 * Exit code 0 = ready (no `error`-level checks); exit code 1 = NOT ready.
 * Warnings never fail the build — they're printed for visibility.
 *
 * Usage:
 *   npx tsx scripts/production-readiness-check.ts
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

import {
  checkEnvSchema,
  checkCsrf,
  checkPortalIsolation,
  checkRlsCoverage,
  checkSupabaseConnection,
  checkRedisLocks,
  checkWebhookIdempotency,
  checkCloudflareLive,
  checkNoDestructiveActionsAllowed,
  type Check,
} from '@/lib/system-diagnostics';

const ICON: Record<Check['status'], string> = {
  ok: '✔',
  warning: '⚠',
  error: '✖',
  not_configured: '○',
};

async function main() {
  console.log('\n=== Production Readiness Check ===\n');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);

  const checks: Check[] = [
    checkEnvSchema(),
    checkCsrf(),
    checkNoDestructiveActionsAllowed(),
    checkPortalIsolation(),
    await checkSupabaseConnection(),
    await checkRlsCoverage(),
    await checkRedisLocks(),
    await checkWebhookIdempotency(),
    await checkCloudflareLive(),
  ];

  for (const c of checks) {
    console.log(`${ICON[c.status]} [${c.status.toUpperCase().padEnd(14)}] ${c.label} — ${c.detail}`);
  }

  const errors = checks.filter((c) => c.status === 'error');
  const warnings = checks.filter((c) => c.status === 'warning');
  const notConfigured = checks.filter((c) => c.status === 'not_configured');

  console.log(`\n${checks.length - errors.length - warnings.length - notConfigured.length} OK, ${warnings.length} warning(s), ${errors.length} error(s), ${notConfigured.length} not configured.\n`);

  if (errors.length > 0) {
    console.error(`✖ NOT production-ready — ${errors.length} error(s) must be fixed first.\n`);
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn('⚠ Production-ready, but review the warning(s) above.\n');
    process.exit(0);
  }
  console.log('✔ Production-ready.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Readiness check crashed:', err?.message || err);
  process.exit(1);
});
