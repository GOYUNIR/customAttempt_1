'use client';

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id?: string) => void } }
}

/**
 * "Talk to us" on the platform's own site (lib/leads.ts, /api/leads). Shown
 * only when PLATFORM_LEADS_ENABLED is on (the page decides). Four fields, one
 * button. `source` says where the person came from (e.g. pricing_scale, from
 * a plan's button: /?plan=scale#talk).
 */
export default function LeadForm({ siteKey, palette }: { siteKey: string | null; palette: { text: string; muted: string; panel: string; border: string; accent: string } }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [source, setSource] = useState('platform_contact');
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    const plan = new URLSearchParams(window.location.search).get('plan');
    if (plan && /^[a-z0-9_-]{1,30}$/i.test(plan)) setSource('pricing_' + plan.toLowerCase());
  }, []);

  useEffect(() => {
    if (!siteKey || !box.current || done) return;
    const render = () => {
      if (!window.turnstile || !box.current || widget.current) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey, action: 'lead', theme: 'dark',
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
  }, [siteKey, done]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const r = await fetch('/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, company, message, website, source, turnstileToken: token }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setError(j?.error || 'That did not go through. Please try again.'); if (widget.current && window.turnstile) window.turnstile.reset(widget.current); setToken(''); return; }
      setDone(j?.message || 'Thanks. A person will reply by email.');
    } finally { setBusy(false); }
  };

  const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 10, border: '1px solid ' + palette.border, background: 'transparent', color: palette.text, fontSize: 15 };
  if (done) return <p role="status" style={{ fontSize: 16, color: palette.text }}>{done}</p>;
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
      <input aria-label="Email" type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={field} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={field} />
        <input aria-label="Company" placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={field} />
      </div>
      <textarea aria-label="What do you need?" required placeholder="What do you need?" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} style={{ ...field, resize: 'vertical' }} />
      {/* People never see or fill this; a bot filling every field does. */}
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} />
      <div ref={box} />
      {error && <p role="alert" style={{ color: '#ff8a80', fontSize: 14, margin: 0 }}>{error}</p>}
      <button type="submit" disabled={busy || (Boolean(siteKey) && !token)} style={{ padding: '12px 18px', borderRadius: 999, border: 'none', background: palette.accent, color: '#000', fontWeight: 700, fontSize: 15, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}
