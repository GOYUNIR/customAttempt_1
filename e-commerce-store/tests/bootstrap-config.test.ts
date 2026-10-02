import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs } from '../scripts/bootstrap/inputs.ts';
import { wranglerConfig, wranglerConfigText } from '../scripts/bootstrap/wrangler-config.ts';
import { SECRETS, checkSecrets } from '../scripts/bootstrap/secrets-manifest.ts';

// A made-up platform: nothing of the current stand-in identity may appear.
const FAKE = { name: 'Larkspur Commerce', domain: 'larkspur.example', cloudflareAccountId: 'acc123', adminEmail: 'owner@larkspur.example' };

test('inputs: defaults follow the name and domain; bad input is refused with reasons', () => {
  const i = resolveInputs(FAKE);
  assert.equal(i.supportEmail, 'support@larkspur.example');
  assert.equal(i.alertEmail, 'support@larkspur.example');
  assert.equal(i.sendingFrom, 'Larkspur Commerce <notifications@larkspur.example>');
  assert.equal(i.worker, 'larkspur-platform');
  assert.equal(i.mediaBucket, 'larkspur-platform-media');
  assert.equal(resolveInputs({ ...FAKE, alertEmail: 'ops@larkspur.example' }).alertEmail, 'ops@larkspur.example');
  assert.throws(() => resolveInputs({ domain: 'larkspur.example' }), /name is required/);
  assert.throws(() => resolveInputs({ name: 'X', domain: 'not a domain' }), /domain must look like/);
  assert.throws(() => resolveInputs({ ...FAKE, oldRootDomains: 'bad domain' }), /not a domain/);
});

test('wrangler config: every name, domain and address comes from the inputs', () => {
  const text = wranglerConfigText(resolveInputs(FAKE));
  assert.ok(!/goyunir/i.test(text), 'no trace of the stand-in identity');
  const c: any = wranglerConfig(resolveInputs(FAKE));
  assert.equal(c.name, 'larkspur-platform');
  assert.deepEqual(c.routes.map((r: any) => r.pattern), ['larkspur.example/*', '*.larkspur.example/*']);
  assert.equal(c.vars.PLATFORM_NAME, 'Larkspur Commerce');
  assert.equal(c.vars.PLATFORM_ROOT_DOMAIN, 'larkspur.example');
  assert.equal(c.vars.SUPPORT_EMAIL, 'support@larkspur.example');
  assert.equal(c.vars.OPERATOR_ALERT_EMAIL, 'support@larkspur.example');
  assert.equal(c.vars.EMAIL_SINK_DOMAINS, 'proof.larkspur.example');
  assert.equal(c.vars.MEDIA_S3_PUBLIC_BASE_URL, 'https://media.larkspur.example/media/r2');
  assert.equal(c.vars.STOREFRONT_SSR, 'off', 'new features start off');
  assert.equal(c.vars.ALLOW_MERCHANT_SIGNUP, 'false', 'signup starts off');
  assert.equal(c.vars.PLATFORM_MARKETING_ROOT, 'true', 'the root is the platform site');
  for (const v of Object.values(c.vars)) assert.ok(!/sk_|whsec_|re_[A-Za-z0-9]{8}/.test(String(v)), 'no secret-shaped value in vars');
});

test('wrangler config: old roots keep answering (301) and are named as old', () => {
  const c: any = wranglerConfig(resolveInputs({ ...FAKE, oldRootDomains: 'old-stand-in.example' }));
  assert.deepEqual(c.routes.map((r: any) => r.pattern), ['larkspur.example/*', '*.larkspur.example/*', 'old-stand-in.example/*', '*.old-stand-in.example/*']);
  assert.equal(c.vars.PLATFORM_OLD_ROOT_DOMAINS, 'old-stand-in.example');
});

test('secrets: the checker reports names and places only, and every required one', () => {
  const none = checkSecrets({ worker: new Set(), database: new Set(), local: new Set() });
  assert.equal(none.missingRequired.length, SECRETS.filter((s) => s.required).length);
  const all = checkSecrets({ worker: new Set(SECRETS.filter((s) => s.place === 'worker').map((s) => s.name)), database: new Set(SECRETS.filter((s) => s.place === 'database').map((s) => s.column!)), local: new Set() });
  assert.deepEqual(all.missingRequired, []);
  for (const c of all.checks) assert.deepEqual(Object.keys(c).sort(), ['name', 'place', 'present', 'required'], 'no value field exists to leak');
});
