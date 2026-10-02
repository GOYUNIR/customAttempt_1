'use client';

import { useEffect, useState } from 'react';
import { inputStyle } from '@/components/admin/portalStyles';

/** The Sales Hub's pick-lists (stores by name, companies by name), loaded once. */
export type Picklists = { email: string | null; stores: Array<{ id: string; name: string; slug: string }>; companies: Array<{ id: string; name: string }> };

let cache: Promise<Picklists> | null = null;
export function usePicklists(): Picklists | null {
  const [data, setData] = useState<Picklists | null>(null);
  useEffect(() => {
    cache = cache || fetch('/api/admin/sales/picklists', { credentials: 'include' }).then((r) => r.json()).catch(() => ({ email: null, stores: [], companies: [] }));
    let live = true;
    cache.then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, []);
  return data;
}

/** Choose a company by NAME (never a pasted id). */
export function CompanyPicker({ value, onChange, minWidth = 260 }: { value: string; onChange: (id: string) => void; minWidth?: number }) {
  const lists = usePicklists();
  if (!lists) return <select style={{ ...inputStyle, minWidth }} disabled><option>Loading…</option></select>;
  if (lists.companies.length === 0) return <div style={{ ...inputStyle, minWidth, display: 'flex', alignItems: 'center', color: '#888' }}>No companies yet</div>;
  return (
    <select aria-label="Company" style={{ ...inputStyle, minWidth }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a company…</option>
      {lists.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
