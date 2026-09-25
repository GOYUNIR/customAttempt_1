'use client';

import { useEffect, useState, type FormEvent } from 'react';

/**
 * Self-serve store creation, wired to /api/signup/merchant.
 *
 * That endpoint is DISABLED by default (ALLOW_MERCHANT_SIGNUP) because public
 * tenant creation on a single-brand deployment would let anyone create stores
 * on somebody's live shop. So this asks the endpoint whether it is open before
 * showing the form — a submit button that always 403s is worse than an honest
 * "not open yet".
 *
 * It does NOT take a password. The endpoint emails an invitation instead: a
 * store owner can read customer records and change payment settings, so the
 * address is proven before the role is granted. The copy says so, because a
 * signup form that silently does something other than what the button implies
 * is how people end up confused about whether they have an account.
 */

const PALETTE = { panel: '#131317', border: '#26262d', text: '#f4f4f5', muted: '#a1a1aa' };
const inputStyle = {
  padding: '13px 14px', borderRadius: 12, border: `1px solid ${PALETTE.border}`,
  // 16px, not 15: below 16 iOS zooms the whole page when the field is tapped.
  background: '#0a0a0c', color: PALETTE.text, fontSize: 16, width: '100%', boxSizing: 'border-box',
} as const;

export default function MerchantSignupForm() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [storeName, setStoreName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ message: string; emailed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/signup/merchant', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled) setEnabled(data?.enabled === true); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!storeName.trim()) { setError('Give your store a name.'); return; }
    if (!email.trim()) { setError('Enter the email that will own the store.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/signup/merchant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeName, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(String(data?.error || 'Could not create your store.'));
        return;
      }
      setDone({ message: String(data.message || 'Check your email to finish setting up your store.'), emailed: data.emailed === true });
    } catch {
      setError('Network error — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const card = { background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 18, padding: '24px 22px', display: 'grid', gap: 14 } as const;

  if (enabled === null) {
    return <div style={card}><p style={{ color: PALETTE.muted, fontSize: 14, margin: 0 }}>Loading…</p></div>;
  }

  if (!enabled) {
    return (
      <div style={card}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: PALETTE.text }}>Signups are not open yet</h3>
        <p style={{ color: PALETTE.muted, fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          Self-serve store creation is switched off on this deployment. Get in touch and we will set
          your store up directly.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div style={card}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: PALETTE.text }}>Your store is created</h3>
        <p style={{ color: PALETTE.muted, fontSize: 14, lineHeight: 1.6, margin: 0 }}>{done.message}</p>
        {!done.emailed && (
          <p style={{ color: '#fca5a5', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            The confirmation email could not be sent. Your store exists — contact support to finish
            setting up your account.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={card}>
      <label style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>Store name</span>
        <input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="Atelier Nord" style={inputStyle} />
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>Your email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brand.com" autoComplete="email" style={inputStyle} />
      </label>
      {error && (
        <p style={{ margin: 0, color: '#fca5a5', fontSize: 13, lineHeight: 1.5, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '10px 12px' }}>{error}</p>
      )}
      <button type="submit" disabled={busy} style={{ background: PALETTE.text, color: '#0a0a0c', border: 'none', borderRadius: 999, padding: '14px 20px', fontSize: 15, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Creating…' : 'Create my store'}
      </button>
      <p style={{ color: PALETTE.muted, fontSize: 12.5, lineHeight: 1.55, margin: 0 }}>
        We will email you a link to set your password. No card required.
      </p>
    </form>
  );
}
