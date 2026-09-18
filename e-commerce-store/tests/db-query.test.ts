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
  // '.' is NOT reserved: only the first dot splits operator from value, so
  // quoting every dotted value (every email, every dotted id) changed request
  // bytes against the pre-port code for nothing.
  assert.equal(encodeFilterValue('a.b'), 'a.b');
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
  // Only the value containing a comma needs quoting; the plain one does not.
  assert.equal(q, 'email=in.(%22a%2Cb%40x.com%22,c%40x.com)');
  const inner = q.slice('email=in.('.length, -1);
  assert.equal(inner.split(',').length, 2, 'the address comma leaked as a separator');
});

test('a value cannot inject an extra filter clause', () => {
  // Double-quoting alone does NOT stop this: the URL layer splits on '&'
  // before PostgREST ever sees the quotes. Percent-encoding is what makes it
  // safe, and this test is why that was found.
  const q = buildPostgrestQuery({ where: { id: eq('x&role=eq.admin') } });
  // Percent-encoding alone keeps this one clause; '&' is not a PostgREST
  // filter-grammar character, so no quoting is required for safety here.
  assert.equal(q, 'id=eq.x%26role%3Deq.admin');
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

// ── Embedded relations (PostgREST nested select) ──────────────────────────

test('select: renders an embedded relation', () => {
  assert.equal(
    buildPostgrestQuery({ select: ['option_label', 'price_cents', { relation: 'products', columns: ['name'] }] }),
    'select=option_label,price_cents,products(name)',
  );
});

test('select: renders a nested embed, matching the cart-items query', () => {
  assert.equal(
    buildPostgrestQuery({
      select: [
        'quantity',
        'unit_price_cents',
        {
          relation: 'product_variants',
          columns: ['option_label', 'checkout_mode', { relation: 'products', columns: ['external_id', 'name'] }],
        },
      ],
    }),
    'select=quantity,unit_price_cents,product_variants(option_label,checkout_mode,products(external_id,name))',
  );
});

test('select: embeds validate their identifiers too', () => {
  assert.throws(
    () => buildPostgrestQuery({ select: [{ relation: 'products),secret(', columns: ['name'] }] }),
    /Invalid embedded relation/,
  );
  assert.throws(
    () => buildPostgrestQuery({ select: [{ relation: 'products', columns: ['name,secret'] }] }),
    /Invalid select column/,
  );
});

test('select: an empty embed is rejected rather than rendering "rel()"', () => {
  assert.throws(() => buildPostgrestQuery({ select: [{ relation: 'products', columns: [] }] }), /needs at least one column/);
});

test('a SCALAR filter is never quoted — quoting it silently matches nothing', () => {
  // This test previously asserted the opposite, on the belief that eq.null
  // matches SQL NULL so the literal text 'null' had to be quoted. Checked
  // against the live PostgREST, all three parts of that belief were wrong:
  //
  //   eq."null"                 -> 0 rows
  //   eq.null                   -> MATCHED THE ROW WHOSE TEXT WAS 'null'
  //   eq."contact:x@y"          -> 0 rows, while eq.contact%3Ax%40y matched
  //
  // Quoting a scalar makes the quotes part of the compared value, so the filter
  // returns nothing — and "nothing" is indistinguishable from "no rows matched".
  assert.equal(buildPostgrestQuery({ where: { v: eq('null') } }), 'v=eq.null');
  assert.equal(buildPostgrestQuery({ where: { v: eq('true') } }), 'v=eq.true');
  assert.equal(buildPostgrestQuery({ where: { v: eq(null) } }), 'v=eq.null');
  assert.equal(buildPostgrestQuery({ where: { v: eq(true) } }), 'v=eq.true');
});

test('REGRESSION: a scalar value with reserved characters still matches', () => {
  // The bug that surfaced this: usage_events keyed 'contact:<email>' returned
  // zero rows for records that demonstrably existed, because the colon forced
  // quoting. Percent-encoding alone is what the backend accepts.
  assert.equal(
    buildPostgrestQuery({ where: { reference: eq('contact:a@b.co') } }),
    'reference=eq.contact%3Aa%40b.co',
  );
  assert.equal(buildPostgrestQuery({ where: { v: eq('a b') } }), 'v=eq.a%20b');
  assert.equal(buildPostgrestQuery({ where: { v: eq('a(b)') } }), 'v=eq.a(b)');
  // '&' must still be encoded or it would start a new filter clause.
  assert.equal(
    buildPostgrestQuery({ where: { v: eq('x&role=eq.admin') } }),
    'v=eq.x%26role%3Deq.admin',
  );
});

test('in.(...) KEEPS its quoting — there the commas are structural', () => {
  // Verified live: in.("a,b") matched, in.(a%2Cb) did not. The comma inside an
  // in-list separates values, so a value containing one must be quoted.
  assert.equal(
    buildPostgrestQuery({ where: { v: inList(['a,b', 'c']) } }),
    'v=in.(%22a%2Cb%22,c)',
  );
});

test("select: '*' is allowed as the select-everything wildcard", () => {
  assert.equal(buildPostgrestQuery({ select: ['*'], limit: 1 }), 'select=*&limit=1');
  // ...but it is the ONLY non-identifier permitted.
  assert.throws(() => buildPostgrestQuery({ select: ['*,secret'] }), /Invalid select column/);
});

test('order: multiple columns render in sequence', () => {
  assert.equal(
    buildPostgrestQuery({ order: [{ column: 'variant_id' }, { column: 'min_quantity' }] }),
    'order=variant_id.asc,min_quantity.asc',
  );
  assert.equal(
    buildPostgrestQuery({ order: [{ column: 'a', ascending: false }, { column: 'b' }] }),
    'order=a.desc,b.asc',
  );
});

test('order: a single column still works unchanged', () => {
  assert.equal(buildPostgrestQuery({ order: { column: 'created_at', ascending: false } }), 'order=created_at.desc');
});

test('order: every column in a multi-column order is validated', () => {
  assert.throws(() => buildPostgrestQuery({ order: [{ column: 'ok' }, { column: 'bad,col' }] }), /Invalid order column/);
});

test('AUDIT: the real call sites that the quoting bug broke', () => {
  // Audited after the bug was found. These are the two places in the codebase
  // that filtered a TEXT column by a value containing a reserved character,
  // and both were silently returning zero rows:
  //
  //   lib/ai-assistant/tools.ts   name = 'AI Assistant Discounts'  (spaces)
  //     -> the "does this price list already exist" check never matched, so a
  //        duplicate price list would be created on every use.
  //   app/api/admin/theme/route.ts  name = the theme's name, default
  //     'Default Theme' (space) -> upsert-by-name never matched, so every save
  //        inserted a new row instead of updating, leaving orphaned themes.
  //
  // Neither feature had been used in production (both tables were empty), so
  // there was no damage to repair. These assertions exist so the shapes cannot
  // silently break again.
  assert.equal(
    buildPostgrestQuery({ where: { name: eq('AI Assistant Discounts') } }),
    'name=eq.AI%20Assistant%20Discounts',
  );
  assert.equal(
    buildPostgrestQuery({ where: { name: eq('Default Theme') } }),
    'name=eq.Default%20Theme',
  );
});

test('AUDIT: the column types that were NEVER affected', () => {
  // Verified against the live database: Postgres strips the quotes while
  // casting a quoted literal to a non-text type, so timestamptz and uuid
  // filters matched correctly even while quoted. That is why no date-range
  // read in the system was ever broken — the blast radius was text columns
  // only, which is what made the audit tractable.
  const iso = '2026-09-01T00:00:00.000Z';
  assert.equal(
    buildPostgrestQuery({ where: { occurred_at: gte(iso) } }),
    'occurred_at=gte.2026-09-01T00%3A00%3A00.000Z',
  );
  // A uuid contains no reserved characters at all, so it never changed form.
  assert.equal(
    buildPostgrestQuery({ where: { id: eq('00000000-0000-4000-8000-000000000001') } }),
    'id=eq.00000000-0000-4000-8000-000000000001',
  );
});
