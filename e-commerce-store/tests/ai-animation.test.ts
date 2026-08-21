import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnimationPrompt,
  parseAnimationResult,
  fallbackAnimation,
  buildFallbackCss,
  FALLBACK_ANIMATION_PRESETS,
} from '../lib/ai-animation.ts';

test('buildAnimationPrompt encodes the asset ref + instruction and requests JSON', () => {
  const prompt = buildAnimationPrompt({ assetRef: '/media/p1/0.jpeg?v=abc', prompt: 'gentle float' });
  assert.ok(prompt.includes('/media/p1/0.jpeg?v=abc'));
  assert.ok(prompt.includes('gentle float'));
  assert.ok(prompt.includes('durationMs'));
});

test('parseAnimationResult parses a JSON object with css + durationMs', () => {
  const result = parseAnimationResult('{"css":"@keyframes x{}","durationMs":6000}', 'deepseek');
  assert.ok(result);
  assert.equal(result!.source, 'ai');
  assert.equal(result!.durationMs, 6000);
  assert.equal(result!.provider, 'deepseek');
});

test('parseAnimationResult strips markdown fences', () => {
  const result = parseAnimationResult('```json\n{"svg":"<svg/>","durationMs":4000}\n```');
  assert.ok(result);
  assert.equal(result!.svg, '<svg/>');
});

test('parseAnimationResult returns null for garbage', () => {
  assert.equal(parseAnimationResult('not json at all'), null);
  assert.equal(parseAnimationResult('{"nothing":true}'), null);
});

test('fallbackAnimation returns a preset with css + svg + source fallback', () => {
  const r = fallbackAnimation('pulse');
  assert.equal(r.source, 'fallback');
  assert.equal(r.preset, 'pulse');
  assert.ok(r.svg!.includes('<svg'));
  assert.ok(r.css!.includes('goyunir-ai-pulse'));
});

test('buildFallbackCss emits the correct keyframe name per preset', () => {
  assert.ok(buildFallbackCss('drift', 1000).includes('goyunir-ai-drift'));
  assert.ok(buildFallbackCss('shimmer', 1000).includes('goyunir-ai-shimmer'));
  assert.ok(buildFallbackCss('unknown', 1000).includes('goyunir-ai-drift'));
});

test('fallback presets include drift, pulse and shimmer', () => {
  assert.deepEqual(FALLBACK_ANIMATION_PRESETS.map((p) => p.id).sort(), ['drift', 'pulse', 'shimmer']);
});
