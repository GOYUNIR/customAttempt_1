import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWithinQuietHours, localHourIn, QUIET_START_HOUR, QUIET_END_HOUR, DEFAULT_TIMEZONE,
} from '../lib/growth/quiet-hours.ts';

test('quiet hours are the RECIPIENT’s local time, not the server’s', () => {
  // 17:00 UTC is 10am in Los Angeles (fine) and 2am in Tokyo (not fine).
  // A server-time check would call both fine, which is the whole bug.
  const at17utc = new Date('2026-03-17T17:00:00Z');
  assert.equal(isWithinQuietHours(at17utc, 'America/Los_Angeles').quiet, false);
  assert.equal(isWithinQuietHours(at17utc, 'Asia/Tokyo').quiet, true);
});

test('the window wraps midnight', () => {
  const zone = 'UTC';
  const quietAt = (h: number) =>
    isWithinQuietHours(new Date(`2026-03-17T${String(h).padStart(2, '0')}:30:00Z`), zone).quiet;
  assert.equal(quietAt(22), true);   // late evening
  assert.equal(quietAt(2), true);    // small hours
  assert.equal(quietAt(8), true);    // just before the window ends
  assert.equal(quietAt(9), false);   // window ends
  assert.equal(quietAt(14), false);  // afternoon
  assert.equal(quietAt(20), false);  // just before it starts
  assert.equal(quietAt(21), true);   // window starts
});

test('the boundaries match the declared constants', () => {
  const at = (h: number) => isWithinQuietHours(new Date(`2026-06-01T${String(h).padStart(2, '0')}:00:00Z`), 'UTC').quiet;
  assert.equal(at(QUIET_END_HOUR), false, 'sends resume exactly at QUIET_END_HOUR');
  assert.equal(at(QUIET_START_HOUR), true, 'sends stop exactly at QUIET_START_HOUR');
});

test('an unknown timezone falls back to a zone and SAYS SO, rather than sending at 3am', () => {
  const r = isWithinQuietHours(new Date('2026-03-17T17:00:00Z'), null);
  assert.equal(r.assumedZone, true, 'the guess must be visible');
  assert.equal(r.zone, DEFAULT_TIMEZONE);

  // A garbage zone string is a data problem, not permission to send.
  const bad = isWithinQuietHours(new Date('2026-03-17T09:00:00Z'), 'Not/A_Zone');
  assert.equal(bad.zone, DEFAULT_TIMEZONE, 'falls back to a real zone');
  assert.equal(typeof bad.quiet, 'boolean');
});

test('a blocked send says when it may be retried', () => {
  const quiet = isWithinQuietHours(new Date('2026-03-17T06:00:00Z'), 'UTC'); // 6am UTC
  assert.equal(quiet.quiet, true);
  assert.ok(quiet.nextAllowedIso, 'must say when it can retry');
  const resumesAt = new Date(quiet.nextAllowedIso!);
  assert.equal(localHourIn(resumesAt, 'UTC'), QUIET_END_HOUR, 'resumes at 9am local');

  const open = isWithinQuietHours(new Date('2026-03-17T12:00:00Z'), 'UTC');
  assert.equal(open.nextAllowedIso, null, 'nothing to say when it is already allowed');
});

test('DST is handled by the platform tz database, not a fixed offset', () => {
  // New York is UTC-4 in July and UTC-5 in January. 01:00 UTC is therefore
  // 9pm the previous evening in summer (quiet) and 8pm in winter (not quiet).
  // A hardcoded offset gets one of these wrong, in the direction of sending early.
  const summer = isWithinQuietHours(new Date('2026-07-15T01:00:00Z'), 'America/New_York');
  const winter = isWithinQuietHours(new Date('2026-01-15T01:00:00Z'), 'America/New_York');
  assert.equal(summer.localHour, 21);
  assert.equal(winter.localHour, 20);
  assert.equal(summer.quiet, true);
  assert.equal(winter.quiet, false);
});
