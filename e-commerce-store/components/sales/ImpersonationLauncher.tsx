'use client';

import { useState } from 'react';
import { inputStyle, buttonPrimary, labelStyle } from '@/components/admin/portalStyles';
import { usePicklists } from '@/components/sales/SalesPickers';

/**
 * IMPERSONATION LAUNCHER — "act as this store" for the Sales Hub, calling
 * `/api/admin/impersonate`. The rep picks one of THEIR assigned stores by
 * name (DEFERRED-11 #6: it used to take a pasted tenant id) and confirms with
 * their own password: that fresh credential check is deliberate step-up for
 * this one action, so it stays. Their email comes from the session (it used
 * to be asked again). The route still checks the assignment itself.
 */
export default function ImpersonationLauncher() {
  const lists = usePicklists();
  const [tenantId, setTenantId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const email = String(lists?.email || '');

  const start = async () => {
    if (!tenantId || !email || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Staff-Impersonate-Tenant-ID': tenantId },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not open the store.');
        return;
      }
      // A merchant store opens on its own dashboard host via a one-time link;
      // the original store keeps opening in /admin.
      window.location.href = typeof data?.next === 'string' ? data.next : '/admin';
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Open one of your stores to help with setup or troubleshooting. You act as support: payments, staff and billing stay
        out of reach, and everything you do is recorded under your name.
      </p>
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
          <span style={labelStyle}>Store</span>
          {!lists ? <select style={inputStyle} disabled><option>Loading…</option></select>
            : lists.stores.length === 0 ? <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: '#888' }}>No stores are assigned to you yet</div>
            : (
              <select aria-label="Store" style={inputStyle} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                <option value="">Choose a store…</option>
                {lists.stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.slug ? ' (' + s.slug + ')' : ''}</option>)}
              </select>
            )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span style={labelStyle}>Your password{email ? ' (' + email + ')' : ''}</span>
          <input aria-label="Your password" style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <div>
        <button type="button" style={buttonPrimary} onClick={start} disabled={busy || !tenantId || !email || !password}>
          {busy ? 'Opening…' : 'Open store as support'}
        </button>
      </div>
    </div>
  );
}
