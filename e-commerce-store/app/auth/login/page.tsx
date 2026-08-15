'use client';
import { useState } from 'react';
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { useLiveTheme } from '@/components/ThemeProvider';
import { themeRadius } from '@/lib/storefront-config';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Live theme palette — initialized from the server-baked theme (no flash) and
  // refreshed from /api/store so design presets apply to the login page.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );

  // Pull the live theme on mount (same pattern as app/account/page.tsx).
  useEffect(() => {
    fetchStoreJson('/api/store')
      .then((data: any) => {
        if (data?.config?.themeColors) {
          setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
        }
      })
      .catch(() => {});
  }, []);

  const notify = (detail: { id?: string; type: string; message: string; persist?: boolean }) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('goyunir-notify', { detail }));
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('reset') === 'success') {
        notify({ type: 'success', message: 'Password updated. You can log in now.' });
      }
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    notify({ id: 'auth-login', type: 'loading', message: 'Signing you in...', persist: true });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        notify({ id: 'auth-login', type: 'success', message: 'Signed in.' });
        router.push('/account');
      } else {
        setError(data.error || 'Login failed');
        notify({ id: 'auth-login', type: 'error', message: data.error || 'Login failed.' });
      }
    } catch {
      setError('Network error');
      notify({ id: 'auth-login', type: 'error', message: 'Network error.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 20), padding: 32, maxWidth: 400, width: '100%' }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 8px', color: configPalette.cardTextMain }}>Log In</h1>
        <p style={{ color: configPalette.cardTextMuted, fontSize: 13, margin: '0 0 24px' }}>Sign in to manage your entries and rewards.</p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input type="email" placeholder="email@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: 12, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: 12, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#34d399', marginTop: -6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: '#22c55e', boxShadow: '0 0 0 2px rgba(34,197,94,0.16)' }} />
            Encrypted credential handoff
          </div>
          <div style={{ textAlign: 'right', marginTop: -6 }}>
            <Link href="/auth/forgot-password" prefetch={false} style={{ color: configPalette.accentBlue, textDecoration: 'none', fontSize: 12 }}>Forgot password?</Link>
          </div>
          {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button type="submit" disabled={loading} style={{ padding: 12, borderRadius: 999, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{loading ? 'Logging in…' : 'Log In'}</button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: configPalette.cardTextMuted, textAlign: 'center' }}>
          Don&apos;t have an account? <Link href="/auth/signup" prefetch={false} style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>Sign up</Link>
        </p>
      </div>
    </main>
  );
}