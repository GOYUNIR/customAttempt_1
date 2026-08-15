import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShippingAddress, validateShippingAddress } from '../lib/address-validation.ts';

const INVALID = [
  '',
  '123 realstreet',
  '123 Real Street, Los Angeles',
  '123 Luxury Dr, New York, NY',
  'Los Angeles, CA 90210, United States',
  'Main Street, Los Angeles, CA 90210, United States',
  '123 Main St, Los Angeles, CA, United States', // no ZIP
  'asdf',
  '1234567890',
];

const VALID = [
  '123 Main Street, Los Angeles, CA 90210, United States',
  '1600 Pennsylvania Ave NW, Washington, DC 20500, United States',
  '123 Main St, Los Angeles, CA 90210, USA',
  '88 Cool Street, Austin, Texas 78701, United States',
  '10 Downing Street, London, SW1A 2AA, United Kingdom',
  '123 Main St, Toronto, ON M5V 2T6, Canada',
  'Bahnhofstrasse 10, Zurich, 8001, Switzerland',
  '123 Main St, Los Angeles, CA 90210-1234, United States',
];

test('rejects empty, garbage and partial addresses', () => {
  for (const address of INVALID) {
    assert.notEqual(
      validateShippingAddress(address),
      null,
      `expected "${address}" to be rejected`
    );
  }
});

test('accepts complete US / international addresses', () => {
  for (const address of VALID) {
    assert.equal(
      validateShippingAddress(address),
      null,
      `expected "${address}" to pass`
    );
  }
});

test('parses address components', () => {
  const result = parseShippingAddress('123 Main Street, Los Angeles, CA 90210, United States');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.parsed.street, '123 Main Street');
  assert.equal(result.parsed.city, 'Los Angeles');
  assert.equal(result.parsed.state, 'CA');
  assert.equal(result.parsed.postal, '90210');
  assert.equal(result.parsed.country, 'United States');
  assert.equal(result.parsed.countryCode, 'US');
});

test('reports the specific missing component', () => {
  assert.match(validateShippingAddress('123 Main Street, Los Angeles, CA 90210') || '', /dropdown/i);
  assert.match(validateShippingAddress('123 Main Street, Los Angeles, CA, United States') || '', /dropdown/i);
  assert.match(validateShippingAddress('Los Angeles, CA 90210, United States') || '', /dropdown/i);
});
