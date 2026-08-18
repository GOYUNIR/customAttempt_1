import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeConfigKey,
  sizeConfigsOf,
  getSizeReleaseEndsAt,
  getSizeCustomSchedule,
  resolveSizeReleaseEndsAt,
  resolveSizeSchedule,
  normalizeSizeConfigs,
} from '../lib/size-configs.ts';

// A multi-size RAFFLE product where each size has its OWN raffle config
// ("customize each raffle differently") — Collector draws on its own timer.
const PRODUCT = {
  name: 'Obsidian Void — Priority Draw',
  checkoutMode: 'RAFFLE',
  releaseEndsAt: '2026-08-20T18:00',
  customDropSchedule: { mode: 'daily', timezone: 'America/Los_Angeles', drawHour: 21, drawMinute: 0, drawSecond: 0, customIntervalHours: 24, targetEndDateTime: '' },
  priceCategories: [
    { size: 'Standard', price: 110, winnerTiers: '2,2,1' },
    { size: 'Collector', price: 175, winnerTiers: '1,1' },
  ],
  sizeConfigs: {
    standard: {},
    collector: {
      releaseEndsAt: '2026-08-25T19:00',
      customDropSchedule: { mode: 'daily', timezone: 'America/Los_Angeles', targetEndDateTime: '', drawDayOfWeek: 6, drawDayOfMonth: 1, drawHour: 19, drawMinute: 0, drawSecond: 0, customIntervalHours: 24 },
    },
  },
};

test('sizeConfigKey normalizes labels consistently', () => {
  assert.equal(sizeConfigKey('  Standard '), 'standard');
  assert.equal(sizeConfigKey('Collector'), 'collector');
  assert.equal(sizeConfigKey(''), '');
});

test('sizeConfigsOf returns a sanitized map keyed by normalized label', () => {
  const configs = sizeConfigsOf(PRODUCT);
  // `standard: {}` means "inherit everything" → no recognized fields → dropped.
  assert.deepEqual(Object.keys(configs).sort(), ['collector']);
  assert.equal(configs.collector.releaseEndsAt, '2026-08-25T19:00');
  assert.equal(configs.collector.customDropSchedule?.drawHour, 19);
  // A size with an explicitly configured record IS kept.
  assert.deepEqual(
    Object.keys(sizeConfigsOf({ sizeConfigs: { standard: { releaseEndsAt: '2026-08-21T18:00' } } })),
    ['standard'],
  );
  // Malformed input never throws and drops garbage entries.
  assert.deepEqual(sizeConfigsOf({ sizeConfigs: { ok: null, bad: 'nope', fine: { releaseEndsAt: '2026-08-25T19:00' } } }).fine, { releaseEndsAt: '2026-08-25T19:00' });
  assert.deepEqual(sizeConfigsOf(null), {});
});

test('getSizeReleaseEndsAt / resolveSizeReleaseEndsAt: per-size wins over product', () => {
  assert.equal(getSizeReleaseEndsAt(PRODUCT, 'Collector'), '2026-08-25T19:00');
  // Standard has an empty record → inherits the product value.
  assert.equal(getSizeReleaseEndsAt(PRODUCT, 'Standard'), '');
  assert.equal(resolveSizeReleaseEndsAt(PRODUCT, 'Standard'), '2026-08-20T18:00');
  assert.equal(resolveSizeReleaseEndsAt(PRODUCT, 'Collector'), '2026-08-25T19:00');
});

test('getSizeCustomSchedule: per-size schedule wins, absent inherits', () => {
  assert.equal(getSizeCustomSchedule(PRODUCT, 'Collector')?.drawHour, 19);
  assert.equal(getSizeCustomSchedule(PRODUCT, 'Standard'), undefined);
});

test('resolveSizeSchedule merges per-size → product → global in order', () => {
  const global = { mode: 'daily', timezone: 'America/New_York', drawHour: 9, drawMinute: 0 };
  const standard = resolveSizeSchedule(PRODUCT, 'Standard', global);
  // Standard inherits product schedule (which merged over global → product tz/hour win).
  assert.equal(standard.timezone, 'America/Los_Angeles');
  assert.equal(standard.drawHour, 21);
  // Collector's own schedule wins over the product-level one.
  const collector = resolveSizeSchedule(PRODUCT, 'Collector', global);
  assert.equal(collector.drawHour, 19);
});

test('normalizeSizeConfigs keeps only real sizes and clean fields', () => {
  const cats = PRODUCT.priceCategories;
  const normalized = normalizeSizeConfigs(
    {
      standard: { releaseEndsAt: '2026-08-21T18:00' },
      collector: { releaseEndsAt: '2026-08-25T19:00', customDropSchedule: { mode: 'daily', drawHour: 19, drawMinute: 0, drawSecond: 0, customIntervalHours: 24 } },
      // Config for a size that does NOT exist — must be dropped.
      ghost: { releaseEndsAt: '2026-08-26T00:00' },
    },
    cats,
  );
  assert.equal(normalized.ghost, undefined);
  assert.equal(normalized.standard.releaseEndsAt, '2026-08-21T18:00');
  assert.equal(normalized.collector.customDropSchedule?.mode, 'daily');
  // Malformed schedules / values are sanitized, never stored raw.
  const clean = normalizeSizeConfigs({ standard: { releaseEndsAt: '  ', customDropSchedule: { mode: 'bogus' } } }, cats);
  assert.equal(clean.standard, undefined);
  assert.equal(Object.keys(clean).length, 0);
});
