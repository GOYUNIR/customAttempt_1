import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CROP,
  normalizeCrop,
  isVideoMedia,
  isImageMedia,
  aspectRatioLabel,
  coverStyle,
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
