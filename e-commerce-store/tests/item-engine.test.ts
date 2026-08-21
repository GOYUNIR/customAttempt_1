import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ITEM_TYPE_IDS,
  listItemTypes,
  itemTypeHasCapability,
  sanitizeItemType,
  sanitizeItemStatus,
  normalizeRules,
  validateRules,
  validateJsonSchema,
  deepEqual,
} from '../lib/item-engine/index.ts';

test('the registry exposes all six universal item types', () => {
  assert.deepEqual(ITEM_TYPE_IDS, [
    'fcfs',
    'raffle',
    'appointment',
    'table_booking',
    'ticketed_access',
    'subscription',
  ]);
  assert.equal(listItemTypes().length, 6);
  const ids = listItemTypes().map((t) => t.id);
  assert.deepEqual(ids, ITEM_TYPE_IDS);
});

test('itemTypeHasCapability reflects each type', () => {
  assert.equal(itemTypeHasCapability('fcfs', 'instant_checkout'), true);
  assert.equal(itemTypeHasCapability('fcfs', 'raffle_draw'), false);
  assert.equal(itemTypeHasCapability('raffle', 'raffle_draw'), true);
  assert.equal(itemTypeHasCapability('appointment', 'schedule'), true);
  assert.equal(itemTypeHasCapability('table_booking', 'seating'), true);
  assert.equal(itemTypeHasCapability('ticketed_access', 'ticketing'), true);
  assert.equal(itemTypeHasCapability('subscription', 'recurring'), true);
  assert.equal(itemTypeHasCapability('subscription', 'instant_checkout'), false);
});

test('sanitizeItemType + sanitizeItemStatus coerce and reject', () => {
  assert.equal(sanitizeItemType('RAFFLE'), 'raffle');
  assert.equal(sanitizeItemType(' table_booking '), 'table_booking');
  assert.equal(sanitizeItemType('nope'), null);
  assert.equal(sanitizeItemType(undefined), null);
  assert.equal(sanitizeItemStatus('LIVE'), 'live');
  assert.equal(sanitizeItemStatus('archived'), 'archived');
  assert.equal(sanitizeItemStatus('pending'), null);
});

test('validateRules accepts valid fcfs and raffle rules', () => {
  assert.equal(validateRules('fcfs', { priceCents: 1999, inventory: 40 }).ok, true);
  assert.equal(validateRules('raffle', { winnerTiers: [3, 2, 2] }).ok, true);
  assert.equal(
    validateRules('raffle', { winnerTiers: [3], recurring: { mode: 'daily' } }).ok,
    true,
  );
});

test('validateRules rejects bad rules with path-prefixed errors', () => {
  const fcfs = validateRules('fcfs', {});
  assert.equal(fcfs.ok, false);
  assert.ok(fcfs.errors.some((e) => e.includes('priceCents')), fcfs.errors.join('|'));

  const fcfsPrice = validateRules('fcfs', { priceCents: -5 });
  assert.equal(fcfsPrice.ok, false);
  assert.ok(fcfsPrice.errors.some((e) => e.includes('minimum')), fcfsPrice.errors.join('|'));

  const raffle = validateRules('raffle', {});
  assert.equal(raffle.ok, false);
  assert.ok(raffle.errors.some((e) => e.includes('winnerTiers')));

  const extra = validateRules('fcfs', { priceCents: 10, evil: true });
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((e) => e.includes('evil')));
});

test('validateRules enforces appointment + table_booking schedules', () => {
  assert.equal(validateRules('appointment', { durationMinutes: 30 }).ok, true);
  assert.equal(validateRules('appointment', {}).ok, false);
  assert.equal(validateRules('appointment', { durationMinutes: 2 }).ok, false); // below minimum 5
  assert.equal(validateRules('appointment', { durationMinutes: 30, staffIds: 'jane' }).ok, false); // must be array

  assert.equal(validateRules('table_booking', { partySizeMax: 6 }).ok, true);
  assert.equal(validateRules('table_booking', {}).ok, false);

test('validateRules enforces ticketed_access + subscription rules', () => {
  assert.equal(validateRules('ticketed_access', { eventStartsAt: '2026-09-01T20:00:00Z' }).ok, true);
  assert.equal(validateRules('ticketed_access', {}).ok, false);
  // nested ticketTiers are validated
  assert.equal(
    validateRules('ticketed_access', {
      eventStartsAt: '2026-09-01T20:00:00Z',
      ticketTiers: [{ name: 'GA' }],
    }).ok,
    false,
  );
  assert.equal(
    validateRules('ticketed_access', {
      eventStartsAt: '2026-09-01T20:00:00Z',
      ticketTiers: [{ name: 'GA', priceCents: 2500 }],
    }).ok,
    true,
  );

  assert.equal(validateRules('subscription', { priceCents: 3000, interval: 'month' }).ok, true);
  assert.equal(validateRules('subscription', {}).ok, false);
  assert.equal(validateRules('subscription', { priceCents: 3000, interval: 'fortnight' }).ok, false); // bad enum
});

test('validateRules rejects unknown item types', () => {
  const result = validateRules('crypto', {});
  assert.equal(result.ok, false);
  assert.equal(result.itemType, null);
  assert.ok(result.errors[0].includes('Unknown item type'));
});

test('normalizeRules coerces non-objects to {}', () => {
  assert.deepEqual(normalizeRules({ a: 1 }), { a: 1 });
  assert.deepEqual(normalizeRules(null), {});
  assert.deepEqual(normalizeRules(undefined), {});
  assert.deepEqual(normalizeRules([1, 2]), {});
  assert.deepEqual(normalizeRules('nope'), {});
});

test('the JSON Schema validator handles the core keywords', () => {
  const schema = {
    type: 'object' as const,
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' as const, minLength: 2 },
      count: { type: 'integer' as const, minimum: 1 },
      color: { enum: ['red', 'blue'] },
    },
  };
  assert.equal(validateJsonSchema(schema, { name: 'ab', count: 3, color: 'red' }).ok, true);
  assert.equal(validateJsonSchema(schema, { name: 'a' }).ok, false);
  assert.equal(validateJsonSchema(schema, { name: 'ab', extra: 1 }).ok, false);
  assert.equal(validateJsonSchema(schema, { name: 'ab', color: 'green' }).ok, false);
  assert.equal(validateJsonSchema(schema, { count: 3 }).ok, false);

  assert.equal(deepEqual({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual('x', 'x'), true);
  assert.equal(deepEqual(null, undefined), false);
});

  assert.equal(
    validateRules('table_booking', { partySizeMax: 6, availability: { daysOfWeek: [1, 2] } }).ok,
    true,
  );
});
