/**
 * ADMIN CROSS-TENANT GUARD CHECK (lib/default-tenant.ts). READ-ONLY.
 *   npx tsx scripts/verify-admin-tenant-guard.ts
 * Issues short-lived admin sessions exactly as a real sign-in does, makes one
 * GET each, and deletes them:
 *   test4's OWNER session       -> must be refused (403), app. and admin. hosts
 *   a legacy full-admin session -> the original store's own admin still works (200)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('../lib/redis-keys');
  const kv: any = createKvClient();
  const owner = ((await getDb().select<any>('users', { where: { tenant_id: eq('13591c9e-82e4-4c23-8d94-249cef6fa775'), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0];
  const identity = await readStaffIdentity(String(owner.email));
  const merchant = await issueAdminDevice(kv, String(owner.email), false, deviceMetaFor(identity!), 300);
  const legacy = await issueAdminDevice(kv, 'guard-probe@goyunir.invalid', false, {}, 300);
  const get = async (url: string, token: string) => {
    const res = await fetch(url, { headers: { cookie: 'goyunir_admin_device=' + token } });
    const body = await res.text();
    return { status: res.status, names: (body.match(/"name":"[^"]+"/g) || []).length, body: body.slice(0, 120) };
  };
  try {
    for (const host of ['app.goyunir.com', 'admin.goyunir.com']) {
      const r = await get('https://' + host + '/api/admin/products?includeArchived=true', merchant.token);
      check(r.status === 403 && r.names === 0, host + ' test4-owner session -> ' + r.status + ' ' + r.body);
    }
    const page = await get('https://app.goyunir.com/admin', merchant.token);
    check(page.status === 403, 'app.goyunir.com/admin page, test4-owner session -> ' + page.status);
    const own = await get('https://app.goyunir.com/api/admin/products?includeArchived=true', legacy.token);
    check(own.status === 200 && own.names > 0, 'original store\'s own admin session -> ' + own.status + ', ' + own.names + ' products');
  } finally {
    await kv.hdel(ADMIN_DEVICES_KEY, merchant.token);
    await kv.hdel(ADMIN_DEVICES_KEY, legacy.token);
    console.log('probe sessions deleted');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
