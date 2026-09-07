import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePresetId,
  isExplodedPreset,
  defaultAiHeroSettings,
  HERO_SHADER_PRESETS,
  resolveHeroIntensity,
  intensityToRadius,
  intensityToSpeed,
  resolveHeroSpeed,
  resolveHeroMotionType,
  motionTypeToPreset,
  motionTypeToLoop,
  resolveHeroHeightPx,
  resolveHeroTextDistribution,
  resolveHeroContrastScrim,
  resolveHeroRenderMode,
  resolveHeroClips,
  pickHeroClip,
  resolveEffectiveHeroRender,
} from '../lib/shaders/presets.ts';
import { parsePromptToParams, enhancePrompt } from '../lib/shaders/promptParser.ts';
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
  assert.ok(d.intensity >= 0 && d.intensity <= 1);
});

test('resolveHeroIntensity prefers the explicit intensity field', () => {
  assert.equal(resolveHeroIntensity({ intensity: 0.75, explosionRadius: 30 }), 0.75);
});

test('resolveHeroIntensity falls back to explosionRadius / 150 for legacy configs', () => {
  assert.equal(resolveHeroIntensity({ explosionRadius: 75 }), 0.5);
  assert.equal(resolveHeroIntensity({ explosionRadius: 0 }), 0);
  assert.equal(resolveHeroIntensity({}), 0.4);
  assert.equal(resolveHeroIntensity(null), 0.4);
});

test('intensityToRadius maps 0..1 to the 0..150 dispersion radius', () => {
  assert.equal(intensityToRadius(0), 0);
  assert.equal(intensityToRadius(0.4), 60);
  assert.equal(intensityToRadius(1), 150);
  assert.equal(intensityToRadius(2), 150); // clamped
  assert.equal(intensityToRadius(-1), 0); // clamped
});

test('intensityToSpeed maps 0..1 to a 0.5×..2× speed multiplier', () => {
  assert.equal(intensityToSpeed(0), 0.5);
  assert.ok(Math.abs(intensityToSpeed(0.4) - 1.1) < 1e-9);
  assert.equal(intensityToSpeed(1), 2);
  assert.equal(intensityToSpeed(9), 2); // clamped
});

test('resolveHeroSpeed prefers the explicit speed field and clamps to 0.5×..2×', () => {
  assert.equal(resolveHeroSpeed({ speed: 1.25, intensity: 0.4 }), 1.25);
  assert.equal(resolveHeroSpeed({ speed: 9 }), 2); // clamped
  assert.equal(resolveHeroSpeed({ speed: 0 }), 1.1); // invalid (0) → intensity-derived fallback
});

test('resolveHeroMotionType defaults to spin for missing/unknown values', () => {
  assert.equal(resolveHeroMotionType(null), 'spin');
  assert.equal(resolveHeroMotionType({}), 'spin');
  assert.equal(resolveHeroMotionType({ motionType: 'hover' }), 'hover');
  assert.equal(resolveHeroMotionType({ motionType: 'assembly' }), 'assembly');
  assert.equal(resolveHeroMotionType({ motionType: 'nonsense' }), 'spin');
});

test('motionTypeToPreset / motionTypeToLoop map motion types onto the engine', () => {
  assert.equal(motionTypeToPreset('spin'), 'exploded_rebuild');
  assert.equal(motionTypeToPreset('assembly'), 'exploded_rebuild');
  assert.equal(motionTypeToPreset('hover'), 'cyber_mesh');
  assert.equal(motionTypeToLoop('spin'), 'spin');
  assert.equal(motionTypeToLoop('assembly'), 'pulse');
  assert.equal(motionTypeToLoop('hover'), 'mouse');
});

test('resolveHeroHeightPx resolves presets and clamps the custom slider', () => {
  assert.equal(resolveHeroHeightPx({ heroHeight: 'compact' }), 360);
  assert.equal(resolveHeroHeightPx({ heroHeight: 'standard' }), 480);
  assert.equal(resolveHeroHeightPx({ heroHeight: 'tall' }), 640);
  assert.equal(resolveHeroHeightPx({ heroHeight: 'custom', heroHeightPx: 500 }), 500);
  assert.equal(resolveHeroHeightPx({ heroHeight: 'custom', heroHeightPx: 9999 }), 900); // clamped
  assert.equal(resolveHeroHeightPx({}), 480); // default standard
});

test('resolveHeroTextDistribution defaults to centered and passes through valid values', () => {
  assert.equal(resolveHeroTextDistribution(undefined), 'centered');
  assert.equal(resolveHeroTextDistribution({ textDistribution: 'bogus' }), 'centered');
  assert.equal(resolveHeroTextDistribution({ textDistribution: 'top' }), 'top');
  assert.equal(resolveHeroTextDistribution({ textDistribution: 'split' }), 'split');
  assert.equal(resolveHeroTextDistribution({ textDistribution: 'bottom' }), 'bottom');
});

test('resolveHeroContrastScrim clamps to 0..100 and defaults to 0', () => {
  assert.equal(resolveHeroContrastScrim(undefined), 0);
  assert.equal(resolveHeroContrastScrim({ contrastScrim: 37 }), 37);
  assert.equal(resolveHeroContrastScrim({ contrastScrim: 999 }), 100);
  assert.equal(resolveHeroContrastScrim({ contrastScrim: -5 }), 0);
  assert.equal(resolveHeroContrastScrim({ contrastScrim: NaN }), 0);
});

test('resolveHeroRenderMode defaults to live', () => {
  assert.equal(resolveHeroRenderMode(undefined), 'live');
  assert.equal(resolveHeroRenderMode({ renderMode: 'video' }), 'video');
  assert.equal(resolveHeroRenderMode({ renderMode: 'live' }), 'live');
});

test('resolveHeroClips drops malformed entries and sorts newest first', () => {
  const clip = (id: string, createdAt: string) => ({
    id,
    url: `data:video/webm;base64,AAAA${id}`,
    mime: 'video/webm',
    bytes: 100,
    width: 640,
    height: 360,
    durationMs: 3000,
    createdAt,
  });
  const out = resolveHeroClips({
    clips: [
      clip('a', '2026-01-01T00:00:00.000Z'),
      { id: 'bad', url: 'https://not-a-data-url' },
      { id: '', url: 'data:video/webm;base64,x' },
      null,
      clip('b', '2026-02-01T00:00:00.000Z'),
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'b');
  assert.equal(out[1].id, 'a');
});

test('pickHeroClip returns the first clip or null', () => {
  const clip = { id: 'c1', url: 'data:video/webm;base64,x', mime: 'video/webm', bytes: 1, width: 2, height: 2, durationMs: 1, createdAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(pickHeroClip({ clips: [clip] })?.id, 'c1');
  assert.equal(pickHeroClip({ clips: [] }), null);
  assert.equal(pickHeroClip(undefined), null);
});

test('resolveEffectiveHeroRender prefers live with no clip and falls back on mobile/low-power', () => {
  const clip = { id: 'c1', url: 'data:video/webm;base64,x', mime: 'video/webm', bytes: 1, width: 2, height: 2, durationMs: 1, createdAt: '2026-01-01T00:00:00.000Z' };
  // No clip → always live.
  assert.equal(resolveEffectiveHeroRender({ renderMode: 'video', clips: [] }, { isMobile: true }), 'live');
  // Explicit video mode + clip → video.
  assert.equal(resolveEffectiveHeroRender({ renderMode: 'video', clips: [clip] }, {}), 'video');
  // Live mode + mobile → automatic fallback.
  assert.equal(resolveEffectiveHeroRender({ renderMode: 'live', clips: [clip] }, { isMobile: true }), 'video');
  // Live mode + low-power → automatic fallback.
  assert.equal(resolveEffectiveHeroRender({ renderMode: 'live', clips: [clip] }, { isLowPower: true }), 'video');
  // Live mode, desktop, capable GPU → live.
  assert.equal(resolveEffectiveHeroRender({ renderMode: 'live', clips: [clip] }, {}), 'live');
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
