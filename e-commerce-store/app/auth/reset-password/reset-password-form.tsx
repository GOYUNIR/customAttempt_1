'use client';

import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { useLiveTheme } from '@/components/ThemeProvider';
import { themeRadius } from '@/lib/storefront-config';

export default function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  // Live theme palette — initialized from the server-baked theme (no flash) and
  // refreshed from /api/store so the CTA matches the saved accent color.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 6) {
      setMessage('Password must be at least 6 characters.');
      notify({ type: 'alert', message: 'Password must be at least 6 characters.' });
      return;
    }
    if (password !== confirm) {
      setMessage('Passwords do not match.');
      notify({ type: 'alert', message: 'Passwords do not match.' });
      return;
    }
    setBusy(true);
    setMessage('');
    notify({ id: 'reset-password', type: 'loading', message: 'Updating your password...', persist: true });
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        notify({ id: 'reset-password', type: 'success', message: 'Password updated.' });
        router.push('/auth/login?reset=success');
      } else {
        setMessage(data.error || 'Unable to reset password.');
        notify({ id: 'reset-password', type: 'error', message: data.error || 'Unable to reset password.' });
      }
    } catch {
      setMessage('Unable to reset password.');
      notify({ id: 'reset-password', type: 'error', message: 'Unable to reset password.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 420, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 20), padding: 28, background: configPalette.cardBackground }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 10px', color: configPalette.cardTextMain }}>Reset password</h1>
        <p style={{ color: configPalette.cardTextMuted, fontSize: 13, margin: '0 0 18px' }}>Choose a new password for your account.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, marginBottom: 10 }} />
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, marginBottom: 10 }} />
        {message && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{message}</p>}
        <button disabled={busy || !token} type="submit" style={{ width: '100%', padding: 12, borderRadius: 999, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700 }}>{busy ? 'Saving…' : 'Update password'}</button>
      </form>
    </main>
  );
}