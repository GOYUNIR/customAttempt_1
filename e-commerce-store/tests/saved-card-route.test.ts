import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedCardChargeRoute } from '../lib/saved-card-route.ts';

test('R1/R2: the original store charges its platform-saved cards on the platform, exactly as today', () => {
  for (const entryAccount of [null, undefined, '', '  ']) {
    assert.deepEqual(savedCardChargeRoute({ entryAccount, isDefaultStore: true, storeAccount: null }), { ok: true, stripeAccount: null });
  }
  // Even once the original store HAS a connected account, a card saved on the
  // platform before the switch is still charged on the platform: the charge
  // follows the card, not the store's current route.
  assert.deepEqual(savedCardChargeRoute({ entryAccount: null, isDefaultStore: true, storeAccount: 'acct_newStore' }), { ok: true, stripeAccount: null });
});

test('R2: the original store never half-runs its cutover', () => {
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'acct_abc', isDefaultStore: true, storeAccount: 'acct_abc' }),
    { ok: false, reason: 'default_store_cutover_not_built' });
});

test('R3: a merchant charges only cards saved on its OWN connected account', () => {
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'acct_m1', isDefaultStore: false, storeAccount: 'acct_m1' }), { ok: true, stripeAccount: 'acct_m1' });
  assert.deepEqual(savedCardChargeRoute({ entryAccount: null, isDefaultStore: false, storeAccount: 'acct_m1' }), { ok: false, reason: 'platform_card_for_merchant' });
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'acct_other', isDefaultStore: false, storeAccount: 'acct_m1' }), { ok: false, reason: 'foreign_account' });
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'acct_m1', isDefaultStore: false, storeAccount: null }), { ok: false, reason: 'merchant_not_connected' });
});

test('a malformed recorded account is refused, never treated as the platform', () => {
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'pm_123', isDefaultStore: true, storeAccount: null }), { ok: false, reason: 'malformed_account' });
  assert.deepEqual(savedCardChargeRoute({ entryAccount: 'acct_bad!', isDefaultStore: false, storeAccount: 'acct_m1' }), { ok: false, reason: 'malformed_account' });
});
