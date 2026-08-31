import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiHeroAnimationKey } from '../lib/redis-keys.ts';
import { fallbackAnimation, parseAnimationResult, buildAnimationPrompt } from '../lib/ai-animation.ts';

test('aiHeroAnimationKey namespaces the cached hero animation under cache:', () => {
  assert.equal(aiHeroAnimationKey('prod_123'), 'cache:ai-hero:prod_123');
});

test('aiHeroAnimationKey falls back to a stable "featured" id for an empty product id', () => {
  assert.equal(aiHeroAnimationKey(''), 'cache:ai-hero:featured');
  assert.equal(aiHeroAnimationKey('   '), 'cache:ai-hero:featured');
});

test('hero animation prompt encodes the product image ref', () => {
  const prompt = buildAnimationPrompt({ assetRef: 'https://cdn/x.jpg', prompt: 'subtle premium loop' });
  assert.match(prompt, /https:\/\/cdn\/x\.jpg/);
  assert.match(prompt, /subtle premium loop/);
  assert.match(prompt, /JSON/);
});

test('parseAnimationResult returns null for garbage so the hero falls back', () => {
  assert.equal(parseAnimationResult('not json at all'), null);
  assert.equal(parseAnimationResult(''), null);
});

test('fallbackAnimation always yields a usable css string', () => {
  const drift = fallbackAnimation('drift');
  assert.equal(drift.source, 'fallback');
  assert.ok(drift.css && drift.css.includes('@keyframes'));
});
