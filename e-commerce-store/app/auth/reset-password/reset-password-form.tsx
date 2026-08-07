'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 6) return setMessage('Password must be at least 6 characters.');
    if (password !== confirm) return setMessage('Passwords do not match.');
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push('/auth/login?reset=success');
      } else {
        setMessage(data.error || 'Unable to reset password.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 420, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 20, padding: 28, background: configPalette.cardBackground }}>
        <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: '0 0 10px' }}>Reset password</h1>
        <p style={{ color: configPalette.textMuted, fontSize: 13, margin: '0 0 18px' }}>Choose a new password for your account.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', marginBottom: 10 }} />
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 8, background: '#16161a', border: '1px solid #27272a', color: '#fff', marginBottom: 10 }} />
        {message && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{message}</p>}
        <button disabled={busy || !token} type="submit" style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700 }}>{busy ? 'Saving…' : 'Update password'}</button>
      </form>
    </main>
  );
}