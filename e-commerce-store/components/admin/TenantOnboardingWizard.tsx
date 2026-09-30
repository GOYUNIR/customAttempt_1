'use client';

import { useState, useEffect, useCallback } from 'react';
import { inputStyle, buttonPrimary, buttonGhost, labelStyle } from '@/components/admin/portalStyles';

/**
 * STORE ONBOARDING — create a store and invite its owner, in one step.
 * The store is live at <slug>.<root> at once (wildcard route); the owner
 * accepts the emailed invitation, sets a password, then connects payments,
 * adds products and chooses a plan from their own dashboard. An owner email
 * is required: a store with no owner is one nobody can sign in to (the API
 * allows it, this screen does not). Platform-admin-only.
 */

type TenantRow = { id: string; name: string; slug: string; business_type: string | null; created_at: string };

export default function TenantOnboardingWizard() {
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [result, setResult] = useState('');
  const root = typeof window !== 'undefined' ? window.location.hostname.replace(/^admin\./, '') : '';
  const slugFrom = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const validOwner = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim());
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
    if (!name.trim() || !slug.trim() || !validOwner) return;
    setCreating(true);
    setError('');
    setResult('');
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), ownerEmail: ownerEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not create tenant.');
        return;
      }
      const inv = data?.ownerInvite;
      const address = (data?.tenant?.slug || slug) + (root ? '.' + root : '');
      setResult(inv?.emailed
        ? `Created ${name.trim()} at ${address}. Invitation emailed to ${inv.email}.`
        : inv?.acceptUrl
          ? `Created ${name.trim()} at ${address}, but the email did not go out. Send ${inv.email} this link: ${inv.acceptUrl}`
          : `Created ${name.trim()} at ${address}, but the owner invitation failed. Invite the owner again before they can sign in.`);
      setName('');
      setSlug('');
      setSlugTouched(false);
      setOwnerEmail('');
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
        Creates the store at its own web address and emails the owner an invitation. The owner sets a password,
        then connects payments, adds products and chooses a plan from their dashboard.
      </p>
      {notConfigured && <p style={{ fontSize: 12.5, color: '#aaa' }}>Requires Supabase (SUPABASE_SERVICE_ROLE_KEY).</p>}
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}
      {result && <div role="status" style={{ fontSize: 12.5, color: '#86efac', overflowWrap: 'anywhere' }}>{result}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Store name</span>
          <input style={inputStyle} value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugFrom(e.target.value)); }} placeholder="Acme Co." />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Web address{root ? ' (.' + root + ')' : ''}</span>
          <input style={inputStyle} value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)); }} placeholder="acme-co" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Owner email</span>
          <input style={inputStyle} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@acme.com" />
        </div>
        <button type="button" style={buttonPrimary} onClick={create} disabled={creating || !name.trim() || !slug.trim() || !validOwner}>
          {creating ? 'Creating…' : 'Create store and invite owner'}
        </button>
      </div>

      <div>
        <h3 style={{ ...labelStyle, marginBottom: 10 }}>Stores ({tenants?.length || 0})</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(tenants || []).map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a', fontSize: 12 }}>
              <div>
                <strong>{t.name}</strong> <span style={{ color: '#666' }}>{t.slug}{root ? '.' + root : ''}</span>
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
