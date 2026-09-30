/**
 * DEMO STORE CONTENT (Demo Parfums): its own products, descriptions and
 * code-generated placeholder photos, uploaded through the merchant photo path
 * exactly as the owner's dashboard would. Nothing from GOYUNIR appears on it.
 *
 *   npx tsx scripts/seed-demo-store.ts
 *
 * Idempotent: products that already exist (same web address) are left alone.
 * The earlier copies of GOYUNIR's products are set to Draft (hidden; their
 * past orders stay intact). Real photos can replace the placeholders later.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.goyunir.com';
const DEMO = '3b6f7db1-7645-4c52-aefe-cc8be563c359';

const PRODUCTS = [
  {
    slug: 'salt-meridian', name: 'Salt Meridian', tagline: 'Sea air, warm skin, late light.',
    description: 'A clean marine accord over ambrette and sun-warmed driftwood. Bright at first, then quietly close to the skin for hours.',
    hue: 196, isActive: true,
    sizes: [{ size: '50ml', price: 148, mode: 'FCFS', stock: 12 }, { size: '10ml discovery', price: 24, mode: 'FCFS', stock: 30 }],
  },
  {
    slug: 'ember-orchard', name: 'Ember Orchard', tagline: 'Smoked fig and a fire going out.',
    description: 'Black fig, cedar smoke and a little burnt sugar. A small batch: the 50ml is drawn by raffle, the discovery size ships now.',
    hue: 18, isActive: true, raffle: true,
    sizes: [{ size: '50ml', price: 180, mode: 'RAFFLE', stock: 4, winners: 2 }, { size: '10ml discovery', price: 24, mode: 'FCFS', stock: 30 }],
  },
];

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const owner = ((await getDb().select<any>('users', { where: { tenant_id: eq(DEMO), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0]?.email;
  if (!owner) throw new Error('the demo store has no owner yet');
  const tok = (await issueAdminDevice(createKvClient() as any, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 600)).token;
  const h = (extra: Record<string, string> = {}) => ({ origin: APP, cookie: 'goyunir_admin_device=' + tok, ...extra });
  const list = async () => ((await (await fetch(APP + '/api/merchant/products', { headers: h() })).json()).products || []) as any[];

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const draw = async (name: string, tagline: string, hue: number, variant: number): Promise<Uint8Array> => {
    const url: string = await page.evaluate(`(() => {
      var c = document.createElement('canvas'); c.width = 900; c.height = 1125; var g = c.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 900, 1125);
      grad.addColorStop(0, 'hsl(${hue}, 38%, ${variant ? 22 : 30}%)'); grad.addColorStop(1, 'hsl(${(hue + 40) % 360}, 45%, ${variant ? 48 : 62}%)');
      g.fillStyle = grad; g.fillRect(0, 0, 900, 1125);
      g.fillStyle = 'rgba(255,255,255,0.14)'; g.beginPath(); g.ellipse(450, ${variant ? 700 : 600}, 190, 300, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(390, ${variant ? 360 : 260}, 120, 70);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 58px Georgia, serif'; g.fillText(${JSON.stringify(name)}, 450, 1000);
      g.font = 'italic 28px Georgia, serif'; g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillText(${JSON.stringify(tagline)}, 450, 1050);
      return c.toDataURL('image/jpeg', 0.9); })()`);
    return new Uint8Array(Buffer.from(url.split(',')[1], 'base64'));
  };

  const existing = await list();
  for (const p of PRODUCTS) {
    if (existing.some((e) => e.slug === p.slug)) { console.log('exists, left alone: ' + p.slug); continue; }
    const images: string[] = [];
    for (const v of [0, 1]) {
      const fd = new FormData(); fd.append('file', new Blob([(await draw(p.name, p.tagline, p.hue, v)) as any], { type: 'image/jpeg' }), p.slug + '-' + v + '.jpg');
      const up: any = await (await fetch(APP + '/api/merchant/media', { method: 'POST', headers: h(), body: fd })).json();
      if (!up.url) throw new Error('upload failed: ' + JSON.stringify(up));
      images.push(up.url);
    }
    const body = {
      name: p.name, slug: p.slug, tagline: p.tagline, description: p.description, isActive: p.isActive, isUpcoming: false,
      releaseEndsAt: p.raffle ? new Date(Date.now() + 10 * 86_400_000).toISOString() : '', maxPerEmail: 2, sizes: p.sizes, images,
    };
    const r = await fetch(APP + '/api/merchant/products', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    console.log('created ' + p.slug + ': ' + r.status + ' ' + (await r.text()).slice(0, 100));
  }
  // The earlier GOYUNIR copies: Draft (hidden), orders kept.
  for (const e of await list()) {
    if (!['roccstar', 'black-solstice'].includes(e.slug) || (!e.isActive && !e.isUpcoming)) continue;
    const payload = { id: e.id, name: e.name, slug: e.slug, tagline: e.tagline, description: e.description, isActive: false, isUpcoming: false, releaseEndsAt: e.releaseEndsAt || '', maxPerEmail: e.maxPerEmail, sizes: e.sizes.map((s: any) => ({ size: s.size, price: Number(s.price), mode: s.mode, ...(s.winners ? { winners: Number(s.winners) } : {}) })) };
    const r = await fetch(APP + '/api/merchant/products', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify(payload) });
    console.log('set to draft: ' + e.slug + ' ' + r.status);
  }
  await browser.close();
  console.log('now public: ' + (await list()).filter((p) => p.isActive).map((p) => p.slug).join(', '));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
