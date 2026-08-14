'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Live theme palette — starts at the build-time config and upgrades to the
  // /admin → Settings theme so design presets apply to the auth pages too.
  const [configPalette, setConfigPalette] = useState<any>(GOYUNIR_STORE_SUITE.themeColors);

  useEffect(() => {
    fetchStoreJson('/api/store')
      .then((data) => {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      notify({ type: 'alert', message: 'Passwords do not match.' });
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      notify({ type: 'alert', message: 'Password must be at least 6 characters.' });
      return;
    }
    if (!termsAgreed) {
      setError('Please agree to the Terms of Service and Privacy Policy to continue.');
      notify({ type: 'alert', message: 'Please agree to the Terms of Service and Privacy Policy.' });
      return;
    }
    setError('');
    setLoading(true);
    notify({ id: 'auth-signup', type: 'loading', message: 'Creating your account...', persist: true });
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, termsAgreed, emailOptIn }),
      });
      const data = await res.json();
      if (res.ok) {
        notify({ id: 'auth-signup', type: 'success', message: 'Account created.' });
        router.push('/account');
      } else {
        setError(data.error || 'Signup failed');
        notify({ id: 'auth-signup', type: 'error', message: data.error || 'Signup failed.' });
      }
    } catch (err) {
      setError('Network error');
      notify({ id: 'auth-signup', type: 'error', message: 'Network error.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 20, padding: 32, maxWidth: 400, width: '100%' }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 8px', color: configPalette.cardTextMain }}>Sign Up</h1>
        <p style={{ color: configPalette.cardTextMuted, fontSize: 13, margin: '0 0 24px' }}>Create your account to track entries and earn rewards. New accounts get 250 welcome points and a one-time 10% credit on your first release.</p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input type="email" placeholder="email@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <input type="password" placeholder="Confirm Password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#34d399', marginTop: -6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: '#22c55e', boxShadow: '0 0 0 2px rgba(34,197,94,0.16)' }} />
            Encrypted credential handoff
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.45, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={termsAgreed}
              onChange={(e) => setTermsAgreed(e.target.checked)}
              style={{ marginTop: 1, accentColor: configPalette.checkoutCtaButton }}
            />
            <span>
              I agree to the{' '}
              <Link href="/terms" target="_blank" style={{ color: configPalette.accentBlue, textDecoration: 'underline' }}>Terms of Service</Link>{' '}
              and{' '}
              <Link href="/privacy" target="_blank" style={{ color: configPalette.accentBlue, textDecoration: 'underline' }}>Privacy Policy</Link>.
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.45, cursor: 'pointer', marginTop: -8 }}>
            <input
              type="checkbox"
              checked={emailOptIn}
              onChange={(e) => setEmailOptIn(e.target.checked)}
              style={{ marginTop: 1, accentColor: configPalette.checkoutCtaButton }}
            />
            <span>Email me updates about upcoming drops, releases, and rewards. (Unsubscribe anytime.)</span>
          </label>
          {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button type="submit" disabled={loading} style={{ padding: 12, borderRadius: 10, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{loading ? 'Signing up…' : 'Sign Up'}</button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: configPalette.cardTextMuted, textAlign: 'center' }}>
          Already have an account? <Link href="/auth/login" style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>Log In</Link>
        </p>
      </div>
    </main>
  );
}