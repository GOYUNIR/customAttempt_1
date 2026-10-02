import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadInput, waitedMinutes, coldLeads, medianResponseMinutes, formatWait, COLD_AFTER_MINUTES } from '../lib/leads-rules.ts';

test('lead input: a real email and a message; everything trimmed, capped and stripped of control characters', () => {
  const ok = parseLeadInput({ email: '  Ana@Example.COM ', name: 'Ana\u0000 Ruiz', company: ' Ruiz\tSupply ', message: '  We sell drops.\r\nTwice a month. ', source: 'Pricing_Scale' });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.lead.email, 'ana@example.com');
    assert.equal(ok.lead.name, 'Ana Ruiz');
    assert.equal(ok.lead.company, 'Ruiz Supply');
    assert.equal(ok.lead.message, 'We sell drops.\nTwice a month.');
    assert.equal(ok.lead.source, 'pricing_scale');
  }
  assert.deepEqual(parseLeadInput({ email: 'nope', message: 'hi there' }), { ok: false, error: 'Enter a valid email address.', field: 'email' });
  assert.equal((parseLeadInput({ email: 'a@b.co', message: ' ' }) as any).field, 'message');
  const weird = parseLeadInput({ email: 'a@b.co', message: 'x'.repeat(5000), source: '<script>' });
  assert.ok(weird.ok && weird.lead.message.length === 2000 && weird.lead.source === 'unknown');
});

test('waiting time, cold leads (once), and the median first reply', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const leads = [
    { id: 'fresh', status: 'new', created_at: at(5), first_response_at: null, nudged_at: null },
    { id: 'cold', status: 'new', created_at: at(COLD_AFTER_MINUTES + 1), first_response_at: null, nudged_at: null },
    { id: 'already-nudged', status: 'new', created_at: at(90), first_response_at: null, nudged_at: at(60) },
    { id: 'answered', status: 'new', created_at: at(90), first_response_at: at(80), nudged_at: null },
    { id: 'working', status: 'working', created_at: at(90), first_response_at: null, nudged_at: null },
  ];
  assert.deepEqual(coldLeads(leads, now).map((l) => l.id), ['cold']);
  assert.equal(waitedMinutes(leads[3], now), 10, 'an answered lead waited until its first reply');
  assert.equal(medianResponseMinutes([{ created_at: at(30), first_response_at: at(20) }, { created_at: at(50), first_response_at: at(20) }, { created_at: at(5), first_response_at: null }]), 20);
  assert.equal(medianResponseMinutes([]), null);
  assert.equal(formatWait(7), '7 min');
  assert.equal(formatWait(125), '2 h 5 min');
  assert.equal(formatWait(60 * 28), '1 d 4 h');
});
