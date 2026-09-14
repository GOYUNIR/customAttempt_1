import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOrderApproval, type ApprovalRule, type CompanyMember } from '../lib/b2b/approval.ts';

const RULES: ApprovalRule[] = [
  { id: 'r1', companyId: 'c1', thresholdCents: 100_000, approverRole: 'approver' },
  { id: 'r2', companyId: 'c1', thresholdCents: 500_000, approverRole: 'manager' },
  { id: 'r3', companyId: 'c2', thresholdCents: 50_000, approverRole: 'approver' },
];

const MEMBERS: CompanyMember[] = [
  { userId: 'buyer-1', companyId: 'c1', role: 'buyer', spendLimitCents: 20_000 },
  { userId: 'buyer-2', companyId: 'c1', role: 'buyer', spendLimitCents: null },
  { userId: 'appr-1', companyId: 'c1', role: 'approver', spendLimitCents: null },
  { userId: 'mgr-1', companyId: 'c1', role: 'manager', spendLimitCents: null },
];

test('an order below every threshold needs no approval', () => {
  const decision = evaluateOrderApproval(50_000, 'c1', RULES, MEMBERS);
  assert.equal(decision.requiresApproval, false);
  assert.equal(decision.triggeredRule, null);
  assert.deepEqual(decision.eligibleApproverUserIds, []);
});

test('an order at the lower threshold requires the named role to approve', () => {
  const decision = evaluateOrderApproval(150_000, 'c1', RULES, MEMBERS);
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.triggeredRule?.id, 'r1');
  // approver + manager both eligible (managers can always approve)
  assert.deepEqual(decision.eligibleApproverUserIds.sort(), ['appr-1', 'mgr-1']);
});

test('an order at the higher threshold picks the STRICTEST qualifying rule', () => {
  const decision = evaluateOrderApproval(600_000, 'c1', RULES, MEMBERS);
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.triggeredRule?.id, 'r2'); // the 500k rule, not the 100k one
  assert.deepEqual(decision.eligibleApproverUserIds, ['mgr-1']); // only managers, per r2's approverRole
});

test('c1\'s rules never cross-apply to c2 — c2 is only gated by its OWN rule', () => {
  // At 40k, c1 would need no approval either (below its 100k rule), and c2's
  // own rule is 50k — so this stays unapproved for c2 too. The real
  // assertion is in the next test: c2's rule fires on c2's own threshold,
  // never on c1's much lower or higher thresholds by accident.
  const decision = evaluateOrderApproval(40_000, 'c2', RULES, MEMBERS);
  assert.equal(decision.requiresApproval, false);
});

test('c2 rule alone still triggers approval even with no eligible members modeled', () => {
  const decision = evaluateOrderApproval(60_000, 'c2', RULES, MEMBERS);
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.triggeredRule?.id, 'r3');
  assert.deepEqual(decision.eligibleApproverUserIds, []); // no c2 members in the fixture
});

test('a buyer\'s individual spend cap triggers approval even below every company rule', () => {
  const decision = evaluateOrderApproval(25_000, 'c1', RULES, MEMBERS, 'buyer-1');
  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.triggeredRule, null); // no company rule qualified — only the personal cap did
  assert.deepEqual(decision.eligibleApproverUserIds.sort(), ['appr-1', 'mgr-1']); // no named role -> approver+manager
});

test('a buyer with no individual cap is only gated by company rules', () => {
  const decision = evaluateOrderApproval(25_000, 'c1', RULES, MEMBERS, 'buyer-2');
  assert.equal(decision.requiresApproval, false);
});

test('an unknown requesting buyer id never crashes and is simply ignored', () => {
  const decision = evaluateOrderApproval(25_000, 'c1', RULES, MEMBERS, 'ghost-user');
  assert.equal(decision.requiresApproval, false);
});
