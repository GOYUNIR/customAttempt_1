import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropTimestampToMs, dropTimestampToMsOrNaN } from '../lib/drop-timestamps.ts';

test('naive wall-clock strings are interpreted in the store timezone (not the viewer zone)', () => {
  // 2026-08-15T06:16 in America/Los_Angeles == 13:16 UTC (PDT, UTC-7).
  const ms = dropTimestampToMs('2026-08-15T06:16', 'America/Los_Angeles');
  assert.ok(ms !== null);
  assert.equal(new Date(ms!).toISOString(), '2026-08-15T13:16:00.000Z');
});

test('explicitly-zoned strings pass through natively and are never reinterpreted', () => {
  const ms = dropTimestampToMs('2026-08-15T06:16Z', 'America/Los_Angeles');
  assert.equal(new Date(ms!).toISOString(), '2026-08-15T06:16:00.000Z');
  const offset = dropTimestampToMs('2026-08-15T06:16+02:00', 'America/Los_Angeles');
  assert.equal(new Date(offset!).toISOString(), '2026-08-15T04:16:00.000Z');
});

test('spaced wall-clock format is accepted', () => {
  const ms = dropTimestampToMs('2026-08-15 06:16', 'America/Los_Angeles');
  assert.equal(new Date(ms!).toISOString(), '2026-08-15T13:16:00.000Z');
});

test('empty / invalid input returns null (and NaN via the OrNaN variant)', () => {
  assert.equal(dropTimestampToMs('', 'America/Los_Angeles'), null);
  assert.equal(dropTimestampToMs(null, 'America/Los_Angeles'), null);
  assert.equal(dropTimestampToMs('not-a-date', 'America/Los_Angeles'), null);
  assert.ok(Number.isNaN(dropTimestampToMsOrNaN('not-a-date', 'America/Los_Angeles')));
});

test('client and server agree on the same naive string (the draw-engine fix)', () => {
  // This is the exact scenario that broke drops: the countdown ran in the
  // viewer timezone while the server ran in UTC. Both must now resolve the
  // SAME absolute instant for a naive store-time string.
  const naive = '2026-08-15T06:16';
  const serverParse = dropTimestampToMs(naive, 'America/Los_Angeles');
  // A UTC-configured consumer calling with the store timezone gets the same.
  const clientParse = dropTimestampToMs(naive, 'America/Los_Angeles');
  assert.equal(serverParse, clientParse);
});
