/**
 * ─────────────────────────────────────────────────────────────────────────────
 * QUIET HOURS — do not send marketing into someone's night.
 *
 * Zero imports (mirrors lib/edge-router.ts / lib/theme-schema.ts) so the gate is
 * testable without a database and usable from any runtime.
 *
 * THE WINDOW IS THE RECIPIENT'S LOCAL TIME, not ours. A merchant in London
 * running a campaign at 10am sends into 2am for a customer in Los Angeles. A
 * server-time check would call that fine, which is precisely the mistake the
 * rule exists to prevent.
 *
 * 21:00-09:00 is deliberately WIDER than the 8pm-8am that US telemarketing rules
 * use for calls. Costing a send an extra hour is cheap; the alternative is a
 * push notification at 7:55am and a complaint. Marketing modules only —
 * transactional messages (a failed payment, an order confirmation) are exempt,
 * because withholding those overnight helps nobody.
 *
 * WITHOUT A KNOWN TIMEZONE this returns NOT quiet, and says which zone it
 * assumed. That is the deliberate direction: refusing every send to a contact
 * whose timezone we never captured would silently disable the module for most
 * of a list. The honest fix is to capture the timezone, and `zone` in the
 * result makes it visible that we are guessing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** No marketing sends at or after this local hour. */
export const QUIET_START_HOUR = 21;
/** Marketing sends resume at this local hour. */
export const QUIET_END_HOUR = 9;

/** Used when a contact has no timezone of their own. */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

export type QuietHoursResult = {
  quiet: boolean;
  localHour: number;
  zone: string;
  /** When sending becomes allowed again, ISO. Null when it already is. */
  nextAllowedIso: string | null;
  /** True when `zone` is a fallback rather than the contact's own. */
  assumedZone: boolean;
};

/**
 * The hour of day at `date` in `timeZone`, or null if the zone is unusable.
 *
 * Uses Intl rather than a fixed offset so daylight saving is handled by the
 * platform's own tz database. A hardcoded offset is wrong twice a year, in the
 * direction of sending an hour too early.
 */
export function localHourIn(date: Date, timeZone: string): number | null {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(date);
    const parsed = Number(hour);
    // Intl renders midnight as "24" in some environments.
    if (!Number.isFinite(parsed)) return null;
    return parsed === 24 ? 0 : parsed;
  } catch {
    return null;
  }
}

export function isWithinQuietHours(now: Date, timeZone: string | null): QuietHoursResult {
  const requested = String(timeZone || '').trim();
  const assumedZone = requested.length === 0;
  let zone = assumedZone ? DEFAULT_TIMEZONE : requested;

  let hour = localHourIn(now, zone);
  if (hour === null) {
    // An unrecognised zone string is a data problem, not a reason to send at
    // 3am — fall back to the default zone rather than to "not quiet".
    zone = DEFAULT_TIMEZONE;
    hour = localHourIn(now, zone) ?? 12;
  }

  // The window wraps midnight, so it is an OR, not a range.
  const quiet = hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;

  return {
    quiet,
    localHour: hour,
    zone,
    nextAllowedIso: quiet ? nextAllowedTime(now, hour).toISOString() : null,
    assumedZone,
  };
}

/**
 * When the quiet window ends, as an absolute time.
 *
 * Computed by adding whole hours rather than by constructing a local date,
 * because building "09:00 tomorrow in Los Angeles" from a UTC Date is exactly
 * where DST bugs live. Hours-until is the same number in any zone.
 */
function nextAllowedTime(now: Date, localHour: number): Date {
  const hoursUntilNine =
    localHour < QUIET_END_HOUR
      ? QUIET_END_HOUR - localHour
      : 24 - localHour + QUIET_END_HOUR;
  return new Date(now.getTime() + hoursUntilNine * 3_600_000);
}
