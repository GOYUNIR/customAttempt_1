'use client';

import { useState, useCallback } from 'react';
import { inputStyle, buttonPrimary, buttonGhost, labelStyle, statusPill, adminApiFetch } from '@/components/admin/portalStyles';

/**
 * QUOTE DESK — the B2B draft-quote builder, backed by the real
 * app/api/admin/b2b/quotes endpoint (lib/b2b/pricing.ts / lib/b2b/approval.ts).
 * Extracted from components/admin/EnterprisePanel.tsx's `QuotesPanel` (still
 * used there, unchanged, as the admin Enterprise tab's quotes sub-tab) so the
 * same component also mounts as the Sales Hub's main view (app/sales/page.tsx)
 * — one implementation, two mount points, instead of duplicated logic.
 *
 * Net-30/60 terms and volume tiers are resolved server-side by the pricing
 * engine this already calls; there is no separate UI concept for them here
 * because the quote's line pricing already reflects whatever the company's
 * price list / contract terms dictate.
 */

type QuoteRow = {
  id: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  notes: string | null;
  created_at: string;
};

export default function QuoteDeskPanel({ password = '' }: { password?: string }) {
  const [companyId, setCompanyId] = useState('');
  const [quotes, setQuotes] = useState<QuoteRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newVariantId, setNewVariantId] = useState('');
  const [newQuantity, setNewQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const loadQuotes = useCallback(async () => {
    if (!companyId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch(`/api/admin/b2b/quotes?companyId=${encodeURIComponent(companyId.trim())}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load quotes.');
        setQuotes(null);
        return;
      }
      setQuotes(data.quotes || []);
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const createQuote = async () => {
    if (!companyId.trim() || !newVariantId.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/b2b/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          companyId: companyId.trim(),
          lines: [{ variantId: newVariantId.trim(), quantity: Math.max(1, Number(newQuantity) || 1) }],
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not create quote.');
        return;
      }
      setNewVariantId('');
      setNewQuantity('1');
      setNotes('');
      await loadQuotes();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
          Draft and track B2B quotes. Pricing is resolved against the company&apos;s contract price list automatically
          (falls back to the tenant default list, then the catalog base price) — including any Net-30/60 terms and
          volume tiers already on that price list.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Company ID</span>
            <input style={{ ...inputStyle, minWidth: 260 }} value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="uuid" />
          </div>
          <button type="button" style={buttonGhost} onClick={loadQuotes} disabled={loading || !companyId.trim()}>
            {loading ? 'Loading…' : 'Load Quotes'}
          </button>
        </div>

        {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

        <div style={{ borderTop: '1px solid #2a2a30', paddingTop: 16 }}>
          <h3 style={{ ...labelStyle, marginBottom: 10 }}>New Quote Line</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Variant ID</span>
              <input style={inputStyle} value={newVariantId} onChange={(e) => setNewVariantId(e.target.value)} placeholder="uuid" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Quantity</span>
              <input style={{ ...inputStyle, width: 90 }} type="number" min={1} value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
              <span style={labelStyle}>Notes (optional)</span>
              <input style={inputStyle} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <button type="button" style={buttonPrimary} onClick={createQuote} disabled={creating || !companyId.trim() || !newVariantId.trim()}>
              {creating ? 'Creating…' : 'Create Quote'}
            </button>
          </div>
        </div>

        {quotes && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={labelStyle}>Quotes ({quotes.length})</h3>
            {quotes.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No quotes yet for this company.</p>}
            {quotes.map((q) => (
              <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>${(q.subtotal_cents / 100).toFixed(2)} {q.currency.toUpperCase()}</div>
                  <div style={{ fontSize: 10.5, color: '#888' }}>{new Date(q.created_at).toLocaleString()}{q.notes ? ` · ${q.notes}` : ''}</div>
                </div>
                <span style={statusPill(q.status === 'accepted' || q.status === 'converted' ? '#34d399' : q.status === 'rejected' || q.status === 'expired' ? '#f87171' : '#93c5fd')}>{q.status}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
