import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProductSilhouette,
  buildProductTarget,
  normalizeSilhouette,
  silhouetteLabel,
  SILHOUETTE_KEYS,
} from '../lib/shaders/productTarget.ts';
import {
  compileShaderParams,
  buildShaderPrompt,
  parseShaderParamsResult,
} from '../lib/shaders/promptParser.ts';
import { buildProductGeometry } from '../lib/shaders/bottleGeometry.ts';

// --- silhouette resolution ---

test('resolveProductSilhouette maps container descriptors without leaking brand names', () => {
  assert.equal(resolveProductSilhouette({ name: 'Elysian White', slug: 'elysian-white', categories: ['Perfume'] }), 'bottle');
  assert.equal(resolveProductSilhouette({ name: 'Ember Candle', categories: ['Candles & Home'] }), 'jar');
  assert.equal(resolveProductSilhouette({ name: 'Studio Cable', categories: ['Accessories'] }), 'tube');
  // A brand/product name that merely CONTAINS a container word is never matched.
  assert.equal(resolveProductSilhouette({ name: 'Boxwood Hoodie', categories: ['Apparel'] }), 'generic');
});

test('resolveProductSilhouette falls back to generic for empty/unknown products', () => {
  assert.equal(resolveProductSilhouette(null), 'generic');
  assert.equal(resolveProductSilhouette({}), 'generic');
  assert.equal(resolveProductSilhouette({ name: 'Mystery Item' }), 'generic');
});

test('normalizeSilhouette canonicalizes shape words to bounded keys', () => {
  assert.equal(normalizeSilhouette('bottle'), 'bottle');
  assert.equal(normalizeSilhouette('candle'), 'jar');
  assert.equal(normalizeSilhouette('print'), 'card');
  assert.equal(normalizeSilhouette('garbage'), 'generic');
  assert.equal(normalizeSilhouette(''), 'generic');
});

test('buildProductTarget builds a normalized payload and returns null for empty', () => {
  const t = buildProductTarget({ id: 'p1', name: 'Ember Candle', slug: 'ember-candle', categories: ['Candles & Home'] });
  assert.ok(t);
  assert.equal(t.id, 'p1');
  assert.equal(t.slug, 'ember-candle');
  assert.equal(t.category, 'Candles & Home');
  assert.equal(t.silhouette, 'jar');
  assert.equal(buildProductTarget(null), null);
  assert.equal(buildProductTarget({}), null);
});

test('SILHOUETTE_KEYS + silhouetteLabel are consistent', () => {
  assert.ok(SILHOUETTE_KEYS.length >= 5);
  for (const key of SILHOUETTE_KEYS) {
    assert.ok(silhouetteLabel(key).length > 0);
  }
});

// --- prompt compiler + AI payload ---

test('compileShaderParams injects the selected product silhouette when the prompt has none', () => {
  const target = buildProductTarget({ name: 'Ember Candle', categories: ['Candles & Home'] });
  const params = compileShaderParams('exploded view', target);
  assert.equal(params.mode, 'exploded');
  assert.equal(params.productSilhouette, 'jar');
});

test('compileShaderParams keeps an explicit prompt silhouette over the target', () => {
  const target = buildProductTarget({ name: 'Ember Candle', categories: ['Candles & Home'] });
  const params = compileShaderParams('liquid glass bottle', target);
  assert.equal(params.mode, 'glass');
  assert.equal(params.productSilhouette, 'bottle');
});

test('buildShaderPrompt includes the selected product metadata', () => {
  const target = buildProductTarget({ name: 'Studio Cable', slug: 'studio-cable', categories: ['Accessories'] });
  const prompt = buildShaderPrompt({ prompt: 'cosmic dust', product: target });
  assert.match(prompt, /Studio Cable/);
  assert.match(prompt, /studio-cable/);
  assert.match(prompt, /Accessories/);
  assert.match(prompt, /tube/);
});

test('parseShaderParamsResult parses bounded JSON and clamps out-of-range values', () => {
  const parsed = parseShaderParamsResult('{"mode":"glass","viscosity":2.5,"turbulence":-1,"spin":true,"productSilhouette":"bottle"}');
  assert.ok(parsed);
  assert.equal(parsed.mode, 'glass');
  assert.equal(parsed.viscosity, 1); // clamped to 0..1
  assert.equal(parsed.turbulence, 0); // clamped to 0..1
  assert.equal(parsed.spin, true);
  assert.equal(parsed.productSilhouette, 'bottle');
});

test('parseShaderParamsResult returns null for garbage and strips markdown fences', () => {
  assert.equal(parseShaderParamsResult('not json at all'), null);
  assert.equal(parseShaderParamsResult(''), null);
  const fenced = parseShaderParamsResult('```json\n{"mode":"particle"}\n```');
  assert.ok(fenced);
  assert.equal(fenced.mode, 'particle');
});

// --- dynamic procedural geometry ---

test('buildProductGeometry derives distinct shapes from the silhouette', () => {
  const bottle = buildProductGeometry('bottle', 2000, 42);
  const box = buildProductGeometry('box', 2000, 42);
  const jar = buildProductGeometry('jar', 2000, 42);
  assert.ok(bottle.pointCount > 0);
  assert.ok(box.pointCount > 0);
  assert.ok(jar.pointCount > 0);
  assert.notDeepEqual(Array.from(box.points.slice(0, 9)), Array.from(bottle.points.slice(0, 9)));
  assert.notDeepEqual(Array.from(jar.points.slice(0, 9)), Array.from(bottle.points.slice(0, 9)));
});

test('buildProductGeometry falls back to a neutral container for unknown silhouettes', () => {
  const unknown = buildProductGeometry('some-brand-product', 2000, 7);
  const bottle = buildProductGeometry('bottle', 2000, 7);
  assert.deepEqual(Array.from(unknown.points.slice(0, 9)), Array.from(bottle.points.slice(0, 9)));
});

test('buildProductGeometry emits all four components and interleaved arrays', () => {
  const geom = buildProductGeometry('box', 3000);
  assert.equal(geom.points.length, geom.pointCount * 3);
  assert.equal(geom.normals.length, geom.pointCount * 3);
  assert.equal(geom.components.length, geom.pointCount);
  const seen = new Set(Array.from(geom.components));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});
