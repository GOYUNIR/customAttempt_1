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
