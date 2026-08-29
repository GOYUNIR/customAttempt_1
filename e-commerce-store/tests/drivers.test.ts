/**
 * Driver-engine unit tests (node --test).
 *
 * These exercise the SERVICE layer directly through relative imports — the
 * registry functions, drivers and config helpers contain ZERO `@/` imports by
 * design so `node --test` can load them without the Next.js alias resolution.
 *
 * Every driver accepts an injectable `fetchImpl` so request SHAPE is asserted
 * without any network I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmailDriver, EMAIL_DRIVER_CATALOG } from '../services/email/registry.ts';
import { createPaymentDriver, PAYMENT_DRIVER_CATALOG } from '../services/payment/registry.ts';
import { createMapDriver, MAP_DRIVER_CATALOG } from '../services/maps/registry.ts';
import {
  parseSettingsRow,
  toPublicSummary,
  sanitizeMailProvider,
  sanitizePaymentProvider,
  sanitizeMapProvider,
  MAIL_PROVIDERS,
  PAYMENT_PROVIDERS,
  MAP_PROVIDERS,
  GLOBAL_PLATFORM_SETTINGS_ROW_ID,
} from '../services/config/types.ts';
import { normalizePlatformSettingsInput } from '../services/config/platform-settings.ts';
import { replaceSessionPlaceholder } from '../services/payment/types.ts';

// ── config/types ─────────────────────────────────────────────────────────────

test('parseSettingsRow: normalizes a raw PostgREST row and sanitizes providers', () => {
  const row = parseSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    is_configured: true,
    mail_provider: 'postmark',
    mail_api_key: 'pm-token',
    payment_provider: 'lemon_squeezy',
    payment_api_key: 'ls-key',
    payment_webhook_secret: 'whsec_ignored_for_non_stripe',
    map_provider: 'open_street_map',
    map_api_key: '',
  });
  assert.ok(row);
  assert.equal(row!.is_configured, true);
  assert.equal(row!.mail_provider, 'postmark');
  assert.equal(row!.mail_api_key, 'pm-token');
  assert.equal(row!.payment_provider, 'lemon_squeezy');
  assert.equal(row!.payment_webhook_secret, null); // only meaningful for stripe
  assert.equal(row!.map_provider, 'open_street_map');
  assert.equal(row!.map_api_key, null);
});

test('parseSettingsRow: rejects garbage provider strings and null rows', () => {
  assert.equal(parseSettingsRow(null), null);
  assert.equal(parseSettingsRow(undefined), null);
  assert.equal(parseSettingsRow({}), null); // no id
  const row = parseSettingsRow({ id: 'abc', mail_provider: 'carrier-pigeon', payment_provider: 'cash', map_provider: 'atlas' });
  assert.ok(row);
  assert.equal(row!.mail_provider, null);
  assert.equal(row!.payment_provider, null);
  assert.equal(row!.map_provider, null);
});

test('sanitizers only accept the SQL-enumerated provider strings', () => {
  assert.equal(sanitizeMailProvider('RESEND'), 'resend');
  assert.equal(sanitizeMailProvider('postmark'), 'postmark');
  assert.equal(sanitizeMailProvider('sendgrid'), 'sendgrid');
  assert.equal(sanitizeMailProvider('gmail'), null);
  assert.equal(sanitizePaymentProvider('stripe'), 'stripe');
  assert.equal(sanitizePaymentProvider('lemon_squeezy'), 'lemon_squeezy');
  assert.equal(sanitizePaymentProvider('paddle'), 'paddle');
  assert.equal(sanitizePaymentProvider('paypal'), null);
  assert.equal(sanitizeMapProvider('mapbox'), 'mapbox');
  assert.equal(sanitizeMapProvider('google_maps'), 'google_maps');
  assert.equal(sanitizeMapProvider('open_street_map'), 'open_street_map');
  assert.equal(sanitizeMapProvider('here'), null);
});

test('toPublicSummary strips every secret — provider names only', () => {
  const summary = toPublicSummary(
    parseSettingsRow({
      id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
      is_configured: true,
      mail_provider: 'resend',
      mail_api_key: 're_secret',
      payment_provider: 'stripe',
      payment_api_key: 'sk_secret',
      payment_webhook_secret: 'whsec_secret',
      map_provider: 'mapbox',
      map_api_key: 'pk_secret',
    }),
  );
  const json = JSON.stringify(summary);
  assert.equal(summary.is_configured, true);
  assert.equal(summary.mail_provider, 'resend');
  assert.equal(summary.payment_provider, 'stripe');
  assert.equal(summary.map_provider, 'mapbox');
  assert.ok(!json.includes('re_secret'));
  assert.ok(!json.includes('sk_secret'));
  assert.ok(!json.includes('whsec_secret'));
  assert.ok(!json.includes('pk_secret'));
});

test('parseSettingsRow normalizes the default Stripe price ID', () => {
  const row = parseSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    payment_provider: 'stripe',
    payment_api_key: 'sk_1',
    stripe_price_id: '  price_abc  ',
  });
  assert.ok(row);
  assert.equal(row!.stripe_price_id, 'price_abc');
});

test('toPublicSummary exposes the default Stripe price ID (it is not a secret)', () => {
  const summary = toPublicSummary(
    parseSettingsRow({
      id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
      is_configured: true,
      payment_provider: 'stripe',
      payment_api_key: 'sk_secret',
      stripe_price_id: 'price_123abc',
    }),
  );
  assert.equal(summary.stripe_price_id, 'price_123abc');
});

test('normalizePlatformSettingsInput validates the wizard payload', () => {
  const good = normalizePlatformSettingsInput({
    mail_provider: 'sendgrid',
    mail_api_key: 'SG.key',
    payment_provider: 'paddle',
    payment_api_key: 'pl_key',
    payment_webhook_secret: '',
    map_provider: 'open_street_map',
    map_api_key: '',
    ai_provider: 'workers_ai',
    ai_api_key: '',
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.input.mail_provider, 'sendgrid');
    assert.equal(good.input.payment_provider, 'paddle');
    assert.equal(good.input.map_provider, 'open_street_map');
    assert.equal(good.input.map_api_key, undefined);
  }

  assert.equal(normalizePlatformSettingsInput({ mail_provider: 'nope', mail_api_key: 'x' }).ok, false);

// ── email drivers ────────────────────────────────────────────────────────────

test('email registry: createEmailDriver maps every catalog provider', () => {
  assert.equal(EMAIL_DRIVER_CATALOG.length, 3);
  for (const { provider } of EMAIL_DRIVER_CATALOG) {
    const driver = createEmailDriver(provider, 'test-key');
    assert.ok(driver);
    assert.equal(driver!.provider, provider);
    assert.equal(driver!.configured, true);
  }
  assert.equal(createEmailDriver('mailgun' as any, 'x'), null);
});

test('ResendDriver: send2FA posts to api.resend.com with the code in the subject', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const driver = createEmailDriver('resend', 're_test', {
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'res_123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  })!;
  const result = await driver.send2FA('user@example.com', '123456');
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.id, 'res_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('re_test'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.to[0], 'user@example.com');
  assert.ok(String(body.subject).includes('123456'));
  assert.ok(body.html.includes('123456'));
});

test('PostmarkDriver: sendTransactional uses the server-token header + postmark API shape', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const driver = createEmailDriver('postmark', 'pm-token', {
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ MessageID: 'pm_1' }), { status: 200 });
    }) as typeof fetch,
  })!;
  const result = await driver.sendTransactional({ to: 'a@b.co', from: 'Store <no-reply@store.com>', subject: 'Hi', html: '<b>hi</b>' });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.id, 'pm_1');
  assert.equal(calls[0].url, 'https://api.postmarkapp.com/email');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Postmark-Server-Token'], 'pm-token');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.From, 'Store <no-reply@store.com>');
  assert.equal(body.To, 'a@b.co');
  assert.equal(body.HtmlBody, '<b>hi</b>');
});

test('SendGridDriver: sendTransactional posts the v3 mail shape', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const driver = createEmailDriver('sendgrid', 'SG.key', {
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response('', { status: 202 });
    }) as typeof fetch,
  })!;
  const result = await driver.sendTransactional({ to: 'a@b.co', from: 'x@y.co', subject: 'S', html: '<p>1</p>' });
  assert.ok(result.ok);
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('SG.key'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.personalizations[0].to[0].email, 'a@b.co');
  assert.equal(body.content[0].value, '<p>1</p>');
});

test('email drivers: unconfigured keys skip instead of throwing', async () => {

// ── payment drivers ──────────────────────────────────────────────────────────

test('payment registry: createPaymentDriver maps every catalog provider', () => {
  assert.equal(PAYMENT_DRIVER_CATALOG.length, 3);
  for (const { provider } of PAYMENT_DRIVER_CATALOG) {
    const driver = createPaymentDriver(provider, 'key');
    assert.ok(driver);
    assert.equal(driver!.provider, provider);
    assert.equal(driver!.configured, true);
  }
  assert.equal(createPaymentDriver('braintree' as any, 'x'), null);
});

test('LemonSqueezyDriver: creates a checkout via JSON:API with custom_price', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const driver = createPaymentDriver('lemon_squeezy', 'ls-key', {
    storeId: '42',
    variantId: '7',
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ data: { id: 'chk_1', attributes: { url: 'https://store.ls/checkout/custom/chk_1' } } }),
        { status: 201 },
      );
    }) as typeof fetch,
  })!;
  const result = await driver.createCheckoutSession(1999, 'demo', { customerEmail: 'buyer@x.co', productName: 'Tee' });
  assert.equal(result.sessionId, 'chk_1');
  assert.ok(result.url.startsWith('https://store.ls'));
  assert.equal(calls[0].url, 'https://api.lemonsqueezy.com/v1/checkouts');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('ls-key'));
  assert.ok(headers.Accept.includes('vnd.api+json'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.data.type, 'checkouts');
  assert.equal(body.data.attributes.custom_price, 1999);
  assert.equal(body.data.relationships.store.data.id, '42');
  assert.equal(body.data.relationships.variant.data.id, '7');
});

test('LemonSqueezyDriver: throws when the store/variant id is missing', async () => {
  const driver = createPaymentDriver('lemon_squeezy', 'ls-key', {})!;
  await assert.rejects(() => driver.createCheckoutSession(100, 'demo'), /store id/i);
  const noVariant = createPaymentDriver('lemon_squeezy', 'ls-key', { storeId: '1' })!;
  await assert.rejects(() => noVariant.createCheckoutSession(100, 'demo'), /variant id/i);
});

test('PaddleDriver: creates a transaction and returns the hosted checkout url', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const driver = createPaymentDriver('paddle', 'pl-key', {
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ data: { id: 'txn_1', checkout: { url: 'https://checkout.paddle.com/transaction/txn_1' } } }),
        { status: 201 },
      );
    }) as typeof fetch,
  })!;
  const result = await driver.createCheckoutSession(5000, 'demo', {
    customerEmail: 'buyer@x.co',
    productName: 'Hoodie',
    successUrl: 'https://store.com/ok?session_id={CHECKOUT_SESSION_ID}',
  });
  assert.equal(calls[0].url, 'https://api.paddle.com/transactions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('pl-key'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.collection_mode, 'automatic');
  assert.equal(body.items[0].price.unit_price.amount, '5000');
  assert.equal(body.items[0].price.type, 'custom');
  assert.equal(body.customer.email, 'buyer@x.co');
  // driver substitutes its own session id into the return URL placeholder
  assert.equal(result.sessionId, 'txn_1');
  assert.ok(result.url.startsWith('https://checkout.paddle.com'));
});

test('replaceSessionPlaceholder substitutes every occurrence', () => {

// ── map drivers ──────────────────────────────────────────────────────────────

test('map registry: createMapDriver maps every catalog provider', () => {
  assert.equal(MAP_DRIVER_CATALOG.length, 3);
  const mapbox = createMapDriver('mapbox', 'pk_test')!;
  assert.equal(mapbox.provider, 'mapbox');
  assert.equal(mapbox.configured, true);
  assert.equal(mapbox.getToken(), 'pk_test');
  assert.ok(mapbox.getInitConfig().sdkUrl!.includes('api.mapbox.com/search-js'));

  const google = createMapDriver('google_maps', 'AIza')!;
  assert.equal(google.provider, 'google_maps');
  assert.ok(google.getInitConfig().sdkUrl!.includes('maps.googleapis.com'));
  assert.ok(google.getInitConfig().sdkUrl!.includes(encodeURIComponent('AIza')));

  const osm = createMapDriver('open_street_map')!;
  assert.equal(osm.configured, true); // OSM is always usable
  assert.equal(osm.getToken(), '');
  assert.ok(String(osm.getInitConfig().options!.endpoint).includes('nominatim'));

  assert.equal(createMapDriver('here' as any), null);
});

test('mapbox driver is not configured without a token', () => {
  const mapbox = createMapDriver('mapbox', '');
  assert.ok(mapbox && mapbox.configured === false);
});

// ── catalog sanity (all provider enums line up) ──────────────────────────────

test('provider enum lists match the SQL check constraints', () => {
  assert.deepEqual([...MAIL_PROVIDERS].sort(), ['postmark', 'resend', 'sendgrid'].sort());
  assert.deepEqual([...PAYMENT_PROVIDERS].sort(), ['lemon_squeezy', 'paddle', 'stripe'].sort());
  assert.deepEqual([...MAP_PROVIDERS].sort(), ['google_maps', 'mapbox', 'open_street_map'].sort());
});

  assert.equal(
    replaceSessionPlaceholder('https://s/?a={CHECKOUT_SESSION_ID}&b={CHECKOUT_SESSION_ID}', 'abc'),
    'https://s/?a=abc&b=abc',
  );
  assert.equal(replaceSessionPlaceholder('https://s/', 'abc'), 'https://s/');
});

  const driver = createEmailDriver('resend', '');
  assert.ok(driver && driver.configured === false);
  const result = await driver!.send2FA('a@b.co', '000000');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.skipped, true);
});

  assert.equal(normalizePlatformSettingsInput({ mail_provider: 'resend', mail_api_key: '' }).ok, false);
  assert.equal(
    normalizePlatformSettingsInput({ mail_provider: 'resend', mail_api_key: 'x', payment_provider: 'stripe', payment_api_key: 'y', map_provider: 'mapbox', map_api_key: '' }).ok,
    false,
  );
  const oms = normalizePlatformSettingsInput({ mail_provider: 'resend', mail_api_key: 'x', payment_provider: 'stripe', payment_api_key: 'y', map_provider: 'open_street_map', ai_provider: 'workers_ai' });
  assert.ok(oms.ok);
});
