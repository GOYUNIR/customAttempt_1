import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripVersionDirective,
  prependVersionDirective,
  sanitizeGlslSource,
} from '../lib/shaders/glslSanitize.ts';

test('sanitizeGlslSource strips markdown fences and prepends the 300 es header', () => {
  const out = sanitizeGlslSource('```glsl\nvoid main() { gl_Position = vec4(0.0); }\n```');
  assert.ok(out.startsWith('#version 300 es\nprecision highp float;\n'));
  assert.match(out, /void main/);
  assert.ok(!out.includes('```'));
});

test('sanitizeGlslSource strips leading conversational text', () => {
  const out = sanitizeGlslSource('Here is a nice shader:\n\nuniform vec3 u_color;');
  assert.ok(out.startsWith('#version 300 es\n'));
  assert.ok(!out.includes('Here is a nice shader'));
  assert.match(out, /uniform vec3 u_color/);
});

test('sanitizeGlslSource removes an existing #version directive (no duplicates)', () => {
  const out = sanitizeGlslSource('#version 300 es\nprecision highp float;\nvoid main(){}');
  const versionCount = (out.match(/#version/g) || []).length;
  assert.equal(versionCount, 1);
  assert.ok(out.startsWith('#version 300 es\nprecision highp float;\n'));
});

test('sanitizeGlslSource is idempotent', () => {
  const once = sanitizeGlslSource('void main(){}');
  const twice = sanitizeGlslSource(once);
  assert.equal(twice, once);
});

test('sanitizeGlslSource removes a legacy #version 100 directive', () => {
  const out = sanitizeGlslSource('#version 100\nprecision mediump float;\nvoid main(){}');
  assert.ok(out.startsWith('#version 300 es\n'));
  assert.ok(!out.includes('#version 100'));
});

test('prependVersionDirective places #version 300 es on line 1', () => {
  const out = prependVersionDirective('void main(){}');
  assert.ok(out.startsWith('#version 300 es\n'));
});

test('stripVersionDirective drops every #version line', () => {
  assert.equal(stripVersionDirective('#version 100\nvoid main(){}'), 'void main(){}');
  assert.equal(stripVersionDirective('#version 100\n\nuniform float x;'), '\nuniform float x;');
});
