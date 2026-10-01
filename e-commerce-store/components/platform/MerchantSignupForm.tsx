'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

/**
 * Self-serve store creation (/api/signup/merchant, lib/signup-guard).
 *
 * Three fields and one check, nothing else: store name (its web address is
 * previewed as you type), email, the terms box, and Cloudflare Turnstile (the
 * only CAPTCHA on the platform). No password here: the email link proves the
 * inbox, then the person chooses a password. When signup is closed (the
 * ALLOW_MERCHANT_SIGNUP kill switch), an honest "contact us" card instead.
 */

const PALETTE = { panel: '#131317', border: '#26262d', text: '#f4f4f5', muted: '#a1a1aa' };
const inputStyle = {
  padding: '13px 14px', borderRadius: 12, border: `1px solid ${PALETTE.border}`,
  // 16px, not 15: below 16 iOS zooms the whole page when the field is tapped.
  background: '#0a0a0c', color: PALETTE.text, fontSize: 16, width: '100%', boxSizing: 'border-box',
} as const;

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id?: string) => void } }
}

/** Same rule as the server: "Salt & Cedar Co." → salt-cedar-co. */
const addressFrom = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

export default function MerchantSignupForm({ contactEmail = null }: { contactEmail?: string | null } = {}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [storeName, setStoreName] = useState('');
  const [email, setEmail] = useState('');
  const [terms, setTerms] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [resent, setResent] = useState('');
  const [full, setFull] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/signup/merchant', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled) { setEnabled(data?.enabled === true); setSiteKey(data?.siteKey || null); } })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  // Turnstile, rendered explicitly once the form (or the resend box) is shown.
  useEffect(() => {
    if (!enabled || !siteKey || !box.current) return;
    const render = () => {
      if (!window.turnstile || !box.current || widget.current) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey, action: 'signup', theme: 'dark',
        callback: (t: string) => setToken(t), 'expired-callback': () => setToken(''), 'error-callback': () => setToken(''),
      });
    };
    if (window.turnstile) { render(); return; }
    const id = 'cf-turnstile-script';
    if (!document.getElementById(id)) {
      const s = document.createElement('script');
      s.id = id; s.async = true; s.defer = true;
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      document.head.appendChild(s);
    }
    const t = window.setInterval(() => { if (window.turnstile) { window.clearInterval(t); render(); } }, 200);
    return () => window.clearInterval(t);
  }, [enabled, siteKey, done]);

  const resetCheck = () => { setToken(''); try { window.turnstile?.reset(widget.current || undefined); } catch { /* re-rendered below */ } };

  async function send(): Promise<{ ok: boolean; message: string }> {
    const res = await fetch('/api/signup/merchant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeName, email, acceptTerms: terms, turnstileToken: token }),
    });
    const data = await res.json().catch(() => ({}));
    resetCheck(); // tokens are single-use
    // Today's signups are full: a calm notice instead of the form, not an error.
    if (data?.full === true) { setFull(String(data.message || '')); return { ok: false, message: '' }; }
    return { ok: res.ok && data?.ok === true, message: String(data?.error || data?.message || 'Your store could not be started. Please try again.') };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!storeName.trim()) { setError('Give your store a name.'); return; }
    if (!email.trim()) { setError('Enter the email that will own the store.'); return; }
    if (!terms) { setError('Please accept the terms to continue.'); return; }
    if (!token) { setError('Please complete the check that you are a person.'); return; }
    setBusy(true);
    try {
      const r = await send();
      if (r.ok) { widget.current = null; setDone(r.message); } else if (r.message) setError(r.message);
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResent('');
    if (!token) { setResent('Complete the check below first.'); return; }
    setBusy(true);
    try { const r = await send(); setResent(r.ok ? 'Sent again. Check your inbox and spam folder.' : (r.message || 'We cannot send more signup emails today. The link we already sent still works; please try again tomorrow.')); }
    catch { setResent('Network error. Try again.'); }
    finally { setBusy(false); }
  }

  const card = { background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 18, padding: '24px 22px', display: 'grid', gap: 14 } as const;
  const root = typeof window !== 'undefined' ? window.location.hostname.replace(/^www\./, '') : '';
  const address = addressFrom(storeName);

  if (enabled === null) return <div style={card}><p style={{ color: PALETTE.muted, fontSize: 14, margin: 0 }}>Loading…</p></div>;

  if (!enabled) {
    return (
      <div style={card}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: PALETTE.text }}>We are setting up stores personally</h3>
        <p style={{ color: PALETTE.muted, fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          Right now every new store is set up with us, so it is ready to sell from day one. Email us
          and we will get yours started.
        </p>
        {contactEmail && <a href={'mailto:' + contactEmail + '?subject=' + encodeURIComponent('Set up my store')} style={{ color: PALETTE.text, fontWeight: 700, fontSize: 14 }}>Email {contactEmail}</a>}
      </div>
    );
  }

  if (full && !done) {
    return (
      <div style={card} role="status">
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: PALETTE.text }}>Please come back tomorrow</h3>
        <p style={{ color: PALETTE.muted, fontSize: 14, lineHeight: 1.6, margin: 0 }}>{full}</p>
        {contactEmail && <p style={{ color: PALETTE.muted, fontSize: 13, margin: 0 }}>In a hurry? <a href={'mailto:' + contactEmail} style={{ color: PALETTE.text }}>{contactEmail}</a></p>}
      </div>
    );
  }

  if (done) {
    return (
      <div style={card}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: PALETTE.text }}>Check your email</h3>
        <p style={{ color: PALETTE.muted, fontSize: 14, lineHeight: 1.6, margin: 0 }}>{done} Open the link to create {storeName.trim() || 'your store'} and choose your password.</p>
        <p style={{ color: PALETTE.muted, fontSize: 13, margin: '6px 0 0' }}>Didn&apos;t get it? Check spam, then send it again:</p>
        <div ref={box} />
        <button type="button" onClick={resend} disabled={busy} style={{ background: 'transparent', color: PALETTE.text, border: `1px solid ${PALETTE.border}`, borderRadius: 999, padding: '12px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
          {busy ? 'Sending…' : 'Send the email again'}
        </button>
        {resent && <p role="status" style={{ color: PALETTE.muted, fontSize: 13, margin: 0 }}>{resent}</p>}
        {contactEmail && <p style={{ color: PALETTE.muted, fontSize: 13, margin: 0 }}>Still nothing? <a href={'mailto:' + contactEmail} style={{ color: PALETTE.text }}>{contactEmail}</a></p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={card}>
      <label style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>Store name</span>
        <input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="Atelier Nord" maxLength={80} style={inputStyle} />
        {address && root && <span style={{ fontSize: 12.5, color: PALETTE.muted }}>Your store: {address}.{root} (you can change it later)</span>}
      </label>
      <label style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>Your email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brand.com" autoComplete="email" style={inputStyle} />
      </label>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: PALETTE.muted, lineHeight: 1.5 }}>
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ width: 20, height: 20, marginTop: 1, flex: '0 0 auto' }} />
        <span>I agree to the <a href="/platform/terms" target="_blank" style={{ color: PALETTE.text }}>Terms</a> and have read the <a href="/platform/privacy" target="_blank" style={{ color: PALETTE.text }}>Privacy Policy</a>.</span>
      </label>
      <div ref={box} />
      {error && <p role="alert" style={{ margin: 0, color: '#fca5a5', fontSize: 13, lineHeight: 1.5, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '10px 12px' }}>{error}</p>}
      <button type="submit" disabled={busy} style={{ background: PALETTE.text, color: '#0a0a0c', border: 'none', borderRadius: 999, padding: '14px 20px', fontSize: 15, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Sending…' : 'Email me a link to open my store'}
      </button>
      <p style={{ color: PALETTE.muted, fontSize: 12.5, lineHeight: 1.55, margin: 0 }}>No card required. You choose your password after opening the link.</p>
    </form>
  );
}
