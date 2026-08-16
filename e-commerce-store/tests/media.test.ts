import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CROP,
  normalizeCrop,
  isVideoMedia,
  isImageMedia,
  aspectRatioLabel,
  coverStyle,
  publicMediaRef,
  brandLogoRef,
} from '../lib/media.ts';

test('normalizeCrop clamps and fills defaults', () => {
  assert.deepEqual(normalizeCrop(null), DEFAULT_CROP);
  assert.deepEqual(normalizeCrop(undefined), DEFAULT_CROP);
  assert.deepEqual(normalizeCrop({}), DEFAULT_CROP);
  const c = normalizeCrop({ x: 0.3, y: 0.6, w: 0.5, h: 0.5 });
  assert.ok(Math.abs(c.x - 0.3) < 0.0001);
  assert.ok(Math.abs(c.y - 0.6) < 0.0001);
  assert.ok(Math.abs(c.w - 0.5) < 0.0001);
  // Out-of-range values clamp to 0..1; a zero/undefined size falls back to the
  // full-image default (1) because a 0-width crop is meaningless.
  assert.equal(normalizeCrop({ x: 99, y: -3, w: 0, h: 1.4 }).w, 1);
  assert.equal(normalizeCrop({ x: 99, y: -3, w: 0, h: 1.4 }).h, 1);
  assert.ok(Math.abs(normalizeCrop({ x: 99 }).x - 1) < 0.0001);
  assert.ok(Math.abs(normalizeCrop({ y: -3 }).y - 0.5) < 0.0001); // negative → center fallback
});

test('isVideoMedia / isImageMedia detect data URLs and extensions', () => {
  assert.equal(isVideoMedia('data:video/mp4;base64,AAAA'), true);
  assert.equal(isVideoMedia('data:image/png;base64,AAAA'), false);
  assert.equal(isVideoMedia('https://cdn.example.com/clip.webm'), true);
  assert.equal(isVideoMedia('https://cdn.example.com/photo.jpg'), false);
  assert.equal(isVideoMedia('/media/video.MOV'), true);
  assert.equal(isVideoMedia(''), false);
  assert.equal(isImageMedia('https://cdn.example.com/photo.jpg'), true);
  assert.equal(isImageMedia('data:video/webm;base64,AAAA'), false);
});

test('aspectRatioLabel reports the nearest common ratio', () => {
  assert.equal(aspectRatioLabel(560, 280), '2:1');
  assert.equal(aspectRatioLabel(320, 160), '2:1');
  assert.equal(aspectRatioLabel(200, 171), '1.17:1');
  assert.equal(aspectRatioLabel(16, 9), '16:9');
  assert.equal(aspectRatioLabel(1, 1), '1:1');
  assert.equal(aspectRatioLabel(0, 0), '—');
});

test('publicMediaRef turns data URLs into versioned /media refs, passes URLs through', () => {
  // JPEG data URL → /media/<productId>/<index>.jpg?v=<hash>
  const ref = publicMediaRef('data:image/jpeg;base64,/9j/4AAQ', 'p1', 0);
  assert.match(ref, /^\/media\/p1\/0\.jpg\?v=[0-9a-z]+$/);
  // Video data URL → .mp4 ref (so isVideoMedia keeps detecting it)
  const videoRef = publicMediaRef('data:video/mp4;base64,AAAA', 'prod_x', 2);
  assert.match(videoRef, /^\/media\/prod_x\/2\.mp4\?v=[0-9a-z]+$/);
  assert.equal(isVideoMedia(videoRef), true);
  assert.equal(isImageMedia(ref), true);
  // Relative paths, absolute URLs, empty and junk pass through untouched.
  assert.equal(publicMediaRef('/images/x/1.jpeg', 'p1', 0), '/images/x/1.jpeg');
  assert.equal(publicMediaRef('https://cdn.example.com/photo.jpg', 'p1', 0), 'https://cdn.example.com/photo.jpg');
  assert.equal(publicMediaRef('', 'p1', 0), '');
  assert.equal(publicMediaRef(null, 'p1', 0), '');
  // Deterministic + versioned: same bytes → same ref, different bytes → new ref.
  assert.equal(publicMediaRef('data:image/png;base64,aaaa', 'p1', 1), publicMediaRef('data:image/png;base64,aaaa', 'p1', 1));
  assert.notEqual(
    publicMediaRef('data:image/png;base64,aaaa', 'p1', 1),
    publicMediaRef('data:image/png;base64,bbbb', 'p1', 1),
  );
});

test('brandLogoRef maps a data-URL logo to /media/logo and passes URLs through', () => {
  const ref = brandLogoRef('data:image/jpeg;base64,/9j/4AAQ');
  assert.match(ref, /^\/media\/logo\?v=[0-9a-z]+$/);
  assert.equal(brandLogoRef('https://example.com/logo.png'), 'https://example.com/logo.png');
  assert.equal(brandLogoRef('/uploads/logo.png'), '/uploads/logo.png');
  assert.equal(brandLogoRef(''), '');
  assert.equal(brandLogoRef(undefined), '');
  assert.notEqual(brandLogoRef('data:image/png;base64,aaaa'), brandLogoRef('data:image/png;base64,bbbb'));
});

test('coverStyle maps the crop region onto the box exactly', () => {
  // Full-image crop on a 2:1 box from a 4:3 source → cover scales width.
  const style = coverStyle(400, 300, 560, 280, DEFAULT_CROP);
  assert.ok(Math.abs(style.width - 560) < 0.001); // width fills the box
  assert.ok(Math.abs(style.height - 420) < 0.001); // height over-crops (cover)
  assert.ok(Math.abs(style.left) < 0.001);
  assert.ok(Math.abs(style.top - (140 - 210)) < 0.001); // centered vertically

  // A zoomed crop (w=h=0.5) doubles the displayed image.
  const zoomed = coverStyle(400, 300, 560, 280, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.ok(Math.abs(zoomed.width - 1120) < 0.001);
  assert.ok(Math.abs(zoomed.height - 840) < 0.001);

  // A panned crop shifts left so the crop CENTER lands at the box center.
  const panned = coverStyle(400, 300, 560, 280, { x: 0.25, y: 0.5, w: 1, h: 1 });
  // left = boxW/2 - x*nw*scale = 280 - 0.25*400*1.4 = 280 - 140 = 140
  assert.ok(Math.abs(panned.left - 140) < 0.001);
});
