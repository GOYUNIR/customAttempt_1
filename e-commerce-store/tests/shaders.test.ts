import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePresetId,
  isExplodedPreset,
  defaultAiHeroSettings,
  HERO_SHADER_PRESETS,
} from '../lib/shaders/presets.ts';
import { parsePromptToParams, enhancePrompt, MAGIC_PROMPT_PILLS } from '../lib/shaders/promptParser.ts';
import { hexToRgb, extractAccentPalette, paletteToCss } from '../lib/shaders/palette.ts';
import { buildBottleGeometry, bottleBoundsCenter } from '../lib/shaders/bottleGeometry.ts';

// --- presets ---

test('normalizePresetId maps legacy ids onto the canonical suite', () => {
  assert.equal(normalizePresetId('ambient_mesh'), 'ambient_glass');
  assert.equal(normalizePresetId('particle_waves'), 'cyber_mesh');
  assert.equal(normalizePresetId('dark_organic'), 'dark_organic');
});

test('normalizePresetId falls back to dark_organic for unknown/empty ids', () => {
  assert.equal(normalizePresetId('not_a_preset'), 'dark_organic');
  assert.equal(normalizePresetId(''), 'dark_organic');
  assert.equal(normalizePresetId(undefined), 'dark_organic');
});

test('isExplodedPreset is true only for the exploded rebuild preset', () => {
  assert.equal(isExplodedPreset('exploded_rebuild'), true);
  assert.equal(isExplodedPreset('dark_organic'), false);
});

test('HERO_SHADER_PRESETS ships the four visual presets', () => {
  const ids = HERO_SHADER_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['dark_organic', 'exploded_rebuild', 'cyber_mesh', 'ambient_glass']);
});

test('defaultAiHeroSettings has sane bounds', () => {
  const d = defaultAiHeroSettings();
  assert.equal(d.enabled, true);
  assert.ok(d.opacity >= 0 && d.opacity <= 1);
  assert.ok(d.explosionRadius >= 0 && d.explosionRadius <= 150);
  assert.ok(d.assemblyProgress >= 0 && d.assemblyProgress <= 1);
});

// --- prompt parser ---

test('parsePromptToParams detects the exploded/assembly mode', () => {
  const p = parsePromptToParams('exploded bottle view — construction, rebuild, assemble');
  assert.equal(p.mode, 'exploded');
  assert.ok(p.dispersion > 0.5);
});

test('parsePromptToParams detects liquid glass + product silhouette', () => {
  const p = parsePromptToParams('liquid glass — refractive raymarched perfume bottle');
  assert.equal(p.mode, 'glass');
  // Perfume is a generic container descriptor → bound to the `bottle` silhouette
  // key (never a brand/product name).
  assert.equal(p.productSilhouette, 'bottle');
});

test('parsePromptToParams binds a generic container descriptor to a silhouette key', () => {
  const p = parsePromptToParams('cosmic dust, particles, bottle');
  assert.equal(p.productSilhouette, 'bottle');
  assert.equal(p.mode, 'particle');
});

test('parsePromptToParams raises viscosity/turbulence for fluid prompts', () => {
  const base = parsePromptToParams('');
  const fluid = parsePromptToParams('fluid organic smoke');
  assert.ok(fluid.viscosity > base.viscosity);
  assert.ok(fluid.turbulence > base.turbulence);
});

test('enhancePrompt always produces a non-empty enriched prompt', () => {
  const out = enhancePrompt('exploded view');
  assert.ok(out.length > 0);
  assert.match(out, /surface normals/i);
});

test('MAGIC_PROMPT_PILLS are non-empty and descriptive', () => {
  assert.ok(MAGIC_PROMPT_PILLS.length >= 4);
  for (const pill of MAGIC_PROMPT_PILLS) {
    assert.ok(pill.label.length > 0);
    assert.ok(pill.prompt.length > 0);
  }
});

// --- palette ---

test('hexToRgb parses hex and returns safe fallback for garbage', () => {
  assert.deepEqual(hexToRgb('#ff0000'), [1, 0, 0]);
  assert.deepEqual(hexToRgb('nope'), [0.5, 0.5, 0.5]);
});

test('extractAccentPalette derives three vectors from the theme', () => {
  const palette = extractAccentPalette({ accentPurple: '#bf5af2', accentBlue: '#0071e3' });
  assert.equal(palette.a.length, 3);
  assert.ok(palette.a[0] > 0.5); // purple
  assert.equal(palette.b[0], 0); // blue: no red channel
  assert.ok(palette.b[2] > 0.8); // blue-dominant
});

test('paletteToCss returns rgb strings', () => {
  const [a] = paletteToCss({ a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] });
  assert.equal(a, 'rgb(255, 0, 0)');
});

// --- bottle geometry ---

test('buildBottleGeometry emits interleaved points/normals/components', () => {
  const geom = buildBottleGeometry(5000);
  assert.ok(geom.pointCount > 0);
  assert.equal(geom.points.length, geom.pointCount * 3);
  assert.equal(geom.normals.length, geom.pointCount * 3);
  assert.equal(geom.components.length, geom.pointCount);
});

test('buildBottleGeometry is deterministic for a fixed seed', () => {
  const a = buildBottleGeometry(2000, 42);
  const b = buildBottleGeometry(2000, 42);
  assert.deepEqual(Array.from(a.points.slice(0, 9)), Array.from(b.points.slice(0, 9)));
});

test('buildBottleGeometry uses all four components', () => {
  const geom = buildBottleGeometry(5000);
  const seen = new Set(Array.from(geom.components));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test('bottleBoundsCenter returns the midpoint of the bounds', () => {
  const geom = buildBottleGeometry(1000);
  const [cx, cy, cz] = bottleBoundsCenter(geom.bounds);
  assert.ok(cy > -0.9 && cy < 1.4);
  assert.ok(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz));
});
