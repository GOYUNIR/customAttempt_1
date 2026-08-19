import assert from 'node:assert/strict';
import test from 'node:test';
import { getSiteUrl, getBrandName, getSupportEmail, neutralBrandName, fallbackSiteUrl } from '../lib/env.ts';

test('site URL prefers NEXT_PUBLIC_URL over the older aliases', () => {
  const original = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_URL = 'https://acme.example/';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://other.example';
    process.env.SITE_URL = 'https://third.example';
    assert.equal(getSiteUrl(), 'https://acme.example');

    process.env.NEXT_PUBLIC_URL = '';
    assert.equal(getSiteUrl(), 'https://other.example');
    process.env.NEXT_PUBLIC_SITE_URL = '';
    assert.equal(getSiteUrl(), 'https://third.example');
    delete process.env.SITE_URL;
    assert.equal(getSiteUrl(), '');
    assert.equal(fallbackSiteUrl(), 'https://example.com');
  } finally {
    process.env = { ...original };
  }
});

test('brand + support helpers respect aliases and neutral fallbacks', () => {
  const original = { ...process.env };
  try {
    process.env.BRAND_NAME = 'Acme';
    process.env.NEXT_PUBLIC_SITE_NAME = 'Other';
    assert.equal(getBrandName(), 'Acme');
    delete process.env.BRAND_NAME;
    assert.equal(getBrandName(), 'Other');
    delete process.env.NEXT_PUBLIC_SITE_NAME;
    assert.equal(getBrandName(), '');
    assert.equal(neutralBrandName(), 'Store');

    process.env.SUPPORT_EMAIL = 'support@acme.example';
    assert.equal(getSupportEmail(), 'support@acme.example');
  } finally {
    process.env = { ...original };
  }
});

test('getSiteUrl rejects malformed values that would build https:/// links', () => {
  const original = { ...process.env };
  try {
    for (const broken of ['https://', 'https:', 'http:', 'a image url', 'goyunir.com', 'not a url']) {
      process.env.NEXT_PUBLIC_URL = broken;
      process.env.NEXT_PUBLIC_SITE_URL = '';
      delete process.env.SITE_URL;
      assert.equal(getSiteUrl(), '', `getSiteUrl(${JSON.stringify(broken)}) must be empty`);
    }
    // Valid scheme + host is kept (path/port preserved, trailing slash removed).
    process.env.NEXT_PUBLIC_URL = 'https://store.example.com/path/';
    assert.equal(getSiteUrl(), 'https://store.example.com');
  } finally {
    process.env = { ...original };
  }
});

test('getSiteUrl rejects Vercel dashboard env placeholders that leak into values', () => {
  const original = { ...process.env };
  try {
    // The exact failure seen live: an env var holds the dashboard's placeholder
    // text (never expanded), and the URL parser ACCEPTS `$` as a hostname char,
    // so without this guard og:image/canonical URLs pointed at a nonexistent
    // `https://$vercel_project_production_url` domain and link previews broke.
    for (const placeholder of [
      '$vercel_project_production_url',
      'https://$vercel_project_production_url',
      '$VERCEL_PROJECT_PRODUCTION_URL',
      'https://$VERCEL_URL',
      'https://sub.$env_domain.example.com',
    ]) {
      process.env.NEXT_PUBLIC_URL = placeholder;
      process.env.NEXT_PUBLIC_SITE_URL = '';
      delete process.env.SITE_URL;
      assert.equal(getSiteUrl(), '', `getSiteUrl(${JSON.stringify(placeholder)}) must be empty`);
    }
    // The Vercel system-var fallback is also placeholder-safe.
    process.env.NEXT_PUBLIC_URL = '';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.SITE_URL = '$vercel_project_production_url';
    assert.equal(getSiteUrl(), '');
  } finally {
    process.env = { ...original };
  }
});

test('getSiteUrl falls back to platform system variables when no URL is configured', () => {
  const original = { ...process.env };
  try {
    const clearExplicit = () => {
      process.env.NEXT_PUBLIC_URL = '';
      process.env.NEXT_PUBLIC_SITE_URL = '';
      delete process.env.SITE_URL;
    };
    const clearPlatform = () => {
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      delete process.env.VERCEL_URL;
      delete process.env.URL;
      delete process.env.DEPLOY_URL;
      delete process.env.CF_PAGES_URL;
    };

    // Vercel: bare hostname is normalized to https.
    clearExplicit();
    clearPlatform();
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'goyunir.com';
    assert.equal(getSiteUrl(), 'https://goyunir.com');

    // Vercel per-deployment URL is the next fallback.
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = 'myapp-abc123.vercel.app';
    assert.equal(getSiteUrl(), 'https://myapp-abc123.vercel.app');

    // Netlify: full https URL is kept.
    clearPlatform();
    process.env.URL = 'https://my-store.netlify.app';
    assert.equal(getSiteUrl(), 'https://my-store.netlify.app');

    // Netlify deploy-specific URL.
    delete process.env.URL;
    process.env.DEPLOY_URL = 'https://deploy-preview-12--my-store.netlify.app';
    assert.equal(getSiteUrl(), 'https://deploy-preview-12--my-store.netlify.app');

    // Cloudflare Pages: bare hostname.
    clearPlatform();
    process.env.CF_PAGES_URL = 'my-store.pages.dev';
    assert.equal(getSiteUrl(), 'https://my-store.pages.dev');

    // Placeholder / malformed platform values are skipped, never emitted.
    clearPlatform();
    process.env.VERCEL_URL = '$vercel_project_production_url';
    process.env.CF_PAGES_URL = 'https://broken store.pages.dev';
    assert.equal(getSiteUrl(), '');

    // An explicit configured URL always wins over platform vars.
    process.env.CF_PAGES_URL = 'pages.example';
    process.env.NEXT_PUBLIC_URL = 'https://real.example';
    assert.equal(getSiteUrl(), 'https://real.example');
  } finally {
    process.env = { ...original };
  }
});
