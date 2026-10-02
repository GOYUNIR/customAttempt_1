import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

/**
 * VENDOR COUPLING FENCE — the half ESLint structurally cannot enforce.
 *
 * eslint.config.mjs blocks `import Stripe from 'stripe'` and friends. It cannot
 * see `fetch('https://api.stripe.com/v1/...')`, which couples business logic to
 * a vendor just as tightly while passing lint cleanly. That is exactly how the
 * Supabase coupling grew: 27 files calling PostgREST URLs, zero SDK imports.
 *
 * This test scans real source for vendor API hosts and fails on any occurrence
 * outside an explicitly justified allowlist. Adding a vendor call in business
 * logic therefore breaks the build with a message saying what to do instead.
 */

const ROOTS = ['app', 'lib', 'components', 'services', 'scripts'];

/** Vendor API hosts that must only ever be reached through a driver. */
const VENDOR_API_HOSTS = [
  'api.stripe.com',
  'api.resend.com',
  'api.mapbox.com',
  'api.postmarkapp.com',
  'api.sendgrid.com',
  'api.lemonsqueezy.com',
  'api.paddle.com',
];

/**
 * Files permitted to name a vendor API host, each with the reason it must.
 * Anything not listed here is a bypass of the abstraction.
 */
const ALLOWED: Record<string, string> = {
  // Setup wizard: validates a key the operator is ENTERING, before any driver
  // is configured. A driver cannot verify a credential it does not yet have.
  // Provider-agnostic (stripe/paddle/lemon_squeezy, resend/postmark/sendgrid),
  // so it is a credential validator, not vendor lock-in.
  'app/api/admin/setup/route.ts': 'pre-configuration credential validation',
  // Browser-side address autofill. A server-side driver port cannot run in the
  // page, and this module exists to work around a documented Mapbox SDK bug.
  'lib/mapbox-autofill.ts': 'client-side SDK bootstrap (browser only)',
  // The shared Mapbox Search JS asset URL, not an API call.
  'services/maps/types.ts': 'shared SDK asset URL',
  // A verification script READING BACK what production sent (sender, reply-to,
  // body of a store's order email). The email driver only sends; there is no
  // port for inspecting a provider's sent log, and business code never does.
  'scripts/resend-readback.ts': 'proof read-back of sent emails (verification scripts only, not business logic)',
  // Reads the sending domain's verification status (DOMAIN-MIGRATION.md):
  // a provider dashboard fact the email drivers have no port for.
  'scripts/verify-domain-migration.ts': 'domain-move check reads the sending domain\'s verification status (verification script only)',
  // Bootstrap PROVISIONS the accounts a fresh install runs on (BOOTSTRAP-RUNBOOK.md):
  // the sending domain, the webhook endpoints. Operator tooling run once per
  // install, not business logic; the drivers have no port for creating accounts'
  // infrastructure, and must not (the running app never provisions itself).
  'scripts/bootstrap/steps.ts': 'fresh-install provisioning of the vendor accounts (operator tooling, run once per install)',
  // The in-memory stand-ins for those same vendor APIs (tests and the rehearsal).
  'scripts/bootstrap/fakes.ts': 'fakes of the provisioning APIs for tests and the local rehearsal (no network)',
};

/**
 * The driver layer IS the vendor boundary, so every *.driver.ts under services/
 * is allowed by pattern rather than listed file by file. Listing them
 * individually went stale immediately: the Stripe and Mapbox drivers use their
 * SDKs rather than raw URLs, so their entries matched nothing.
 */
function isDriver(relPath: string): boolean {
  return /^services\/.+\.driver\.ts$/.test(relPath);
}
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(root, files);
  return files;
}

/** Repo-relative, forward-slashed, so keys match on Windows too. */
function rel(file: string): string {
  return file.split(sep).join(posix.sep);
}

test('vendor coupling: no business-logic file calls a vendor API host directly', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const key = rel(file);
    if (isDriver(key) || ALLOWED[key]) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const host of VENDOR_API_HOSTS) {
      if (text.includes(host)) offenders.push(`${key} -> ${host}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These files reach a vendor API directly instead of going through its driver ' +
      'in services/. Use the driver port, or add the file to ALLOWED with the ' +
      'reason it genuinely cannot:\n  ' + offenders.join('\n  '),
  );
});

test('vendor coupling: the allowlist has no stale entries', () => {
  // A allowlisted file that no longer names a vendor host means the exemption
  // outlived its reason — remove it so it cannot silently cover a future call.
  const stale: string[] = [];
  for (const [key] of Object.entries(ALLOWED)) {
    let text = '';
    try {
      text = readFileSync(key, 'utf8');
    } catch {
      continue; // file removed entirely; harmless
    }
    if (!VENDOR_API_HOSTS.some((h) => text.includes(h))) stale.push(key);
  }
  assert.deepEqual(stale, [], `Allowlisted but no longer calling a vendor API: ${stale.join(', ')}`);
});

test('vendor coupling: the scanner actually scans a meaningful number of files', () => {
  // Guards against the whole test silently passing because a path changed and
  // sourceFiles() returned nothing.
  assert.ok(sourceFiles().length > 100, `only scanned ${sourceFiles().length} files`);
});
