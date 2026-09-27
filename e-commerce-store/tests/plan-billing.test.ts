import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { governing, nextPlan, subscriptionIdOf, PLAN_EVENTS } from '../lib/plan-billing-rules.ts';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const step = (status: string, currentPlanId: string, currentGrace: string | null = null) =>
  nextPlan({ status, paidPlanId: 'growth', currentPlanId, currentGrace, now: NOW, graceDays: 7 });

test('paying moves a Free store onto the plan and clears any grace', () => {
  assert.deepEqual(step('active', 'free'), { planId: 'growth', grace: null });
  assert.deepEqual(step('active', 'growth', '2026-09-30T00:00:00.000Z'), { planId: 'growth', grace: null });
});

test('a failed renewal keeps the plan for exactly 7 days, and redelivery does not extend it', () => {
  const first = step('past_due', 'growth');
  assert.equal(first.planId, 'growth');
  assert.equal(first.grace, new Date(NOW + 7 * 86_400_000).toISOString());
  assert.deepEqual(step('past_due', 'growth', first.grace), first, 'a second past_due event keeps the first grace date');
  assert.deepEqual(step('unpaid', 'growth', first.grace), first);
});

test('cancelling or expiring returns the store to Free', () => {
  for (const s of ['canceled', 'incomplete_expired', 'paused']) assert.deepEqual(step(s, 'growth', '2026-09-30T00:00:00.000Z'), { planId: 'free', grace: null });
});

test('an unpaid first payment changes nothing', () => {
  assert.deepEqual(step('incomplete', 'free'), { planId: 'free', grace: null });
});

test('a leftover subscription never moves a store placed on another plan (contract, admin grant)', () => {
  for (const s of ['active', 'past_due', 'unpaid', 'canceled', 'incomplete_expired', 'incomplete']) {
    assert.deepEqual(step(s, 'scale'), { planId: 'scale', grace: null }, s);
  }
});

test('a failing payment never grants a plan to a Free store', () => {
  assert.deepEqual(step('past_due', 'free'), { planId: 'free', grace: null });
});

test('the governing subscription: paying beats failing beats ended, newest first; only this store', () => {
  const ev = { id: 'sub_old', status: 'canceled', created: 1, metadata: { tenant_id: 'A' } };
  const live = { id: 'sub_live', status: 'active', created: 2, metadata: { tenant_id: 'A' } };
  const failing = { id: 'sub_fail', status: 'past_due', created: 3, metadata: { tenant_id: 'A' } };
  const otherStore = { id: 'sub_b', status: 'active', created: 9, metadata: { tenant_id: 'B' } };
  assert.equal(governing([ev, live, failing, otherStore], ev).id, 'sub_live', 'cancelling a duplicate keeps the plan the other still pays for');
  assert.equal(governing([ev, failing], ev).id, 'sub_fail');
  assert.equal(governing([ev, otherStore], ev).id, 'sub_old', "another store's subscription never governs");
  assert.equal(governing([], ev).id, 'sub_old');
  const newer = { id: 'sub_new', status: 'active', created: 5, metadata: { tenant_id: 'A' } };
  assert.equal(governing([live, newer], ev).id, 'sub_new');
});

test('subscriptionIdOf reads subscription and invoice events (old and new API shapes)', () => {
  assert.equal(subscriptionIdOf({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } }), 'sub_1');
  assert.equal(subscriptionIdOf({ type: 'invoice.paid', data: { object: { subscription: 'sub_2' } } }), 'sub_2');
  assert.equal(subscriptionIdOf({ type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_3' } } } } }), 'sub_3');
  assert.equal(subscriptionIdOf({ type: 'invoice.paid', data: { object: {} } }), null);
  for (const e of ['customer.subscription.created', 'customer.subscription.deleted', 'invoice.payment_failed']) assert.ok(PLAN_EVENTS.has(e));
});

test('every billing route checks the owner before doing anything', () => {
  for (const f of ['app/api/merchant/billing/route.ts', 'app/api/merchant/billing/checkout/route.ts', 'app/api/merchant/billing/portal/route.ts']) {
    const src = readFileSync(f, 'utf8');
    const body = src.slice(src.indexOf('export async function'));
    const gate = body.indexOf('merchantSession(request)');
    const owner = body.indexOf("role !== 'owner'");
    const work = Math.min(...['planState(', 'startPlanCheckout(', 'planPortal('].map((w) => body.indexOf(w)).filter((i) => i >= 0));
    assert.ok(gate >= 0 && owner > gate && work > owner, f + ': session, then owner check, then work');
    assert.ok(!/tenant_?[iI]d['"]?\s*[:=]\s*(body|url|searchParams|request)/.test(body), f + ': the store comes from the session only');
  }
});

test('the platform webhook never treats a plan checkout as an order', () => {
  const src = readFileSync('app/api/stripe/webhook/route.ts', 'utf8');
  const completed = src.indexOf("event.type === 'checkout.session.completed'");
  const ignore = src.indexOf("session.mode === 'subscription'", completed);
  const claim = src.indexOf('claimStripeSession(sessionId)', completed);
  assert.ok(completed >= 0 && ignore > completed && ignore < claim, 'subscription sessions return before any order work');
});
