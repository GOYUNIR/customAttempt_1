import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampLegalUpdated, legalUpdatedDate } from '../lib/legal-config.ts';

const day1 = new Date('2026-03-01T10:00:00Z');
const day2 = new Date('2026-04-15T10:00:00Z');

test('a policy gets a date only when its own text changes', () => {
  const first = stampLegalUpdated({}, { terms: 'T1', privacy: '', shipping: '' }, day1);
  assert.deepEqual(first.updatedAt, { terms: '2026-03-01' });
  const second = stampLegalUpdated(first, { ...first, privacy: 'P1' }, day2);
  assert.deepEqual(second.updatedAt, { terms: '2026-03-01', privacy: '2026-04-15' });
});

test('saving unchanged text (or whitespace-only edits) keeps the old date', () => {
  const first = stampLegalUpdated({}, { terms: 'T1' }, day1);
  const again = stampLegalUpdated(first, { terms: '  T1\n', companyName: 'New name' }, day2);
  assert.equal(again.updatedAt.terms, '2026-03-01');
});

test('the incoming body cannot set or backdate a date', () => {
  const stored = stampLegalUpdated({}, { terms: 'T1' }, day1);
  const forged = stampLegalUpdated(stored, { terms: 'T1', updatedAt: { terms: '1999-01-01', privacy: '1999-01-01' } }, day2);
  assert.deepEqual(forged.updatedAt, { terms: '2026-03-01' });
});

test('no recorded date means no "Last updated" line, never today', () => {
  assert.equal(legalUpdatedDate({ terms: 'old text, no date' }, 'terms'), null);
  assert.equal(legalUpdatedDate(undefined, 'terms'), null);
  assert.equal(legalUpdatedDate({ updatedAt: { terms: 'garbage' } }, 'terms'), null);
  assert.equal(legalUpdatedDate({ updatedAt: { terms: '2026-03-01' } }, 'terms'), '2026-03-01');
});
