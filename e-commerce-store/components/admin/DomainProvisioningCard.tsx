'use client';

import { useState, useEffect, useCallback } from 'react';
import { inputStyle, buttonPrimary, buttonGhost, labelStyle, statusPill, adminApiFetch } from '@/components/admin/portalStyles';

/**
 * DOMAIN PROVISIONING — the custom-domain UI, backed by the real
 * app/api/admin/domains endpoint (lib/cloudflare-saas.ts's Custom Hostname
 * API wrapper). Extracted from components/admin/EnterprisePanel.tsx's
 * `DomainsPanel` (still used there, unchanged, as the admin Enterprise
 * tab's Custom Domains sub-tab) so the same component also surfaces on the
 * Merchant Hub (app.site.com, `app/admin/page.tsx`'s owner/staff-facing
 * side) — one implementation, two mount points, matching how
 * `QuoteDeskPanel` was extracted for the Sales Hub.
 */

type DomainState = {
  custom_domain: string | null;
  domain_status: string;
  ssl_status: string;
  domain_verification?: { records?: Array<{ type: string; name: string; value: string }> };
  domain_checked_at: string | null;
};

export default function DomainProvisioningCard({ password = '' }: { password?: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [domain, setDomain] = useState<DomainState | null>(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch('/api/admin/domains');
      const data = await res.json();
      setConfigured(Boolean(data?.configured));
      setDomain(data?.domain || null);
      if (data?.domain?.custom_domain) setHostname(data.domain.custom_domain);
    } catch {
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const linkDomain = async () => {
    if (!hostname.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, hostname: hostname.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not link domain.');
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const removeDomain = async () => {
    if (!confirm('Remove this custom domain?')) return;
    setBusy(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/domains', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not remove domain.');
        return;
      }
      setHostname('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  if (configured === null) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;

  if (!configured) {
    return (
      <div style={{ fontSize: 12.5, color: '#aaa', lineHeight: 1.6 }}>
        Custom domains require Cloudflare for SaaS. Set <code>CLOUDFLARE_API_TOKEN</code> and{' '}
        <code>CLOUDFLARE_ZONE_ID</code> in your hosting platform&apos;s environment, then reload this panel.
      </div>
    );
  }

  const statusColor = (s: string) => (s === 'active' ? '#34d399' : s === 'error' ? '#f87171' : '#fbbf24');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Map a custom domain (e.g. <code>store.yourbrand.com</code>) to this store via Cloudflare for SaaS.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Domain</span>
          <input style={{ ...inputStyle, minWidth: 260 }} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="store.yourbrand.com" />
        </div>
        <button type="button" style={buttonPrimary} onClick={linkDomain} disabled={busy || !hostname.trim()}>
          {busy ? 'Working…' : domain?.custom_domain ? 'Re-check Status' : 'Link Domain'}
        </button>
        {domain?.custom_domain && (
          <button type="button" style={{ ...buttonGhost, color: '#fca5a5', borderColor: '#7f1d1d' }} onClick={removeDomain} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      {domain?.custom_domain && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <span style={labelStyle}>Domain Status</span>
              <div style={{ marginTop: 4 }}><span style={statusPill(statusColor(domain.domain_status))}>{domain.domain_status}</span></div>
            </div>
            <div>
              <span style={labelStyle}>SSL Status</span>
              <div style={{ marginTop: 4 }}><span style={statusPill(statusColor(domain.ssl_status === 'active' ? 'active' : domain.ssl_status === 'error' ? 'error' : 'pending'))}>{domain.ssl_status}</span></div>
            </div>
          </div>
          {domain.domain_verification?.records && domain.domain_verification.records.length > 0 && (
            <div>
              <span style={labelStyle}>DNS Records To Add</span>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {domain.domain_verification.records.map((r, i) => (
                  <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: '#ccc', background: '#000', padding: '6px 8px', borderRadius: 6, overflowX: 'auto' }}>
                    {r.type} &nbsp; {r.name} &nbsp;→&nbsp; {r.value}
                  </div>
                ))}
              </div>
            </div>
          )}
          {domain.domain_checked_at && (
            <div style={{ fontSize: 10.5, color: '#666' }}>Last checked {new Date(domain.domain_checked_at).toLocaleString()}</div>
          )}
        </div>
      )}
    </div>
  );
}
