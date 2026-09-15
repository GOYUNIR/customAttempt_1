'use client';

import { useState } from 'react';
import { inputStyle, buttonPrimary, labelStyle } from '@/components/admin/portalStyles';

/**
 * IMPERSONATION LAUNCHER — a real "act as this company's tenant" action for
 * the Sales Hub, calling the existing `/api/admin/impersonate` (already
 * built, Phase 2/3 — this surfaces it, it doesn't add the capability).
 * Requires the rep's own email + password as step-up confirmation (that's
 * how `/api/admin/impersonate` is designed — a fresh credential check for
 * this specific action, not the session cookie alone) and the target
 * tenant's id. On success, the response sets the impersonation device
 * cookie and the rep is redirected into `/admin` acting on that tenant.
 */
export default function ImpersonationLauncher() {
  const [tenantId, setTenantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    if (!tenantId.trim() || !email.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Staff-Impersonate-Tenant-ID': tenantId.trim() },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not start impersonation.');
        return;
      }
      window.location.href = '/admin';
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Act as a tenant&apos;s store to assist with setup or troubleshooting — the session is scoped to this
        tenant only and excluded from high-risk admin routes (payment/storage credentials, wipes). Confirm your
        own credentials to start.
      </p>
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
          <span style={labelStyle}>Target tenant ID</span>
          <input style={inputStyle} value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="uuid" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span style={labelStyle}>Your email</span>
          <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span style={labelStyle}>Your password</span>
          <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <div>
        <button type="button" style={buttonPrimary} onClick={start} disabled={busy || !tenantId.trim() || !email.trim() || !password}>
          {busy ? 'Starting…' : 'Start Impersonation'}
        </button>
      </div>
    </div>
  );
}
