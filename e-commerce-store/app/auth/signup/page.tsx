'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push('/account');
      } else {
        setError(data.error || 'Signup failed');
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
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 8px' }}>Sign Up</h1>
        <p style={{ color: configPalette.textMuted, fontSize: 13, margin: '0 0 24px' }}>Create your account to track entries and earn rewards.</p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Confirm Password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button type="submit" disabled={loading} style={{ padding: 12, borderRadius: 10, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{loading ? 'Signing up…' : 'Sign Up'}</button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: configPalette.textMuted, textAlign: 'center' }}>
          Already have an account? <Link href="/auth/login" style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>Log In</Link>
        </p>
      </div>
    </main>
  );
}