'use client';

import { useState } from 'react';
import { inputStyle, buttonGhost, labelStyle, statusPill, adminApiFetch } from '@/components/admin/portalStyles';
import { tiersForVariant, type PriceListEntry } from '@/lib/b2b/pricing';

/**
 * VOLUME DISCOUNT MATRIX — a real tiered-pricing table over
 * `price_list_entries` (variant × min_quantity × unit_price_cents, already
 * modeled) plus the company's `net_terms_days` (0/15/30/60, already a real
 * column) as a labeled term badge. Calls `/api/admin/b2b/price-list` — no
 * new schema, just a read-only Sales Hub view of what
 * `/api/admin/b2b/quotes` already prices quotes against.
 */

const TERM_LABEL: Record<number, string> = { 0: 'Due on receipt', 15: 'Net-15', 30: 'Net-30', 60: 'Net-60' };

export default function VolumeDiscountMatrix() {
  const [companyId, setCompanyId] = useState('');
  const [company, setCompany] = useState<{ name: string; net_terms_days: number; credit_limit_cents: number; credit_used_cents: number } | null>(null);
  const [entries, setEntries] = useState<PriceListEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!companyId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch(`/api/admin/b2b/price-list?companyId=${encodeURIComponent(companyId.trim())}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load price list.');
        setCompany(null);
        setEntries(null);
        return;
      }
      setCompany(data.company);
      setEntries((data.entries || []).map((e: any) => ({ variantId: e.variant_id, unitPriceCents: e.unit_price_cents, minQuantity: e.min_quantity })));
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  };

  const variantIds = [...new Set((entries || []).map((e) => e.variantId))];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Volume discount tiers and net-terms for a company&apos;s contract price list.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Company ID</span>
          <input style={{ ...inputStyle, minWidth: 260 }} value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="uuid" />
        </div>
        <button type="button" style={buttonGhost} onClick={load} disabled={loading || !companyId.trim()}>
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      {company && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
          <div>
            <span style={labelStyle}>Company</span>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>{company.name}</div>
          </div>
          <div>
            <span style={labelStyle}>Terms</span>
            <div style={{ marginTop: 4 }}>
              <span style={statusPill(company.net_terms_days > 0 ? '#93c5fd' : '#34d399')}>{TERM_LABEL[company.net_terms_days] || `Net-${company.net_terms_days}`}</span>
            </div>
          </div>
          <div>
            <span style={labelStyle}>Credit used</span>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              ${(company.credit_used_cents / 100).toFixed(2)} / ${(company.credit_limit_cents / 100).toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {entries && variantIds.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No contract price list for this company — quotes fall back to the tenant default list, then base catalog price.</p>}

      {variantIds.map((variantId) => (
        <div key={variantId} style={{ padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#888', marginBottom: 8 }}>{variantId}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tiersForVariant(entries || [], variantId).map((tier) => (
              <div key={tier.minQuantity} style={{ padding: '6px 10px', borderRadius: 8, background: '#141417', border: '1px solid #24242a', fontSize: 11.5 }}>
                <strong>{tier.minQuantity}+</strong> units → ${(tier.unitPriceCents / 100).toFixed(2)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
