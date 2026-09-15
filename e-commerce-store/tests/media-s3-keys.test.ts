import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMediaObjectKey,
  needsMediaMigration,
  parseDataUrl,
  safeMediaExtension,
  slugifyMediaSegment,
} from '../lib/media-s3-keys.ts';

test('slugifyMediaSegment: lowercases, hyphenates, strips apostrophes', () => {
  assert.equal(slugifyMediaSegment("Nike's Air Max 90!"), 'nikes-air-max-90');
  assert.equal(slugifyMediaSegment('  spaced  out  '), 'spaced-out');
});

test('slugifyMediaSegment: empty or junk falls back to "product", never empty', () => {
  assert.equal(slugifyMediaSegment(''), 'product');
  assert.equal(slugifyMediaSegment('!!!'), 'product');
});

test('slugifyMediaSegment: bounded to 64 chars (object keys stay sane)', () => {
  assert.ok(slugifyMediaSegment('a'.repeat(200)).length <= 64);
});

test('safeMediaExtension: accepts known media, rejects everything else', () => {
  assert.equal(safeMediaExtension('photo.PNG'), '.png');
  assert.equal(safeMediaExtension('clip.mp4'), '.mp4');
  assert.equal(safeMediaExtension('payload.exe'), '');
  assert.equal(safeMediaExtension('noext'), '');
});

test('buildMediaObjectKey: uses the required products/<slug>/ prefix', () => {
  assert.equal(buildMediaObjectKey('Cool Shoe', 'abc123', 'x.png'), 'products/cool-shoe/abc123.png');
});

test('buildMediaObjectKey: strips path traversal out of the id', () => {
  const key = buildMediaObjectKey('slug', '../../etc/passwd', 'x.png');
  assert.ok(!key.includes('..'), `traversal survived: ${key}`);
  assert.ok(key.startsWith('products/slug/'));
});

test('parseDataUrl: parses a real base64 data URL', () => {
  const parsed = parseDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(parsed?.mime, 'image/png');
  assert.equal(parsed?.base64, 'iVBORw0KGgo=');
});

test('parseDataUrl: returns null for values that are ALREADY migrated URLs', () => {
  // The backfill's idempotency depends on this exactly.
  assert.equal(parseDataUrl('https://cdn.example.com/products/a/b.png'), null);
  assert.equal(parseDataUrl('/images/seed/1.jpeg'), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl(null), null);
  assert.equal(parseDataUrl(undefined), null);
});

test('parseDataUrl: returns null for malformed or empty-payload data URLs', () => {
  assert.equal(parseDataUrl('data:image/png;base64,'), null);
  assert.equal(parseDataUrl('data:notamime;base64,AAAA'), null);
  assert.equal(parseDataUrl('data:image/png,notbase64'), null);
});

test('needsMediaMigration: true only for base64 data URLs', () => {
  assert.equal(needsMediaMigration('data:image/webp;base64,AAAA'), true);
  assert.equal(needsMediaMigration('https://cdn.example.com/x.webp'), false);
});

test('buildMediaObjectKey: PRESERVES a normal uuid id verbatim', () => {
  // Regression guard. A sanitizer bug once collapsed every id to "object",
  // which would have made every uploaded image overwrite the SAME key —
  // silent, total media loss. Distinct ids must stay distinct.
  assert.equal(
    buildMediaObjectKey('slug', '3f1c9a0e-7d2b-4c65-9f83-2b7d4e5a6c10', 'x.png'),
    'products/slug/3f1c9a0e-7d2b-4c65-9f83-2b7d4e5a6c10.png',
  );
});

test('buildMediaObjectKey: distinct ids never collide', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 500; i++) keys.add(buildMediaObjectKey('slug', `id-${i}-abc`, 'x.png'));
  assert.equal(keys.size, 500, 'ids collapsed into a shared key');
});
