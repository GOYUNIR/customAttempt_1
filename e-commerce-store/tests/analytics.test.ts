import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usageDayStamp,
  usageKey,
  lastDayStamps,
  totalsFromRow,
  EMPTY_USAGE_TOTALS,
} from '../lib/analytics.ts';

test('usageDayStamp is a UTC YYYY-MM-DD string', () => {
  assert.equal(usageDayStamp(Date.UTC(2026, 7, 21, 12, 0, 0)), '2026-08-21');
});

test('usageKey builds analytics:usage:<tenant>:<day> and sanitizes tenant', () => {
  assert.equal(usageKey('analytics:usage', 'Acme Corp!', '2026-08-21'), 'analytics:usage:acme corp!:2026-08-21');
  assert.equal(usageKey('analytics:usage', '', '2026-08-21'), 'analytics:usage:default:2026-08-21');
});

test('lastDayStamps returns newest-first rolling window', () => {
  const stamps = lastDayStamps(3, Date.UTC(2026, 7, 21));
  assert.deepEqual(stamps, ['2026-08-21', '2026-08-20', '2026-08-19']);
});

test('totalsFromRow parses numeric fields and ignores garbage', () => {
  assert.deepEqual(totalsFromRow(null), EMPTY_USAGE_TOTALS);
  assert.deepEqual(totalsFromRow({ api_calls: '12', ai_generations: '3', system_events: 'bogus' }), {
    api_calls: 12,
    ai_generations: 3,
    system_events: 0,
  });
});
