import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGridGeometry, DEFAULT_GRID_SEGMENTS } from '../lib/shaders/gridGeometry.ts';
import {
  LOOP_PERIOD_SECONDS,
  isSplitHeroTextLayout,
  heroTextJustify,
} from '../lib/shaders/presets.ts';
import { heroLoopDurationMs } from '../lib/shaders/videoExport.ts';

test('buildGridGeometry emits a (N+1)² vertex interleaved grid', () => {
  const g = buildGridGeometry(32);
  const side = 33;
  assert.equal(g.segments, 32);
  assert.equal(g.vertexCount, side * side);
  assert.equal(g.vertices.length, side * side * 4); // x,y,u,v per vertex
  assert.equal(g.indexCount, 32 * 32 * 6);
  assert.equal(g.indices.length, g.indexCount);
});

test('buildGridGeometry clamps tiny segment counts and is index-safe', () => {
  const g = buildGridGeometry(1);
  assert.ok(g.segments >= 2);
  // Max index must fit within Uint16 (32-segment default is 1088 < 65536).
  const big = buildGridGeometry(DEFAULT_GRID_SEGMENTS);
  assert.ok(Math.max(...Array.from(big.indices)) < 65536);
});

test('buildGridGeometry positions span [-1,1] and UVs span [0,1]', () => {
  const g = buildGridGeometry(4);
  let minX = Infinity;
  let maxX = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  for (let i = 0; i < g.vertices.length; i += 4) {
    minX = Math.min(minX, g.vertices[i]);
    maxX = Math.max(maxX, g.vertices[i]);
    minU = Math.min(minU, g.vertices[i + 2]);
    maxU = Math.max(maxU, g.vertices[i + 2]);
  }
  assert.ok(Math.abs(minX + 1) < 1e-6);
  assert.ok(Math.abs(maxX - 1) < 1e-6);
  assert.ok(Math.abs(minU) < 1e-6);
  assert.ok(Math.abs(maxU - 1) < 1e-6);
});

test('LOOP_PERIOD_SECONDS is the canonical 4.0s loop period', () => {
  assert.equal(LOOP_PERIOD_SECONDS, 4.0);
});

test('heroLoopDurationMs scales the loop period inversely with speed', () => {
  assert.equal(heroLoopDurationMs(1), 4000);
  assert.equal(heroLoopDurationMs(2), 2000);
  assert.equal(heroLoopDurationMs(0.5), 8000);
  assert.equal(heroLoopDurationMs(0), 4000); // invalid → 1×
});

test('isSplitHeroTextLayout treats both split and bottom as split layouts', () => {
  assert.equal(isSplitHeroTextLayout('split'), true);
  assert.equal(isSplitHeroTextLayout('bottom'), true);
  assert.equal(isSplitHeroTextLayout('top'), false);
  assert.equal(isSplitHeroTextLayout('centered'), false);
  assert.equal(isSplitHeroTextLayout(undefined), false);
});

test('heroTextJustify pins top/split/bottom to flex-start and centers otherwise', () => {
  assert.equal(heroTextJustify('top'), 'flex-start');
  assert.equal(heroTextJustify('split'), 'flex-start');
  assert.equal(heroTextJustify('bottom'), 'flex-start');
  assert.equal(heroTextJustify('centered'), 'center');
  assert.equal(heroTextJustify(undefined), 'center');
});
