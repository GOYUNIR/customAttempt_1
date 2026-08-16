import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '../lib/order-ref.ts';

test('buildOrderRef uses the GU prefix by default and preserves a stable reference', () => {
  const first = buildOrderRef('buyer@example.com', 'prod-1', 'Standard');
  const second = buildOrderRef('buyer@example.com', 'prod-1', 'Standard');

  assert.match(first, /^GU-[A-Z0-9]+$/);
  assert.equal(first, second);
  assert.equal(formatOrderRef(first), first);
});

test('buildOrderRef accepts a custom sanitized prefix', () => {
  assert.match(buildOrderRef('buyer@example.com', 'prod-1', 'Standard', 'gy'), /^GY-[A-Z0-9]+$/);
  // Empty / invalid prefixes fall back to GU.
  assert.match(buildOrderRef('a@b.co', 'p', 's', ''), /^GU-[A-Z0-9]+$/);
  assert.match(buildOrderRef('a@b.co', 'p', 's', '!!'), /^GU-[A-Z0-9]+$/);
  // Over-long prefixes are stripped to the first 4 valid chars.
  assert.match(buildOrderRef('a@b.co', 'p', 's', 'TOOLONGPREFIX'), /^TOOL-[A-Z0-9]+$/);
});

test('formatOrderRef normalizes legacy GOY-/GY- refs to the configured prefix', () => {
  assert.equal(formatOrderRef('GY-abc123'), 'GU-ABC123');
  assert.equal(formatOrderRef('GOY-abc123'), 'GU-ABC123');
  assert.equal(formatOrderRef('gu-abc123'), 'GU-ABC123');
  assert.equal(formatOrderRef('GY-abc123', 'GY'), 'GY-ABC123');
  assert.equal(formatOrderRef('GOY-abc123', 'XY'), 'XY-ABC123');
  assert.equal(formatOrderRef('GU-abc123', 'GU'), 'GU-ABC123');
});

test('formatOrderRef passes unknown refs through uppercased', () => {
  assert.equal(formatOrderRef('DIRECT-xyz'), 'DIRECT-XYZ');
  assert.equal(formatOrderRef(''), '');
  assert.equal(formatOrderRef(null), '');
  assert.equal(formatOrderRef(undefined), '');
});

test('normalizeRefPrefix sanitizes admin-configured prefixes', () => {
  assert.equal(normalizeRefPrefix('gu'), 'GU');
  assert.equal(normalizeRefPrefix('  gy! '), 'GY');
  assert.equal(normalizeRefPrefix('TOOLONG'), 'TOOL');
  assert.equal(normalizeRefPrefix(''), 'GU');
  assert.equal(normalizeRefPrefix(null), 'GU');
  assert.equal(normalizeRefPrefix(1234), '1234');
});
