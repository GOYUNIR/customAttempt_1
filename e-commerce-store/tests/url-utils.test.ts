import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSiteBase } from '../lib/url-utils.ts';

test('normalizeSiteBase returns a clean absolute base for valid values', () => {
  const original = { ...process.env };
  try {
    delete process.env.NEXT_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SITE_URL;

    assert.equal(normalizeSiteBase('https://store.example.com/'), 'https://store.example.com');
    assert.equal(normalizeSiteBase('http://localhost:3000/'), 'http://localhost:3000');
    // Bare domain is promoted to https.
    assert.equal(normalizeSiteBase('goyunir.com'), 'https://goyunir.com');
    assert.equal(normalizeSiteBase('store.example.com'), 'https://store.example.com');
    // Empty falls back through env → example.com.
    assert.equal(normalizeSiteBase(''), 'https://example.com');
    assert.equal(normalizeSiteBase(undefined), 'https://example.com');
  } finally {
    process.env = { ...original };
  }
});

test('normalizeSiteBase never emits a broken https:/// link', () => {
  const original = { ...process.env };
  try {
    delete process.env.NEXT_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SITE_URL;

    for (const broken of ['https://', 'https:', 'http:', 'a image url', 'some text with spaces']) {
      const base = normalizeSiteBase(broken);
      const link = `${base}/auth/signup`;
      assert.equal(link.startsWith('https:///'), false, `link must not start with https:/// (got ${link})`);
      assert.equal(link.startsWith('http:///'), false, `link must not start with http:/// (got ${link})`);
      assert.equal(link, 'https://example.com/auth/signup', `broken input "${broken}" should fall back (got ${link})`);
    }
  } finally {
    process.env = { ...original };
  }
});

test('normalizeSiteBase rejects Vercel placeholder tokens so OG URLs never point at a nonexistent host', () => {
  const original = { ...process.env };
  try {
    delete process.env.NEXT_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.SITE_URL;
    // `$vercel_project_production_url` parses as a "valid" URL host, so without
    // the guard the og:image URL became https://$vercel_project_production_url/og
    // and messengers could never fetch the card.
    for (const placeholder of [
      '$vercel_project_production_url',
      'https://$vercel_project_production_url',
      '$VERCEL_PROJECT_PRODUCTION_URL',
      'https://$VERCEL_URL',
    ]) {
      assert.equal(
        normalizeSiteBase(placeholder),
        'https://example.com',
        `normalizeSiteBase(${JSON.stringify(placeholder)}) must fall back`,
      );
    }
    // A healthy configured value still wins once the env placeholder is gone.
    assert.equal(normalizeSiteBase('goyunir.com'), 'https://goyunir.com');
  } finally {
    process.env = { ...original };
  }
});
