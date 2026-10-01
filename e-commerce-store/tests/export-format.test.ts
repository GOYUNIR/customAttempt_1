import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRows, parseExportRequest, consentLabel } from '../lib/export-format.ts';

test('CSV cells: quoted when needed, quotes doubled', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(1900), '1900');
});

test('CSV cells: anything a spreadsheet would run as a formula arrives as text', () => {
  for (const evil of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])
    assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), evil);
  assert.equal(csvCell('=1,2'), '"\'=1,2"');
});

test('CSV rows: header once, CRLF line ends', () => {
  const out = csvRows(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2 }], true);
  assert.equal(out, 'a,b\r\n1,x\r\n2,\r\n');
  assert.equal(csvRows(['a'], [{ a: 1 }], false), '1\r\n');
});

test('requests: only the three datasets, two formats, a sane page', () => {
  assert.deepEqual(parseExportRequest(new URLSearchParams('dataset=orders&format=json&page=2')), { ok: true, dataset: 'orders', format: 'json', page: 2 });
  for (const q of ['dataset=users', 'dataset=orders&format=xml', 'dataset=orders&page=-1', 'dataset=orders&page=1.5', 'dataset=tenants'])
    assert.equal(parseExportRequest(new URLSearchParams(q)).ok, false, q);
});

test('consent: never asked is not declined', () => {
  assert.equal(consentLabel(true), 'opted_in');
  assert.equal(consentLabel(false), 'declined');
  assert.equal(consentLabel(null), 'never_asked');
});
