'use client';

import { useCallback, useEffect, useState } from 'react';

type Lead = {
  id: string; email: string; name: string | null; company: string | null; message: string | null; source: string;
  status: 'new' | 'working' | 'won' | 'lost'; claimed_by: string | null; first_response_at: string | null; created_at: string;
  waited: string; waitedMinutes: number;
};
type Data = { enabled: boolean; me: string; coldAfterMinutes: number; medianFirstReply: string | null; answered30d: number; total30d: number; leads: Lead[] };

const card: React.CSSProperties = { border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: '12px 14px', background: '#fff', marginBottom: 10 };
const btn: React.CSSProperties = { border: '1px solid #111', background: '#111', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer' };
const ghost: React.CSSProperties = { ...btn, background: '#fff', color: '#111' };

/**
 * The Sales Hub's Pipeline: everyone who asked to talk to us, unanswered
 * first (oldest at the top) with how long they have waited, and the median
 * time to a first human reply. Each lead offers only the next step that
 * applies: Claim; then Reply / Mark replied; then won or lost.
 */
export default function LeadsPipelinePanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/sales/leads', { credentials: 'same-origin' });
    const j = await r.json().catch(() => null);
    if (!r.ok) { setError(j?.error || 'Could not load the pipeline.'); return; }
    setError(''); setData(j);
  }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => window.clearInterval(t); }, [load]);

  const act = async (id: string, action: string, status?: string) => {
    setBusy(id + action);
    const r = await fetch('/api/admin/sales/leads', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action, status }) });
    const j = await r.json().catch(() => null);
    setBusy('');
    if (!r.ok) setError(j?.error || 'That did not work.');
    await load();
  };

  if (error && !data) return <p style={{ color: '#b00020' }}>{error}</p>;
  if (!data) return <p style={{ color: '#888' }}>Loading the pipeline…</p>;
  const open = data.leads.filter((l) => l.status === 'new' || l.status === 'working');
  const closed = data.leads.filter((l) => l.status === 'won' || l.status === 'lost');

  return (
    <div>
      <p style={{ margin: '0 0 14px', fontSize: 14 }}>
        <strong>Median first reply (30 days): {data.medianFirstReply ?? 'no replies yet'}</strong>
        <span style={{ color: '#777' }}> · {data.answered30d} of {data.total30d} answered · a lead unanswered for {data.coldAfterMinutes} min sends one reminder to the sales inbox</span>
      </p>
      {!data.enabled && (
        <p style={{ ...card, background: '#fafafa', fontSize: 13, color: '#555' }}>
          The &ldquo;talk to us&rdquo; form on the platform site is off (PLATFORM_LEADS_ENABLED), so no new leads arrive yet. Leads already here can be worked as usual.
        </p>
      )}
      {error && <p style={{ color: '#b00020', fontSize: 13 }}>{error}</p>}
      {open.length === 0 && <p style={{ color: '#777' }}>No open leads.</p>}
      {open.map((l) => {
        const mine = l.claimed_by === data.me;
        const waiting = !l.first_response_at;
        const cold = waiting && l.waitedMinutes >= data.coldAfterMinutes;
        return (
          <div key={l.id} style={{ ...card, borderColor: cold ? '#d97706' : card.borderColor as string }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{l.name || l.email}{l.company ? ' · ' + l.company : ''}</div>
                <div style={{ fontSize: 12.5, color: '#666' }}>{l.email} · from {l.source} · {waiting ? 'waiting ' + l.waited : 'answered after ' + l.waited}{l.claimed_by ? ' · ' + (mine ? 'yours' : l.claimed_by) : ' · unclaimed'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {!l.claimed_by && <button style={btn} disabled={busy === l.id + 'claim'} onClick={() => act(l.id, 'claim')}>Claim</button>}
                {mine && waiting && (
                  <>
                    <a style={{ ...ghost, textDecoration: 'none' }} href={'mailto:' + encodeURIComponent(l.email) + '?subject=' + encodeURIComponent('Re: your message')}>Reply</a>
                    <button style={btn} disabled={busy === l.id + 'responded'} onClick={() => act(l.id, 'responded')}>Mark replied</button>
                  </>
                )}
                {!waiting && (
                  <select aria-label={'Status for ' + l.email} value={l.status} onChange={(e) => act(l.id, 'status', e.target.value)} style={{ padding: '5px 8px', borderRadius: 8 }}>
                    <option value="working">Working</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                )}
              </div>
            </div>
            {l.message && <p style={{ margin: '8px 0 0', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{l.message}</p>}
          </div>
        );
      })}
      {closed.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Closed ({closed.length})</summary>
          {closed.map((l) => (
            <div key={l.id} style={{ ...card, opacity: 0.75 }}>
              <strong>{l.status === 'won' ? 'Won' : 'Lost'}</strong> · {l.name || l.email}{l.company ? ' · ' + l.company : ''} · answered after {l.waited}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
