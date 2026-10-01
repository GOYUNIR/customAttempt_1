/**
 * CORE JOURNEY PROOF, live on production, through the real UI and real email.
 *
 *   npx tsx scripts/verify-core-journey.ts
 *
 * The "working version" bar: nobody hits a dead end or a lie on the path
 *   a store owner invites staff (dashboard Staff tab)
 *   -> the invitation email arrives (Resend test inbox, read back)
 *   -> the invitee sets a password on the accept page
 *   -> signs in at the merchant portal: password, then the emailed 6-digit code
 *   -> lands on the store's dashboard, as staff
 * and the same for a sales rep at the sales portal. The owner invite for a new
 * store is the same accept page (proven by the demo store's owner). The
 * platform-admin sign-in needs the owner's super-admin password, so it is not
 * automated; its form and refusal are checked.
 *
 * Writes, and removes at the end: one staff account on test4, one sales
 * account (both on the sink domain: recorded, never sent).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium, type Page } from 'playwright-core';
import { CHROME } from './mobile-audit';
import { sentTo, testInbox } from './resend-readback';

const APP = 'https://app.goyunir.com';
const SALES = 'https://sales.goyunir.com';
const ADMIN = 'https://admin.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);
const password = 'Journey-' + crypto.randomUUID() + '-Aa1!';

const bodyOf = (m: any) => String(m?.html || m?.text || '');
const acceptLink = (m: any) => (bodyOf(m).match(/https:\/\/[a-z0-9.-]+\/admin\/accept-invite\?token=[0-9a-f]+/i) || [])[0] || '';
const codeIn = (m: any) => (String(m?.text || bodyOf(m).replace(/<[^>]+>/g, ' ')).match(/\b(\d{6})\b/) || [])[1] || '';

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { deleteStaffAccount } = await import('../lib/staff-accounts');
  const kv: any = createKvClient();
  const db = getDb();
  const staffEmail = testInbox('journeystaff' + run);
  const salesEmail = testInbox('journeysales' + run);
  const owner = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sOwner = (await issueAdminDevice(kv, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 900)).token;
  const sSuper = (await issueAdminDevice(kv, 'journey-proof-super@goyunir.invalid', false, { superAdmin: true }, 900)).token;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // Sign in through the real form: password, then the emailed code.
  const signIn = async (page: Page, base: string, email: string, homeRe: RegExp) => {
    const since = Date.now();
    await page.goto(base + (base === APP ? '/app/login' : base === SALES ? '/sales/login' : '/admin/login'), { waitUntil: 'load' });
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    const codeBox = page.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
    const reached = await codeBox.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (!reached) {
      check(false, 'the code step appeared after the password (page said: ' + JSON.stringify((await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)) + ' at ' + page.url() + ')');
      return page.url();
    }
    const mails = (await sentTo(getDb, email, { waitMs: 60_000 })).filter((m: any) => Date.parse(m.created_at) >= since - 5000 && /code|sign/i.test(String(m.subject)));
    const code = codeIn(mails[0]);
    check(/^\d{6}$/.test(code), 'the sign-in code email arrived: "' + (mails[0]?.subject || 'none') + '"');
    await codeBox.fill(code);
    const confirm = page.getByRole('button', { name: /verify|confirm|continue|sign in/i }).last();
    await confirm.click();
    await page.waitForURL(homeRe, { timeout: 30_000 }).catch(() => {});
    return page.url();
  };

  try {
    // ── 1. Owner invites staff from the dashboard (real UI) ─────────────────
    console.log('\nStaff: invite → email → set password → sign in');
    const ownerCtx = await browser.newContext();
    await ownerCtx.addCookies([{ name: 'goyunir_admin_device', value: sOwner, domain: 'app.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const op = await ownerCtx.newPage();
    await op.goto(APP + '/app', { waitUntil: 'load' });
    await op.getByRole('button', { name: /^Staff$/ }).click();
    await op.getByLabel('Email to invite').fill(staffEmail);
    await op.getByRole('button', { name: 'Send invitation' }).click();
    const notice = await op.getByRole('status').first().innerText({ timeout: 15_000 }).catch(() => '');
    check(/invit/i.test(notice), 'the dashboard confirms the invitation: ' + JSON.stringify(notice.slice(0, 80)));
    const invite = (await sentTo(getDb, staffEmail, { waitMs: 60_000 }))[0];
    const link = acceptLink(invite);
    check(Boolean(link), 'the invitation email arrived with an accept link: "' + (invite?.subject || 'none') + '"');

    // ── 2. Accept on the real page ──────────────────────────────────────────
    const sp = await (await browser.newContext()).newPage();
    await sp.goto(link, { waitUntil: 'load' });
    const pw = sp.locator('input[type="password"]');
    await pw.first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill(password);
    await sp.getByRole('button', { name: /accept|create|set|continue|join/i }).first().click();
    await sp.waitForTimeout(4000);
    const idS = await readStaffIdentity(staffEmail);
    check(idS?.tenantId === A && idS?.role === 'staff', 'accepting created a staff login for test4: ' + JSON.stringify({ tenant: idS?.tenantId === A, role: idS?.role }));

    // ── 3. Sign in at the merchant portal ───────────────────────────────────
    const staffHome = await signIn(sp, APP, staffEmail, /\/app($|\?|#)/);
    await sp.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 30_000 }).catch(() => {});
    const dash = (await sp.locator('body').innerText({ timeout: 20_000 }).catch(() => '')).replace(/\s+/g, ' ');
    if (!/test4/.test(dash)) console.log('    dashboard text: ' + dash.slice(0, 300));
    check(/\/app/.test(staffHome) && /test4/.test(dash) && /· staff/.test(dash), 'signed in: the staff member lands on test4\'s dashboard as staff (' + staffHome + ')');

    // ── 4. Sales rep: invite → accept → sign in at the sales portal ─────────
    console.log('\nSales: invite → email → set password → sign in');
    const inv = await fetch(ADMIN + '/api/admin/staff-invites', { method: 'POST', headers: { origin: ADMIN, cookie: 'goyunir_admin_device=' + sSuper, 'content-type': 'application/json' }, body: JSON.stringify({ email: salesEmail, role: 'sales' }) });
    check(inv.ok, 'a platform admin invites a sales rep: ' + inv.status);
    const sInvite = (await sentTo(getDb, salesEmail, { waitMs: 60_000 }))[0];
    const sLink = acceptLink(sInvite);
    check(Boolean(sLink) && /sales\./.test(sLink), 'the sales invitation links to the sales portal: ' + (sLink ? new URL(sLink).host : 'none'));
    const rp = await (await browser.newContext()).newPage();
    await rp.goto(sLink, { waitUntil: 'load' });
    const rpw = rp.locator('input[type="password"]');
    await rpw.first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < await rpw.count(); i++) await rpw.nth(i).fill(password);
    await rp.getByRole('button', { name: /accept|create|set|continue|join/i }).first().click();
    await rp.waitForTimeout(4000);
    console.log('    after accepting, the sales page shows: ' + JSON.stringify((await rp.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200)) + ' at ' + rp.url());
    const salesHome = await signIn(rp, SALES, salesEmail, /\/sales($|\?|#)/);
    const hub = (await rp.locator('body').innerText({ timeout: 20_000 }).catch(() => '')).replace(/\s+/g, ' ');
    check(/\/sales/.test(salesHome) && /Quote Builder/.test(hub), 'signed in: the rep lands on the Sales Hub, on Quote Builder (' + salesHome + ')');

    // ── 5. Admin portal: form and refusal (the owner's credentials are theirs) ─
    console.log('\nAdmin portal');
    const ap = await (await browser.newContext()).newPage();
    await ap.goto(ADMIN + '/admin/login', { waitUntil: 'load' });
    await ap.locator('input[type="email"]').first().fill('nobody-' + run + '@goyunir.invalid');
    await ap.locator('input[type="password"]').first().fill('wrong-password-' + run);
    await ap.getByRole('button', { name: /^Sign in$/ }).click();
    await ap.waitForTimeout(3000);
    const refusal = (await ap.locator('body').innerText()).replace(/\s+/g, ' ');
    check(/credential|incorrect|invalid|failed|wrong/i.test(refusal) && /\/admin\/login/.test(ap.url()), 'wrong credentials are refused on the admin sign-in, with a message');
  } finally {
    for (const e of [staffEmail, salesEmail]) await deleteStaffAccount(e).catch(() => false);
    console.log('\ncleanup: journey staff and sales accounts removed: ' + JSON.stringify(await Promise.all([readStaffIdentity(staffEmail), readStaffIdentity(salesEmail)]).then((r) => r.map((x) => x === null))));
    await browser.close();
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
