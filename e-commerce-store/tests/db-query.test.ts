import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPostgrestQuery,
  encodeFilterValue,
  eq,
  gte,
  inList,
  isNull,
  like,
  neq,
} from '../lib/db/query.ts';

test('buildPostgrestQuery: empty spec renders an empty string', () => {
  assert.equal(buildPostgrestQuery(), '');
  assert.equal(buildPostgrestQuery({}), '');
});

test('buildPostgrestQuery: renders the shapes the real call sites use', () => {
  assert.equal(
    buildPostgrestQuery({ where: { id: eq('abc') } }),
    'id=eq.abc',
  );
  assert.equal(
    buildPostgrestQuery({ where: { tenant_id: eq('t1'), is_active: eq(true) } }),
    'tenant_id=eq.t1&is_active=eq.true',
  );
  assert.equal(
    buildPostgrestQuery({ select: ['id'], limit: 1 }),
    'select=id&limit=1',
  );
  assert.equal(
    buildPostgrestQuery({ where: { id: inList(['a', 'b', 'c']) } }),
    'id=in.(a,b,c)',
  );
});

test('buildPostgrestQuery: ordering and paging', () => {
  assert.equal(
    buildPostgrestQuery({ order: { column: 'created_at', ascending: false }, limit: 10, offset: 20 }),
    'order=created_at.desc&limit=10&offset=20',
  );
  assert.equal(buildPostgrestQuery({ order: { column: 'name' } }), 'order=name.asc');
});

test('buildPostgrestQuery: output is deterministic for the same spec', () => {
  const spec = { where: { a: eq('1'), b: neq('2') }, select: ['x', 'y'], limit: 3 };
  assert.equal(buildPostgrestQuery(spec), buildPostgrestQuery(spec));
});

test('operators render their PostgREST forms', () => {
  assert.equal(buildPostgrestQuery({ where: { n: gte(5) } }), 'n=gte.5');
  // '%' is percent-encoded for the URL; PostgREST decodes it back to 'ab%'.
  assert.equal(buildPostgrestQuery({ where: { s: like('ab%') } }), 's=like.ab%25');
  assert.equal(buildPostgrestQuery({ where: { d: isNull() } }), 'd=is.null');
  assert.equal(buildPostgrestQuery({ where: { v: eq(null) } }), 'v=eq.null');
});

// ── Value encoding: the part hand-built strings got right only by accident ──

test('encodeFilterValue: quotes values containing PostgREST syntax characters', () => {
  // A comma is the killer: unquoted, "a,b" inside in.(...) becomes TWO values.
  assert.equal(encodeFilterValue('a,b'), '"a,b"');
  assert.equal(encodeFilterValue('a.b'), '"a.b"');
  assert.equal(encodeFilterValue('a(b)'), '"a(b)"');
  assert.equal(encodeFilterValue('a b'), '"a b"');
});

test('encodeFilterValue: escaping only matters inside a QUOTED value', () => {
  // A quote is itself reserved, so the value is quoted and the inner quote escaped.
  assert.equal(encodeFilterValue('a"b'), '"a\\"b"');
  // A lone backslash is not PostgREST syntax, so it needs no quoting — the URL
  // layer percent-encodes it. Asserting otherwise was testing a contract the
  // code never had.
  assert.equal(encodeFilterValue('a\\b'), 'a\\b');
  // But once another reserved character forces quoting, the backslash MUST be
  // escaped or it could terminate the quoted value early.
  assert.equal(encodeFilterValue('a,b\\c'), '"a,b\\\\c"');
});

test('encodeFilterValue: leaves simple values untouched', () => {
  assert.equal(encodeFilterValue('abc123'), 'abc123');
  assert.equal(encodeFilterValue('a-b_c'), 'a-b_c');
  assert.equal(encodeFilterValue(42), '42');
  assert.equal(encodeFilterValue(true), 'true');
  assert.equal(encodeFilterValue(null), 'null');
  assert.equal(encodeFilterValue(''), '""');
});

test('an email with a comma cannot split an in.() list', () => {
  // The concrete failure this prevents: one filter value silently becoming
  // two, merging or losing a customer. The comma inside the address is
  // quoted AND percent-encoded; only the separator commas stay literal.
  const q = buildPostgrestQuery({ where: { email: inList(['a,b@x.com', 'c@x.com']) } });
  assert.equal(q, 'email=in.(%22a%2Cb%40x.com%22,%22c%40x.com%22)');
  const inner = q.slice('email=in.('.length, -1);
  assert.equal(inner.split(',').length, 2, 'the address comma leaked as a separator');
});

test('a value cannot inject an extra filter clause', () => {
  // Double-quoting alone does NOT stop this: the URL layer splits on '&'
  // before PostgREST ever sees the quotes. Percent-encoding is what makes it
  // safe, and this test is why that was found.
  const q = buildPostgrestQuery({ where: { id: eq('x&role=eq.admin') } });
  assert.equal(q, 'id=eq.%22x%26role%3Deq.admin%22');
  assert.equal(q.split('&').length, 1, `injection split the query: ${q}`);
  assert.ok(!q.includes('role=eq.admin'), 'an injected clause survived verbatim');
});

// ── Identifiers are validated, never interpolated blindly ──────────────────

test('invalid column names throw instead of being interpolated', () => {
  assert.throws(() => buildPostgrestQuery({ where: { 'id&role': eq('x') } }), /Invalid filter column/);
  assert.throws(() => buildPostgrestQuery({ select: ['id,secret'] }), /Invalid select column/);
  assert.throws(() => buildPostgrestQuery({ order: { column: 'a b' } }), /Invalid order column/);
});

test('invalid paging values throw', () => {
  assert.throws(() => buildPostgrestQuery({ limit: -1 }), /Invalid limit/);
  assert.throws(() => buildPostgrestQuery({ limit: 1.5 }), /Invalid limit/);
  assert.throws(() => buildPostgrestQuery({ offset: -5 }), /Invalid offset/);
});
