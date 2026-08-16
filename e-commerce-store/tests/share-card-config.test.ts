import assert from 'node:assert/strict';
import test from 'node:test';
import {
  safeCssColor,
  hexToRgba,
  cardBackgroundStyle,
  cardSiteUrlDisplay,
  previewSiteUrl,
  resolveClientImageSource,
  revisionHash,
  toHexColor,
  normalizeShareCardOptions,
  SHARE_CARD_DEFAULTS,
} from '../lib/share-card-config.ts';

test('safeCssColor keeps valid colors and falls back on junk', () => {
  assert.equal(safeCssColor('#0B0B0F'), '#0B0B0F');
  assert.equal(safeCssColor('#fff'), '#fff');
  assert.equal(safeCssColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(safeCssColor('white'), 'white');
  // A leftover/free-text admin value must NEVER leak into the card CSS.
  assert.equal(safeCssColor('a image url', '#0B0B0F'), '#0B0B0F');
  assert.equal(safeCssColor('', '#123456'), '#123456');
  assert.equal(safeCssColor(null, '#123456'), '#123456');
});

test('hexToRgba converts hex (incl. 8-digit) and falls back neutrally', () => {
  assert.equal(hexToRgba('#D4AF37', 0.33), 'rgba(212, 175, 55, 0.330)');
  assert.equal(hexToRgba('#fff', 1), 'rgba(255, 255, 255, 1.000)');
  // 8-digit hex carries its own alpha, multiplied into the requested one.
  assert.equal(hexToRgba('#D4AF3755', 1), 'rgba(212, 175, 55, 0.333)');
  assert.equal(hexToRgba('not-a-color', 0.5), 'rgba(255,255,255,0.500)');
});

test('cardBackgroundStyle is safe with a broken share image and accent', () => {
  const withImage = cardBackgroundStyle('#000000', 'garbage', 'https://example.com/a.png');
  assert.match(withImage, /linear-gradient/);
  assert.match(withImage, /url\(https:\/\/example\.com\/a\.png\)/);
  assert.match(withImage, /#000000/);
  // Default overlay (60) reproduces the pre-options alpha values exactly.
  assert.match(withImage, /rgba\(0,0,0,0\.56\), rgba\(0,0,0,0\.68\)/);
  const noImage = cardBackgroundStyle('garbage', 'garbage');
  assert.match(noImage, /radial-gradient/);
  // Junk colors fall back — no raw admin text can be injected into CSS.
  assert.ok(!noImage.includes('garbage'));
});

test('cardBackgroundStyle maps image overlay 0 → transparent and 100 → near-black', () => {
  const none = cardBackgroundStyle('#000000', '#D4AF37', 'https://example.com/a.png', { shareImageOverlay: 0 });
  assert.match(none, /linear-gradient\(180deg, rgba\(0,0,0,0\.00\), rgba\(0,0,0,0\.00\)\)/);
  const heavy = cardBackgroundStyle('#000000', '#D4AF37', 'https://example.com/a.png', { shareImageOverlay: 100 });
  assert.match(heavy, /rgba\(0,0,0,0\.95\)/);
  assert.match(heavy, /rgba\(0,0,0,0\.97\)/);
});

test('cardBackgroundStyle glow intensity maps 0 → no glow and 100 → max alpha', () => {
  const none = cardBackgroundStyle('#0B0B0F', '#D4AF37', undefined, { shareGlowIntensity: 0 });
  assert.equal(none, '#0B0B0F');
  assert.ok(!none.includes('radial-gradient'));
  const defaultGlow = cardBackgroundStyle('#0B0B0F', '#D4AF37');
  assert.match(defaultGlow, /rgba\(212, 175, 55, 0\.330\)/);
  const maxGlow = cardBackgroundStyle('#0B0B0F', '#D4AF37', undefined, { shareGlowIntensity: 100 });
  assert.match(maxGlow, /rgba\(212, 175, 55, 0\.450\)/);
});

test('normalizeShareCardOptions applies defaults for missing/unknown fields', () => {
  const d = normalizeShareCardOptions(undefined);
  assert.deepEqual(d, SHARE_CARD_DEFAULTS);
  const empty = normalizeShareCardOptions({});
  assert.deepEqual(empty, SHARE_CARD_DEFAULTS);
  // Junk enum values and non-numeric numbers fall back to defaults.
  const junk = normalizeShareCardOptions({ shareLayout: 'weird', shareFontFamily: 'comic', shareTitleSize: 'big' });
  assert.equal(junk.shareLayout, 'classic');
  assert.equal(junk.shareFontFamily, 'system');
  assert.equal(junk.shareTitleSize, SHARE_CARD_DEFAULTS.shareTitleSize);
});

test('normalizeShareCardOptions clamps numbers to their documented ranges', () => {
  const clamped = normalizeShareCardOptions({
    shareTitleSize: 500,
    shareDescriptionSize: 2,
    shareGlowIntensity: -5,
    shareCornerRadius: 999,
    shareImageOverlay: 150,
  });
  assert.equal(clamped.shareTitleSize, 92);
  assert.equal(clamped.shareDescriptionSize, 18);
  assert.equal(clamped.shareGlowIntensity, 0);
  assert.equal(clamped.shareCornerRadius, 64);
  assert.equal(clamped.shareImageOverlay, 100);
  const floored = normalizeShareCardOptions({
    shareTitleSize: 1,
    shareDescriptionSize: 100,
    shareGlowIntensity: 50,
    shareCornerRadius: -3,
    shareImageOverlay: 0,
  });
  assert.equal(floored.shareTitleSize, 36);
  assert.equal(floored.shareDescriptionSize, 42);
  assert.equal(floored.shareGlowIntensity, 50);
  assert.equal(floored.shareCornerRadius, 0);
  assert.equal(floored.shareImageOverlay, 0);
});

test('normalizeShareCardOptions accepts valid values and boolean-ish strings', () => {
  const opts = normalizeShareCardOptions({
    shareLayout: 'split',
    shareFontFamily: 'serif',
    shareLogoVisible: 'false',
    shareSiteVisible: 0,
    shareTaglineVisible: '1',
  });
  assert.equal(opts.shareLayout, 'split');
  assert.equal(opts.shareFontFamily, 'serif');
  assert.equal(opts.shareLogoVisible, false);
  assert.equal(opts.shareSiteVisible, false);
  assert.equal(opts.shareTaglineVisible, true);
  // Real booleans pass through unchanged.
  const bools = normalizeShareCardOptions({ shareLogoVisible: true, shareSiteVisible: false });
  assert.equal(bools.shareLogoVisible, true);
  assert.equal(bools.shareSiteVisible, false);
});

test('cardSiteUrlDisplay strips protocol and trailing slashes', () => {
  assert.equal(cardSiteUrlDisplay('https://yourstore.com/'), 'yourstore.com');
  assert.equal(cardSiteUrlDisplay('http://a.example/path/'), 'a.example/path');
  assert.equal(cardSiteUrlDisplay('', 'example.com'), 'example.com');
  assert.equal(cardSiteUrlDisplay(null, 'example.com'), 'example.com');
});

test('cardSiteUrlDisplay never prints a Vercel env placeholder on the card', () => {
  // The URL parser accepts `$` in a hostname, so the placeholder must be
  // rejected explicitly or the card's domain would read "$vercel_project_production_url".
  for (const placeholder of ['$vercel_project_production_url', 'https://$vercel_project_production_url', '$VERCEL_URL']) {
    assert.equal(cardSiteUrlDisplay(placeholder, 'example.com'), 'example.com');
  }
});

test('previewSiteUrl builds a clickable link from a bare domain', () => {
  assert.equal(previewSiteUrl('https://a.example', 'https://x.example'), 'https://a.example');
  assert.equal(previewSiteUrl('a.example', 'https://x.example'), 'https://a.example');
  assert.equal(previewSiteUrl('', 'https://x.example'), 'https://x.example');
  // Vercel placeholder tokens fall back to the origin, never a fake domain.
  assert.equal(previewSiteUrl('$vercel_project_production_url', 'https://x.example'), 'https://x.example');
  assert.equal(previewSiteUrl('https://$vercel_project_production_url', 'https://x.example'), 'https://x.example');
});

test('resolveClientImageSource keeps absolute/data, resolves root-relative, drops junk', () => {
  assert.equal(resolveClientImageSource('https://a.example/logo.png', 'https://s.example'), 'https://a.example/logo.png');
  assert.equal(resolveClientImageSource('data:image/png;base64,abc', 'https://s.example'), 'data:image/png;base64,abc');
  assert.equal(resolveClientImageSource('/images/x/1.jpeg', 'https://s.example'), 'https://s.example/images/x/1.jpeg');
  assert.equal(resolveClientImageSource('a image url', 'https://s.example'), '');
  assert.equal(resolveClientImageSource('', 'https://s.example'), '');
});

test('toHexColor produces a color-input-safe #rrggbb from any CSS color', () => {
  // Hex passes through (the exact error case: rgba() values crash color inputs).
  assert.equal(toHexColor('#D4AF37'), '#d4af37');
  assert.equal(toHexColor('#fff'), '#ffffff');
  assert.equal(toHexColor('rgba(0,0,0,0.14)'), '#000000');
  assert.equal(toHexColor('rgb(212, 175, 55)'), '#d4af37');
  // 8-digit hex loses its alpha channel (color inputs can't express alpha).
  assert.equal(toHexColor('#D4AF3755'), '#d4af37');
  assert.equal(toHexColor('garbage', '#123456'), '#123456');
  assert.equal(toHexColor('', '#123456'), '#123456');
});

test('revisionHash is deterministic and changes with input', () => {
  const a = revisionHash({ shareTitle: 'Hello' });
  const b = revisionHash({ shareTitle: 'Hello' });
  const c = revisionHash({ shareTitle: 'Goodbye' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}$/);
});
