import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargeRouteFor, connectStatusFromAccount } from '../lib/connect-routing.ts';

test('an enabled connected account is charged on its own account', () => {
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: false, stripeAccountId: 'acct_123', chargesEnabled: true }),
    { route: 'connected', stripeAccount: 'acct_123' },
  );
});

test('FAIL CLOSED: a merchant who is not connected, or not yet enabled, cannot charge at all', () => {
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: false, stripeAccountId: null, chargesEnabled: false }),
    { route: 'blocked', reason: 'not_connected' },
  );
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: false, stripeAccountId: 'acct_123', chargesEnabled: false }),
    { route: 'blocked', reason: 'onboarding_incomplete' },
  );
  // A stale "enabled" flag with no account must not route anywhere real.
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: false, stripeAccountId: null, chargesEnabled: true }),
    { route: 'blocked', reason: 'not_connected' },
  );
  // A malformed id is not an account.
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: false, stripeAccountId: 'cus_123', chargesEnabled: true }),
    { route: 'blocked', reason: 'not_connected' },
  );
});

test('only the legacy platform tenant may charge on the platform account, and only until it is connected', () => {
  assert.deepEqual(chargeRouteFor({ isLegacyPlatformTenant: true, stripeAccountId: null, chargesEnabled: false }), { route: 'platform' });
  assert.deepEqual(chargeRouteFor({ isLegacyPlatformTenant: true, stripeAccountId: 'acct_9', chargesEnabled: false }), { route: 'platform' });
  assert.deepEqual(
    chargeRouteFor({ isLegacyPlatformTenant: true, stripeAccountId: 'acct_9', chargesEnabled: true }),
    { route: 'connected', stripeAccount: 'acct_9' },
  );
});

test('status mapping: only an ACTIVE capability counts as enabled; missing reads as disabled', () => {
  const active = connectStatusFromAccount({
    configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, stripe_balance: { payouts: { status: 'pending' } } } } },
    requirements: { entries: [{}, {}], summary: { minimum_deadline: null } },
  });
  assert.equal(active.chargesEnabled, true);
  assert.equal(active.payoutsEnabled, false);
  assert.equal(active.requirements.outstanding, 2);

  for (const status of ['pending', 'restricted', 'unsupported', undefined]) {
    assert.equal(connectStatusFromAccount({ configuration: { merchant: { capabilities: { card_payments: { status } } } } }).chargesEnabled, false, String(status));
  }
  // v2 returns null for anything not requested with `include`.
  assert.equal(connectStatusFromAccount({ configuration: null }).chargesEnabled, false);
  assert.equal(connectStatusFromAccount(null).chargesEnabled, false);
});
