'use client';

import { useState, useEffect, useCallback } from 'react';
import { statusPill, buttonGhost } from '@/components/admin/portalStyles';

/**
 * INVENTORY ALLOCATION MATRIX — a real table over `product_variants` +
 * `inventory_levels` (+ `shared_inventory_pools`), sorted by remaining
 * stock ascending (lowest first — the actually useful default for spotting
 * what needs restocking). Calls `/api/admin/inventory-matrix`.
 */

type Row = { variantId: string; productName: string; size: string; pooled: string | null; available: number; reserved: number; hasRow: boolean };

export default function InventoryAllocationMatrix() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/inventory-matrix', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load inventory matrix.');
        return;
      }
      setRows(data.rows || []);
      setNotConfigured(Boolean(data.notConfigured));
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;
  if (notConfigured) return <p style={{ fontSize: 12.5, color: '#aaa' }}>Requires Supabase (SUPABASE_SERVICE_ROLE_KEY) and the catalog backfill (scripts/migrate-redis-to-supabase.ts).</p>;
  if (error) return <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>Sorted by lowest remaining stock first.</p>
        <button type="button" style={buttonGhost} onClick={load}>Refresh</button>
      </div>
      {rows && rows.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No variants backfilled into Postgres yet.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(rows || []).map((row) => (
          <div key={row.variantId} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 10, alignItems: 'center', padding: '9px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a', fontSize: 12 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{row.productName}</div>
              <div style={{ fontSize: 10.5, color: '#888' }}>{row.size}{row.pooled ? ` · pool:${row.pooled}` : ''}</div>
            </div>
            <div style={{ color: '#888' }}>Available</div>
            <div style={{ color: '#888' }}>Reserved</div>
            <div />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', gridColumn: '2 / span 3' }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{row.available}</span>
              <span style={{ color: '#666' }}>{row.reserved} reserved</span>
              <span style={statusPill(row.available === 0 ? '#f87171' : row.available < 5 ? '#fbbf24' : '#34d399')}>
                {row.available === 0 ? 'Out' : row.available < 5 ? 'Low' : 'OK'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
