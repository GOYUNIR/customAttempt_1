'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push('/account');
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 20, padding: 32, maxWidth: 400, width: '100%' }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 8px' }}>Log In</h1>
        <p style={{ color: configPalette.textMuted, fontSize: 13, margin: '0 0 24px' }}>Sign in to manage your entries and rewards.</p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button type="submit" disabled={loading} style={{ padding: 12, borderRadius: 10, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{loading ? 'Logging in…' : 'Log In'}</button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: configPalette.textMuted, textAlign: 'center' }}>
          Don't have an account? <Link href="/auth/signup" style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>Sign up</Link>
        </p>
      </div>
    </main>
  );
}