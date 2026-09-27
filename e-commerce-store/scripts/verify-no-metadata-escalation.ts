/**
 * SUPER-ADMIN ESCALATION PROOF (services/config/supabase-client.ts readSuperAdminFlag).
 *
 *   npx tsx scripts/verify-no-metadata-escalation.ts
 *
 * A throwaway store staff account (real invite + accept flow) rewrites its OWN
 * GoTrue user_metadata to claim super admin -- which any signed-in user can do
 * with nothing but their own token -- then tries the real production sign-in
 * routes. Before the fix /api/admin/super-login accepted it. Every route must
 * refuse. The account is deleted at the end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }

const APP = 'https://app.goyunir.com';
const ADMIN = 'https://admin.goyunir.com';
const SALES = 'https://sales.goyunir.com';
const TEST4 = '13591c9e-82e4-4c23-8d94-249cef6fa775';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { createInvite } = await import('../lib/staff-invites');
  const { deleteStaffAccount } = await import('../lib/staff-accounts');
  const sc: any = await import('../services/config/supabase-client');
  const email = 'iso-escalation-' + Date.now() + '@goyunir.invalid';
  const password = 'Iso-' + crypto.randomUUID() + '-Aa1!';
  try {
    const inv: any = await createInvite({ email, role: 'staff', tenantId: TEST4, invitedByEmail: 'isolation-proof@goyunir.invalid' });
    const acc = await fetch(APP + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify({ token: inv.token, password }) });
    check(acc.status === 200, 'throwaway test4 staff account created through the real accept route: ' + acc.status);
    const cred = await sc.verifySuperAdminCredentials(email, password);
    const { url, anonKey } = sc.readSupabaseEnv();
    const upd = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { method: 'PUT', headers: { apikey: anonKey, authorization: 'Bearer ' + cred.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ data: { is_super_admin: true, role: 'super_admin' } }) });
    const again = await sc.verifySuperAdminCredentials(email, password);
    check(upd.status === 200 && again.metadataClaimsSuperAdmin === true, 'the account flagged ITSELF super admin in its own metadata (anon key + own token): ' + upd.status);

    const superLogin = await fetch(ADMIN + '/api/admin/super-login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN }, body: JSON.stringify({ email, password }) });
    const cookie = superLogin.headers.get('set-cookie') || '';
    check(superLogin.status === 401 && !/goyunir_admin_device=[^;]{10,}/.test(cookie), 'POST admin.<root>/api/admin/super-login refuses it: ' + superLogin.status + (cookie ? ' (cookie: ' + cookie.slice(0, 40) + ')' : ''));
    const imp = await fetch(SALES + '/api/admin/impersonate', { method: 'POST', headers: { 'content-type': 'application/json', origin: SALES, 'x-staff-impersonate-tenant-id': TEST4 }, body: JSON.stringify({ email, password }) });
    check(imp.status === 401, 'POST sales.<root>/api/admin/impersonate refuses it: ' + imp.status);
    check((await sc.verifySuperAdminSignIn(email, password)) === null, 'verifySuperAdminSignIn (also used by step-up and setup) returns null');
  } finally {
    console.log('cleanup (account deleted): ' + (await deleteStaffAccount(email)));
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
