import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// GoTrue user_metadata is editable by the user themselves (PUT /auth/v1/user
// with their own token). Trusting it let any account holder sign in as super
// admin (proven on production, fixed in services/config/supabase-client.ts).
// The flag survives only as `metadataClaimsSuperAdmin`, informational; nothing
// may read it, and the super-admin decision must come from readSuperAdminFlag.
const ROOT = join(import.meta.dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules' || n.startsWith('.') || n === 'tests') return [];
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

test('no code reads the self-editable super-admin metadata claim', () => {
  const offenders: string[] = [];
  for (const dir of ['app', 'lib', 'services', 'components']) {
    for (const f of files(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      const uses = src.split('metadataClaimsSuperAdmin').length - 1;
      // supabase-client.ts declares it, computes it and returns it: exactly 3 mentions, 0 reads.
      const allowed = f.endsWith(join('services', 'config', 'supabase-client.ts')) ? 3 : 0;
      if (uses > allowed) offenders.push(f + ' (' + uses + ')');
    }
  }
  assert.deepEqual(offenders, []);
});

test('super-admin sign-in decides from server-side data only', () => {
  const src = readFileSync(join(ROOT, 'services', 'config', 'supabase-client.ts'), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.slice(src.indexOf('export async function verifySuperAdminSignIn'), src.indexOf('\n}\n', src.indexOf('export async function verifySuperAdminSignIn')));
  assert.ok(fn.includes('readSuperAdminFlag('), 'must use readSuperAdminFlag');
  assert.ok(!/user_metadata|metadataClaims|isSuperAdmin/.test(fn), 'must not consult metadata');
  assert.ok(!src.includes('export async function verifyPortalSignIn'), 'verifyPortalSignIn (metadata fallback) must stay removed');
});
