'use client';

/**
 * The original store's stock tool (admin → Inventory), on the stock ledger
 * (/api/admin/stock/*, lib/stock.ts). Replaces the read-only matrix, whose
 * "available" was on-hand stock and whose "reserved" column was never
 * written: with checkout holds, the three numbers that matter are on hand,
 * held in open checkouts, and available to sell.
 */
import { useCallback, useEffect, useState } from 'react';
import { statusPill, buttonGhost } from '@/components/admin/portalStyles';

type Size = { size: string; variantId: string | null; onHand: number; held: number; available: number; tracked: boolean };
type Overview = { products: { productId: string; name: string; sizes: Size[] }[]; oversold: { item: string; shortfall: number; reference: string; at: string }[] };
type Move = { reason: string; change: number; after: number; shortfall: number; by: string | null; note: string | null; at: string };

const REASON: Record<string, string> = { opening: 'starting stock', sale: 'sold', restock: 'added', adjust: 'removed', count: 'counted', correction: 'correction' };
const field: React.CSSProperties = { background: '#0d0d10', border: '1px solid #24242a', borderRadius: 8, color: '#eee', padding: '0 10px', minHeight: 36, fontSize: 13, width: 90 };

export default function StockTool() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [edit, setEdit] = useState<Record<string, { count: string; delta: string; reason: string; note: string }>>({});
  const [history, setHistory] = useState<{ variantId: string; rows: Move[] } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/stock', { credentials: 'include' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setError(b.error || 'Stock could not be loaded.'); return; }
    setError('');
    setData(b);
  }, []);
  useEffect(() => { load(); }, [load]);

  const e = (v: string) => edit[v] || { count: '', delta: '', reason: 'adjust', note: '' };
  const put = (v: string, patch: Partial<{ count: string; delta: string; reason: string; note: string }>) => setEdit({ ...edit, [v]: { ...e(v), ...patch } });
  const post = async (path: string, body: any) => {
    const r = await fetch('/api/admin/stock/' + path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, body: await r.json().catch(() => ({})) as any };
  };
  const count = async (v: string) => {
    const r = await post('set', { variantId: v, count: e(v).count, note: e(v).note });
    setNotice(r.ok ? `Count saved: ${r.body.onHand} on hand, ${r.body.available} available.` : (r.body.error || 'The count could not be saved.'));
    if (r.ok) { put(v, { count: '', note: '' }); load(); }
  };
  const adjust = async (v: string, sign: 1 | -1) => {
    const n = Math.abs(Number(e(v).delta));
    const r = await post('adjust', { variantId: v, delta: sign * n, reason: sign > 0 ? 'restock' : e(v).reason, note: e(v).note });
    setNotice(r.ok ? `Stock ${sign > 0 ? 'added' : 'removed'}: ${r.body.onHand} on hand, ${r.body.available} available.` : (r.body.error || 'Stock could not be changed.'));
    if (r.ok) { put(v, { delta: '', note: '' }); load(); }
  };
  const showHistory = async (v: string) => {
    if (history?.variantId === v) { setHistory(null); return; }
    const r = await fetch('/api/admin/stock/history?variantId=' + encodeURIComponent(v), { credentials: 'include' });
    const b = await r.json().catch(() => ({}));
    if (r.ok) setHistory({ variantId: v, rows: b.history || [] }); else setNotice(b.error || 'History could not be loaded.');
  };

  if (error) return <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>;
  if (!data) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>Count what is on the shelf, or add and remove units. Units in an open checkout stay set aside for 30 minutes. Set a size to 0 to stop selling it.</p>
        <button type="button" style={buttonGhost} onClick={load}>Refresh</button>
      </div>
      {notice && <div role="status" style={{ fontSize: 12.5, color: '#eee', border: '1px solid #3a3a42', borderRadius: 8, padding: '8px 10px' }}>{notice}</div>}
      {data.oversold.length > 0 && (
        <div role="alert" style={{ border: '1px solid #f87171', borderRadius: 10, padding: 10, fontSize: 12.5 }}>
          <div style={{ fontWeight: 700, color: '#f87171' }}>Oversold in the last 30 days</div>
          <div style={{ color: '#aaa', margin: '3px 0 6px' }}>A customer paid after their checkout hold ran out and the last units had gone. The sale is recorded; you decide whether to find a unit, substitute, or refund.</div>
          {data.oversold.map((o, i) => <div key={i}>{`${o.item}: oversold by ${o.shortfall} · ${new Date(o.at).toLocaleString()} · ${o.reference}`}</div>)}
        </div>
      )}
      {data.products.map((p) => p.sizes.filter((s) => s.variantId).map((s) => {
        const v = s.variantId as string;
        return (
          <div key={v} style={{ padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a', fontSize: 12.5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div><span style={{ fontWeight: 700 }}>{p.name}</span> <span style={{ color: '#888' }}>· {s.size}</span></div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span>{`${s.onHand} on hand · ${s.held} in checkout · ${s.available} available`}</span>
                <span style={statusPill(s.available === 0 ? '#f87171' : s.available < 5 ? '#fbbf24' : '#34d399')}>{s.available === 0 ? 'Out' : s.available < 5 ? 'Low' : 'OK'}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
              <input aria-label={`Counted units for ${p.name} ${s.size}`} type="number" min="0" placeholder="Count" style={field} value={e(v).count} onChange={(ev) => put(v, { count: ev.target.value })} />
              <button type="button" style={buttonGhost} disabled={e(v).count.trim() === ''} onClick={() => count(v)}>Set count</button>
              <input aria-label={`Units to add or remove for ${p.name} ${s.size}`} type="number" min="1" placeholder="Units" style={field} value={e(v).delta} onChange={(ev) => put(v, { delta: ev.target.value })} />
              <button type="button" style={buttonGhost} disabled={!(Number(e(v).delta) > 0)} onClick={() => adjust(v, 1)}>Add</button>
              <select aria-label={`Reason for removing ${p.name} ${s.size}`} style={{ ...field, width: 'auto' }} value={e(v).reason} onChange={(ev) => put(v, { reason: ev.target.value })}>
                <option value="adjust">Damaged / lost</option><option value="correction">Correction</option>
              </select>
              <button type="button" style={buttonGhost} disabled={!(Number(e(v).delta) > 0)} onClick={() => adjust(v, -1)}>Remove</button>
              <input aria-label={`Note for ${p.name} ${s.size}`} placeholder="Note (optional)" maxLength={200} style={{ ...field, width: 180 }} value={e(v).note} onChange={(ev) => put(v, { note: ev.target.value })} />
              <button type="button" style={buttonGhost} onClick={() => showHistory(v)}>{history?.variantId === v ? 'Hide history' : 'History'}</button>
            </div>
            {history?.variantId === v && (
              <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>
                {history.rows.length === 0 && <div>No changes yet.</div>}
                {history.rows.map((m, i) => <div key={i} style={{ padding: '2px 0' }}>{`${new Date(m.at).toLocaleString()} · ${REASON[m.reason] || m.reason} ${m.change > 0 ? '+' : ''}${m.change} → ${m.after}${m.shortfall ? ` · OVERSOLD by ${m.shortfall}` : ''}${m.by ? ' · ' + m.by : ''}${m.note ? ' · ' + m.note : ''}`}</div>)}
              </div>
            )}
          </div>
        );
      }))}
    </div>
  );
}
