import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROWTH_MODULES, moduleById, liveModules, assertLaunchable, forecastUnits,
} from '../lib/growth/registry.ts';

test('the budget constraint is enforced, not remembered: no SMS or LLM module can launch', () => {
  // At ~$30/month of fixed cost, one enthusiastic tenant on a per-segment or
  // per-token module outruns the whole infrastructure budget.
  for (const m of GROWTH_MODULES) {
    if (m.channels.includes('sms') || m.costs.some((c) => c.unit.startsWith('llm_'))) {
      assert.notEqual(assertLaunchable(m), null, `${m.id} must be refused at the gate`);
    }
  }
});

test('only email modules are live today', () => {
  for (const m of liveModules()) {
    assert.deepEqual(m.channels, ['email'], `${m.id} is live but uses ${m.channels.join(',')}`);
    assert.equal(assertLaunchable(m), null, `${m.id} is live but not launchable`);
  }
});

test('a planned module cannot be enabled even if it is email-only', () => {
  const planned = GROWTH_MODULES.filter((m) => m.status === 'planned');
  assert.ok(planned.length > 0, 'expected some planned modules');
  for (const m of planned) {
    assert.match(String(assertLaunchable(m)), /not launched yet/);
  }
});

test('dunning is deterministic, NOT a holdout — withholding a known recovery costs real money', () => {
  const dunning = moduleById('dunning')!;
  assert.equal(dunning.attribution.mode, 'deterministic');
  assert.equal(dunning.attribution.holdoutPercent, 0);
  // It is transactional, so it must not be gated behind marketing consent.
  assert.deepEqual(dunning.requires.consent, ['email_transactional']);
});

test('every revenue-claiming module that is NOT deterministic runs a real holdout', () => {
  for (const m of GROWTH_MODULES) {
    if (m.metric.unit !== 'cents') continue;
    if (m.attribution.mode === 'deterministic') continue;
    assert.equal(m.attribution.mode, 'holdout', `${m.id} claims revenue without a holdout`);
    assert.ok(m.attribution.holdoutPercent > 0, `${m.id} has a 0% holdout`);
  }
});

test('marketing modules honour quiet hours; transactional ones need not', () => {
  for (const m of GROWTH_MODULES) {
    if (m.requires.consent.includes('email_marketing')) {
      assert.equal(m.compliance.quietHours, true, `${m.id} is marketing and must respect quiet hours`);
    }
  }
});

test('every module declares a cap, a frequency limit and a handler', () => {
  for (const m of GROWTH_MODULES) {
    assert.ok(m.caps.perTenantPerDay > 0, `${m.id} has no daily cap`);
    assert.ok(m.compliance.frequencyCap > 0, `${m.id} has no frequency cap`);
    assert.ok(m.handler.length > 0, `${m.id} has no handler`);
    assert.ok(m.costs.length > 0, `${m.id} declares no costs`);
  }
});

test('module ids are unique', () => {
  const ids = GROWTH_MODULES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('forecastUnits is what tells us cart recovery eats the free tier alone', () => {
  const cart = moduleById('cart_recovery')!;
  // ~1,000 abandoned carts a month for a merchant doing 2,000 orders.
  const units = forecastUnits(cart, 1000);
  assert.equal(units.email, 3000, 'three emails per abandoned cart');
  // Resend's free allowance is 3,000/month, platform-wide. One merchant.
  assert.ok(units.email >= 3000, 'one merchant consumes the entire free tier');

  const dunning = moduleById('dunning')!;
  // ~130 failed payments a month is well inside the free tier — which is part
  // of why dunning ships first.
  assert.equal(forecastUnits(dunning, 130).email, 390);
});
