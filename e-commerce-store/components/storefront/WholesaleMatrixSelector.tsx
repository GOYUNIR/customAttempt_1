'use client';

import { useState } from 'react';
import { tiersForVariant, type PriceListEntry } from '@/lib/b2b/pricing';

/**
 * WHOLESALE MATRIX SELECTOR — a real variant × quantity grid with live
 * tiered pricing (the same `lib/b2b/pricing.ts` logic the Sales Hub's quote
 * builder and `VolumeDiscountMatrix` use), for a B2B buyer building a bulk
 * order.
 *
 * HONEST LIMITATION: this app's customer auth (`app/api/auth/*`) is a
 * separate Redis-backed session system with no link to Supabase Auth /
 * `company_members` yet (noted in `app/api/admin/b2b/quotes/route.ts`'s own
 * header) — there is no real self-serve B2B buyer login today. Submitting
 * here calls the existing `/api/admin/b2b/quotes` endpoint, which still
 * requires an admin session cookie — so today this is realistically a tool
 * for a sales rep building an order WITH a buyer on a call, not yet a
 * standalone self-serve storefront checkout for an anonymous B2B visitor.
 * Building that buyer-auth link is real, separate future work.
 */

type Variant = { id: string; label: string; basePriceCents: number };

export default function WholesaleMatrixSelector({ companyId, variants, priceListEntries }: { companyId: string; variants: Variant[]; priceListEntries: PriceListEntry[] }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const setQty = (variantId: string, qty: number) => setQuantities((prev) => ({ ...prev, [variantId]: Math.max(0, Math.floor(qty) || 0) }));

  const submit = async () => {
    const lines = variants
      .map((v) => ({ variantId: v.id, quantity: quantities[v.id] || 0 }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/b2b/quotes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, lines, notes: notes.trim() || undefined }),
      });
      const data = await res.json();
      setResult(res.ok ? { ok: true, message: `Draft quote created — $${(data?.quote?.subtotalCents / 100 || 0).toFixed(2)}` } : { ok: false, message: data?.error || 'Could not create quote.' });
    } catch (err: any) {
      setResult({ ok: false, message: err?.message || 'Network error.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 16, border: '1px solid #24242a', background: '#141417', color: '#e5e5e8' }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Wholesale order</h3>
        <p style={{ margin: '4px 0 0', fontSize: 11.5, color: '#888' }}>Volume pricing applies automatically as quantities cross a tier.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {variants.map((variant) => {
          const qty = quantities[variant.id] || 0;
          const tiers = tiersForVariant(priceListEntries, variant.id);
          const applicable = tiers.filter((t) => t.minQuantity <= qty).sort((a, b) => b.minQuantity - a.minQuantity)[0];
          const unitPriceCents = applicable ? applicable.unitPriceCents : variant.basePriceCents;
          return (
            <div key={variant.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, alignItems: 'center', padding: '9px 10px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{variant.label}</div>
              <input
                type="number"
                min={0}
                value={qty || ''}
                onChange={(e) => setQty(variant.id, Number(e.target.value))}
                placeholder="0"
                style={{ padding: 8, borderRadius: 8, background: '#000', border: '1px solid #303036', color: '#fff', fontSize: 12, width: '100%', boxSizing: 'border-box' }}
              />
              <div style={{ fontSize: 12, textAlign: 'right' }}>
                ${(unitPriceCents / 100).toFixed(2)} <span style={{ color: '#666' }}>/ea</span>
                {qty > 0 && <div style={{ color: '#34d399', fontSize: 11 }}>${((unitPriceCents * qty) / 100).toFixed(2)}</div>}
              </div>
            </div>
          );
        })}
      </div>
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        style={{ padding: 10, borderRadius: 8, background: '#0d0d10', border: '1px solid #303036', color: '#fff', fontSize: 12 }}
      />
      {result && <div style={{ fontSize: 12, color: result.ok ? '#34d399' : '#fca5a5' }}>{result.message}</div>}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        style={{ padding: '10px 16px', borderRadius: 10, background: '#3b82f6', color: '#fff', border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', alignSelf: 'flex-start' }}
      >
        {busy ? 'Submitting…' : 'Request Quote'}
      </button>
    </div>
  );
}
