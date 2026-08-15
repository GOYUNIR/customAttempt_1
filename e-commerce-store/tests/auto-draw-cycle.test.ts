import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEntriesByCycleEnd, dropTimestampToMs } from '../lib/drop-timestamps.ts';

const T1 = dropTimestampToMs('2026-08-15T06:16', 'America/Los_Angeles')!; // 13:16Z
const T2 = T1 + 60 * 60 * 1000; // one hour later — the NEXT cycle's anchor

function entry(registeredAt: string) {
  return JSON.stringify({ email: 'a@b.com', registeredAt });
}

test('entries registered before the cycle end are eligible for the draw', () => {
  const before = entry(new Date(T1 - 60 * 1000).toISOString());
  const exactlyAt = entry(new Date(T1).toISOString());
  const { eligible, carriedOver } = splitEntriesByCycleEnd([before, exactlyAt], T1);
  assert.equal(eligible.length, 2);
  assert.equal(carriedOver.length, 0);
});

test('entries registered AFTER the cycle end carry over to the next round untouched', () => {
  // THE critical regression: a customer enters after the countdown restarted
  // (their entry timestamp is after the ended cycle). They must NOT be drawn.
  const oldEntry = entry(new Date(T1 - 60 * 60 * 1000).toISOString());
  const newEntrant = entry(new Date(T1 + 5 * 60 * 1000).toISOString());
  const { eligible, carriedOver } = splitEntriesByCycleEnd([oldEntry, newEntrant], T1);
  assert.equal(eligible.length, 1, 'only the pre-cycle entry may be drawn');
  assert.equal(carriedOver.length, 1, 'the post-cycle entrant is protected');
  assert.ok(carriedOver[0].includes(new Date(T1 + 5 * 60 * 1000).toISOString()), 'the new entrant survives verbatim');
  assert.ok(!eligible[0].includes(new Date(T1 + 5 * 60 * 1000).toISOString()), 'the new entrant is never drawn');
});

test('entries without a registeredAt timestamp are treated as eligible (never stranded)', () => {
  const legacy = JSON.stringify({ email: 'old@system.com' });
  const { eligible, carriedOver } = splitEntriesByCycleEnd([legacy], T1);
  assert.equal(eligible.length, 1);
  assert.equal(carriedOver.length, 0);
});

test('no cycle boundary (cadence mode) makes every entry eligible', () => {
  const { eligible, carriedOver } = splitEntriesByCycleEnd(
    [entry(new Date(T2).toISOString()), entry(new Date(T1).toISOString())],
    null,
  );
  assert.equal(eligible.length, 2);
  assert.equal(carriedOver.length, 0);
});

test('unparseable entries never break the split and are kept eligible', () => {
  const { eligible, carriedOver } = splitEntriesByCycleEnd(['not-json'], T1);
  assert.equal(eligible.length, 1);
  assert.equal(carriedOver.length, 0);
});

test('the next-cycle entry survives a full pool rewrite (draw + roll-forward)', () => {
  // Simulates the engine's pool rewrite after a cycle-aware draw:
  // eligible entries are shuffled/drawn, then the pool is rebuilt as
  // carriedOver + non-selected eligible.
  const t1Entrant = entry(new Date(T1 - 60 * 1000).toISOString());
  const t2Entrant = entry(new Date(T1 + 10 * 60 * 1000).toISOString());
  const { eligible, carriedOver } = splitEntriesByCycleEnd([t1Entrant, t2Entrant], T1);
  // Draw picks the sole eligible entry (it is charged); the post-cycle entrant
  // is rewritten into the pool for the next round.
  const remaining = [...carriedOver, ...eligible.slice(1)];
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].includes(new Date(T1 + 10 * 60 * 1000).toISOString()), 'the next-cycle entrant survives the rewrite');
});
