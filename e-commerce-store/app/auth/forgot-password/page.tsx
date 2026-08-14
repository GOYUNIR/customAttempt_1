'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { useLiveTheme } from '@/components/ThemeProvider';

export default function ForgotPasswordPage() {
  // Live theme palette — initialized from the server-baked theme (no flash) and
  // refreshed from /api/store so the CTA button matches the saved accent color
  // instead of the build-time purple.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
    setBusy(true);
    setMessage('');
    notify({ id: 'forgot-password', type: 'loading', message: 'Sending reset link...', persist: true });
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('If this email exists, a reset link has been sent.');
        notify({ id: 'forgot-password', type: 'success', message: 'If the account exists, a reset link is on the way.' });
      } else {
        setMessage(data.error || 'Unable to send reset link.');
        notify({ id: 'forgot-password', type: 'error', message: data.error || 'Unable to send reset link.' });
      }
    } catch {
      setMessage('Unable to send reset link.');
      notify({ id: 'forgot-password', type: 'error', message: 'Unable to send reset link.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 20, padding: 32, maxWidth: 420, width: '100%' }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 8px', color: configPalette.cardTextMain }}>Recover account</h1>
        <p style={{ color: configPalette.cardTextMuted, fontSize: 13, margin: '0 0 24px' }}>Enter your account email and we will send a secure reset link.</p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input type="email" placeholder="email@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', fontSize: 14, boxSizing: 'border-box', width: '100%' }} />
          <button type="submit" disabled={busy} style={{ padding: 12, borderRadius: 10, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
        {message && <p style={{ marginTop: 12, fontSize: 12, color: message.includes('Unable') ? '#f87171' : '#34d399' }}>{message}</p>}
        <p style={{ marginTop: 14, fontSize: 12, color: configPalette.cardTextMuted }}>
          Back to <Link href="/auth/login" style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>login</Link>
        </p>
      </div>
    </main>
  );
}
