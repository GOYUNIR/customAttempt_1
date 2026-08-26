'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

/**
 * /admin/login — the in-site admin sign-in form (replaces the native browser
 * Basic-Auth dialog). The operator enters their email + password; on success a
 * short-lived login session is set and they are taken to /admin, which then
 * shows the two-step email verification gate (2FA) before the portal unlocks.
 */

const inputStyle = { padding: '13px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const labelStyle = { fontSize: 13, fontWeight: 700, color: '#374151' } as const;
const hintStyle = { fontSize: 12.5, color: '#6b7280', margin: 0, lineHeight: 1.55 } as const;

export default function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Enter your admin email and password.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(String(data.error || 'Sign-in failed. Check your credentials.'));
        return;
      }
      // The login session is set — /admin now shows the two-step email
      // verification gate (a 6-digit code is emailed to this address).
      window.location.assign('/admin');
    } catch {
      setError('Network error — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '48px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <form onSubmit={submit} style={{ background: '#fff', borderRadius: 18, padding: '28px 26px', boxShadow: '0 8px 30px rgba(0,0,0,0.07)', display: 'grid', gap: 16 }}>
          <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#111' }}>Admin sign-in</h1>
            <p style={hintStyle}>Enter your admin <strong>email</strong> and password.</p>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={labelStyle}>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" autoFocus style={inputStyle} />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={labelStyle}>Password</span>
            <div style={{ position: 'relative' }}>
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                autoComplete="current-password"
                style={{ ...inputStyle, paddingRight: 60 }}
              />
              <button type="button" onClick={() => setShow((s) => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, fontSize: 12, fontWeight: 700, color: '#6b7280' }}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {error && (
            <p style={{ margin: 0, color: '#b91c1c', fontSize: 13, lineHeight: 1.5, background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>{error}</p>
          )}

          <button type="submit" disabled={busy} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '14px 20px', fontSize: 15, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', display: 'grid', gap: 6 }}>
            <p style={{ ...hintStyle, fontWeight: 700, color: '#0f172a' }}>Why two steps?</p>
            <p style={hintStyle}>
              After your password is accepted, a <strong>6-digit code is emailed</strong> to your admin inbox to confirm it&apos;s really you. That two-step protection keeps the store safe even if your password leaks. To receive the code, set up a transactional email provider (Resend, Postmark or SendGrid) in <Link href="/admin/setup?reconfigure=1" prefetch={false} style={{ color: '#1d4ed8', textDecoration: 'underline' }}>setup</Link> or in the portal&apos;s Settings.
            </p>
          </div>

          <p style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', margin: 0 }}>
            <Link href="/" prefetch={false} style={{ color: '#6b7280', textDecoration: 'underline' }}>← Back to store</Link>
          </p>
        </form>
      </div>
    </main>
  );
}
