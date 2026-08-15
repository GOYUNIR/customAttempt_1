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
  const noImage = cardBackgroundStyle('garbage', 'garbage');
  assert.match(noImage, /radial-gradient/);
  // Junk colors fall back — no raw admin text can be injected into CSS.
  assert.ok(!noImage.includes('garbage'));
});

test('cardSiteUrlDisplay strips protocol and trailing slashes', () => {
  assert.equal(cardSiteUrlDisplay('https://yourstore.com/'), 'yourstore.com');
  assert.equal(cardSiteUrlDisplay('http://a.example/path/'), 'a.example/path');
  assert.equal(cardSiteUrlDisplay('', 'example.com'), 'example.com');
  assert.equal(cardSiteUrlDisplay(null, 'example.com'), 'example.com');
});

test('previewSiteUrl builds a clickable link from a bare domain', () => {
  assert.equal(previewSiteUrl('https://a.example', 'https://x.example'), 'https://a.example');
  assert.equal(previewSiteUrl('a.example', 'https://x.example'), 'https://a.example');
  assert.equal(previewSiteUrl('', 'https://x.example'), 'https://x.example');
});

test('resolveClientImageSource keeps absolute/data, resolves root-relative, drops junk', () => {
  assert.equal(resolveClientImageSource('https://a.example/logo.png', 'https://s.example'), 'https://a.example/logo.png');
  assert.equal(resolveClientImageSource('data:image/png;base64,abc', 'https://s.example'), 'data:image/png;base64,abc');
  assert.equal(resolveClientImageSource('/images/x/1.jpeg', 'https://s.example'), 'https://s.example/images/x/1.jpeg');
  assert.equal(resolveClientImageSource('a image url', 'https://s.example'), '');
  assert.equal(resolveClientImageSource('', 'https://s.example'), '');
});

test('revisionHash is deterministic and changes with input', () => {
  const a = revisionHash({ shareTitle: 'Hello' });
  const b = revisionHash({ shareTitle: 'Hello' });
  const c = revisionHash({ shareTitle: 'Goodbye' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}$/);
});
