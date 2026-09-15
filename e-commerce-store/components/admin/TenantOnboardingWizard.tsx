'use client';

import { useState, useEffect, useCallback } from 'react';
import { inputStyle, buttonPrimary, buttonGhost, labelStyle } from '@/components/admin/portalStyles';

/**
 * TENANT ONBOARDING WIZARD — a real "create tenant" form (name, slug,
 * business type → a `tenants` row), honestly scoped to what the schema
 * supports today. This is NOT a full multi-step SaaS onboarding flow
 * (billing, DNS provisioning, storefront setup) — those don't map to
 * anything real yet in this single-tenant-by-default template; see
 * DEPLOYMENT.md's Known Gaps. Platform-admin-only.
 */

type TenantRow = { id: string; name: string; slug: string; business_type: string | null; created_at: string };

export default function TenantOnboardingWizard() {
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/tenants', { credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        setTenants(data.tenants || []);
        setNotConfigured(Boolean(data.notConfigured));
      }
    } catch {
      /* leave list empty */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim() || !slug.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), businessType: businessType.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not create tenant.');
        return;
      }
      setName('');
      setSlug('');
      setBusinessType('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Create a new tenant record. This provisions the `tenants` row that the rest of the platform&apos;s
        multi-tenant schema (impersonation, sales assignments, B2B) scopes to — it does not yet provision DNS,
        billing, or a storefront.
      </p>
      {notConfigured && <p style={{ fontSize: 12.5, color: '#aaa' }}>Requires Supabase (SUPABASE_SERVICE_ROLE_KEY).</p>}
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Name</span>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Co." />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Slug</span>
          <input style={inputStyle} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-co" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Business type (optional)</span>
          <input style={inputStyle} value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="apparel" />
        </div>
        <button type="button" style={buttonPrimary} onClick={create} disabled={creating || !name.trim() || !slug.trim()}>
          {creating ? 'Creating…' : 'Create Tenant'}
        </button>
      </div>

      <div>
        <h3 style={{ ...labelStyle, marginBottom: 10 }}>Tenants ({tenants?.length || 0})</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(tenants || []).map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a', fontSize: 12 }}>
              <div>
                <strong>{t.name}</strong> <span style={{ color: '#666' }}>({t.slug})</span>
              </div>
              <span style={{ color: '#888' }}>{t.business_type || '—'}</span>
            </div>
          ))}
          {tenants && tenants.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No tenants yet.</p>}
        </div>
      </div>
      <button type="button" style={{ ...buttonGhost, alignSelf: 'flex-start' }} onClick={load}>
        Refresh
      </button>
    </div>
  );
}
