/**
 * Store-timezone-aware parsing for drop schedule timestamps
 * (`goLiveAt`, `releaseEndsAt`, `availableFrom`, `soldOutAt`, …).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The admin portal saves drop times as NAIVE wall-clock strings
 * (`"2026-08-15T06:16"` — no `Z`, no offset, no timezone name). Different
 * pieces of the stack used to parse those strings with the platform's LOCAL
 * timezone:
 *
 *   - the product-page countdown ran in the BROWSER's timezone
 *   - the draw engine (`lib/auto-draw.ts`) ran in the SERVER's timezone (UTC)
 *   - the catalog/home lifecycle checks ran in the browser again
 *
 * so the same string meant different instants to different observers. A buyer
 * in California setting a 6:16 AM drop meant 6:16 AM store time, but a browser
 * in Europe (or the UTC server) read 6:16 AM LOCAL — hours earlier/later —
 * which is exactly why a countdown could hit zero "on time" and the server
 * still treat the pool as not-due (or vice-versa), and why a product whose
 * release had already ended re-anchored to the NEXT global drop (a week away)
 * instead of triggering a draw.
 *
 * The fix: EVERY consumer of these fields interprets a naive string as being
 * in the STORE's configured timezone (`store:config.dropSchedule.timezone`,
 * fallback `GOYUNIR_STORE_SUITE.dropSchedule.timezone`), so the browser
 * countdown, the server draw engine and the lifecycle checks all agree on the
 * same absolute instant. Strings that already carry an explicit timezone
 * marker (`Z`, `±HH:MM`, or a `Region/City` name) are parsed natively and
 * never reinterpreted.
 *
 * This module is intentionally dependency-light (no `@/` imports, no
 * server-only packages) so it can run in the browser AND on the server AND in
 * the node --test runner.
 */

/**
 * Build an absolute epoch-ms timestamp for a wall-clock time expressed in the
 * given IANA timezone (e.g. `"America/Los_Angeles"`). This is the inverse of
 * `Intl.DateTimeFormat.formatToParts`: we guess a UTC instant, read back the
 * offset the timezone actually used for that instant, and correct.
 */
function wallClockToTimestamp(opts: {
  timezone: string;
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second?: number;
}): number {
  const { timezone, year, month, day, hour, minute } = opts;
  const second = Math.max(0, Math.min(59, Number(opts.second) || 0));
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcGuess));
    const map: Record<string, string> = {};
    parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
    const asIfUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second || 0),
    );
    offset = asIfUTC - utcGuess;
  } catch {
    /* unknown timezone → fall back to interpreting as UTC (native Date) */
  }
  return utcGuess - offset;
}

/** Does the string carry an explicit timezone marker? */
function hasExplicitTimezone(value: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2}(:\d{2})?$|[A-Za-z_]+\/[A-Za-z_]+$)/.test(value.trim());
}

/**
 * Parse a drop timestamp into an absolute epoch-ms value.
 *
 * - `null`/empty → `null`
 * - explicit timezone (`2026-08-15T06:16Z`, `…+02:00`, `… America/New_York`) →
 *   native `Date` parsing (never reinterpreted)
 * - naive wall-clock (`2026-08-15T06:16` or `2026-08-15 06:16`) → interpreted
 *   as being in `storeTimezone` (e.g. `"America/Los_Angeles"`)
 * - anything unparseable → `null`
 */
export function dropTimestampToMs(value: unknown, storeTimezone?: string): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (hasExplicitTimezone(raw)) {
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (
    Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) ||
    Number.isNaN(hour) || Number.isNaN(minute)
  ) {
    return null;
  }
  return wallClockToTimestamp({
    timezone: String(storeTimezone || 'UTC'),
    year,
    month,
    day,
    hour,
    minute,
    second: s ? Number(s) : 0,
  });
}

/** Same as `dropTimestampToMs`, but returns `NaN` for invalid input. */
export function dropTimestampToMsOrNaN(value: unknown, storeTimezone?: string): number {
  const ms = dropTimestampToMs(value, storeTimezone);
  return ms === null ? NaN : ms;
}
