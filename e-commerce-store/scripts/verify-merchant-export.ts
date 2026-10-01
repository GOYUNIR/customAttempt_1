/**
 * DATA EXPORT, live: each store gets exactly its own products, orders (with
 * lines) and customers (with consent), across pages, as CSV and JSON; nothing
 * of another store; owner only; audited.
 *
 *   npx tsx scripts/verify-merchant-export.ts
 *
 * Sets `export.page_rows` to 10 for the run (so paging is exercised) and
 * removes it afterwards.
 */
import { ROOT, ROOT_RE, SUPPORT_EMAIL } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

const APP = 'https://app.' + ROOT;
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq, gte } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const kv: any = createKvClient();
  const db = getDb();
  const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const get = async (q: string, tok: string | null) => {
    const r = await fetch(APP + '/api/merchant/export?' + q, { headers: { origin: APP, ...(tok ? { cookie: 'goyunir_admin_device=' + tok } : {}) } });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };
  /** The whole export, page by page, as the dashboard does it. */
  const all = async (tok: string, dataset: string, format: 'csv' | 'json', extra = '') => {
    const out: { csv: string; rows: any[]; pages: number } = { csv: '', rows: [], pages: 0 };
    for (let page = 0; page < 1000; page++) {
      const r = await get('dataset=' + dataset + '&format=' + format + '&page=' + page + extra, tok);
      if (r.status !== 200) throw new Error(dataset + ' page ' + page + ': ' + r.status + ' ' + JSON.stringify(r.body));
      out.pages++;
      if (format === 'csv') out.csv += r.body.csv; else out.rows.push(...r.body.rows);
      if (!r.body.more) break;
    }
    return out;
  };
  const csvColumn = (csv: string, col: string) => {
    const lines = csv.split('\r\n').filter(Boolean);
    const idx = lines[0].split(',').indexOf(col);
    // The proof data has no commas or quotes in these columns.
    return lines.slice(1).map((l) => l.split(',')[idx]);
  };
  const startedAt = new Date(Date.now() - 5000).toISOString();
  await db.insert('platform_policies', { key: 'export.page_rows', value: 10, description: 'Rows per export page (verify-merchant-export sets this temporarily).' }, { onConflict: 'key', returning: 'minimal' } as any);

  try {
    for (const [name, tenant, tok, other] of [['test4', A, sA, B], ['store B', B, sB, A]] as const) {
      console.log('\n' + name);
      const dbOrders = ((await db.select<any>('orders', { where: { tenant_id: eq(tenant) }, select: ['order_ref'], limit: 10000 })) as any[]).map((o) => o.order_ref);
      const otherOrders = new Set(((await db.select<any>('orders', { where: { tenant_id: eq(other) }, select: ['order_ref'], limit: 10000 })) as any[]).map((o) => o.order_ref));
      const oj = await all(tok, 'orders', 'json');
      check(same(oj.rows.map((r) => r.order_ref), dbOrders), 'orders (JSON, ' + oj.pages + ' page(s)): exactly its ' + dbOrders.length + ' orders, each once');
      check(!oj.rows.some((r) => otherOrders.has(r.order_ref)), 'none of the other store\'s orders');
      check(oj.rows.every((r) => Array.isArray(r.lines) && r.lines.length >= 1), 'every order carries its lines');
      const oc = await all(tok, 'orders', 'csv', '&tenantId=' + other + '&tenant_id=' + other);
      check(same([...new Set(csvColumn(oc.csv, 'order_ref'))], dbOrders), 'orders (CSV, the other store\'s id smuggled in the query): still exactly its own');

      const dbCustomers = ((await db.select<any>('customers', { where: { tenant_id: eq(tenant) }, select: ['email', 'email_opt_in'], limit: 10000 })) as any[]);
      const otherCustomers = new Set(((await db.select<any>('customers', { where: { tenant_id: eq(other) }, select: ['email'], limit: 10000 })) as any[]).map((c) => c.email));
      const cj = await all(tok, 'customers', 'json');
      check(same(cj.rows.map((r) => r.email), dbCustomers.map((c) => c.email)), 'customers: exactly its ' + dbCustomers.length + ' customers');
      const onlyHere = cj.rows.filter((r) => otherCustomers.has(r.email));
      const optIn = new Map(dbCustomers.map((c) => [c.email, c.email_opt_in]));
      check(cj.rows.every((r) => r.marketing_consent === (optIn.get(r.email) === true ? 'opted_in' : optIn.get(r.email) === false ? 'declined' : 'never_asked')), 'marketing consent matches each record (never asked is not declined)');
      // The same person may buy from both stores (a customer of each). Their
      // order count here must be THIS store's paid orders only.
      const custRows = (await db.select<any>('customers', { where: { tenant_id: eq(tenant) }, select: ['id', 'email'], limit: 10000 })) as any[];
      const paid = (await db.select<any>('orders', { where: { tenant_id: eq(tenant) }, select: ['customer_id', 'payment_status'], limit: 10000 })) as any[];
      const countOf = (email: string) => { const id = custRows.find((c) => c.email === email)?.id; return paid.filter((o) => o.customer_id === id && (o.payment_status === 'paid' || o.payment_status === 'partially_refunded')).length; };
      check(cj.rows.every((r) => r.orders === countOf(r.email)), 'each customer\'s order count is this store\'s alone (' + onlyHere.length + ' also buy from the other store)');

      const dbVariants = ((await db.select<any>('product_variants', { where: { tenant_id: eq(tenant) }, select: ['id'], limit: 10000 })) as any[]).length;
      const pc = await all(tok, 'products', 'csv');
      check(csvColumn(pc.csv, 'product_id').length === dbVariants, 'products (CSV): one row per size, ' + dbVariants + ' in all');
    }

    console.log('\nWho may export');
    check((await get('dataset=customers&format=json&page=0', null)).status === 401, 'no session: 401');
    // A temporary staff member of test4, through the real invite + accept
    // flow, removed again through the owner's own route.
    const { createInvite } = await import('../lib/staff-invites');
    const staffEmail = 'export-staff-' + Date.now() + '@goyunir.invalid';
    const inv: any = await createInvite({ email: staffEmail, role: 'staff', tenantId: A, invitedByEmail: ownerA });
    const acc = await fetch(APP + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify({ token: inv.token, password: 'Exp-' + crypto.randomUUID() + '-Aa1!' }) });
    const idS = await readStaffIdentity(staffEmail);
    check(acc.status === 200 && idS?.role === 'staff', 'a test4 staff member (real accept route): ' + acc.status);
    try {
      const sS = (await issueAdminDevice(kv, staffEmail, false, deviceMetaFor(idS!), 900)).token;
      for (const ds of ['customers', 'orders', 'products']) check((await get('dataset=' + ds + '&format=json&page=0', sS)).status === 403, 'staff exporting ' + ds + ': 403 (owner only)');
    } finally {
      const rm = await fetch(APP + '/api/merchant/staff/remove', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP, cookie: 'goyunir_admin_device=' + sA }, body: JSON.stringify({ email: staffEmail }) });
      check(rm.status === 200, 'the temporary staff member is removed again');
    }
    check((await get('dataset=tenants&format=json&page=0', sA)).status === 400, 'an unknown dataset: 400');
    check((await get('dataset=orders&format=xml&page=0', sA)).status === 400, 'an unknown format: 400');

    console.log('\nAudit');
    const audit = (await db.select<any>('audit_logs', { where: { action: eq('MERCHANT_DATA_EXPORTED'), created_at: gte(startedAt) }, select: ['tenant_id', 'actor', 'detail'], limit: 100 })) as any[];
    check(audit.filter((a) => a.tenant_id === A).length >= 4 && audit.filter((a) => a.tenant_id === B).length >= 4, 'each export start is audited against its own store (' + audit.length + ' rows)');
    check(audit.every((a) => (a.tenant_id === A && a.actor === ownerA) || (a.tenant_id === B && a.actor === B_OWNER)), 'by that store\'s owner');
  } finally {
    await db.remove('platform_policies', { where: { key: eq('export.page_rows') } }).catch(() => null);
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
