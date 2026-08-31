'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { useLiveTheme } from '@/components/ThemeProvider';
import { themeRadius } from '@/lib/storefront-config';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Email-verification step: accounts are created unverified and the 6-digit
  // code must be confirmed before welcome rewards unlock (anti-exploitation).
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [pendingEmail, setPendingEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyMsg, setVerifyMsg] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [devCode, setDevCode] = useState('');
  // Resend cooldown (seconds) — disables the button with a live countdown until
  // the server's 60s throttle clears (prevents the accidental 429 double-tap).
  const [resendCooldown, setResendCooldown] = useState(0);
  // Guards the AUTO-VERIFY: a 6-digit code is submitted exactly once (a wrong
  // code isn't re-submitted on every re-render, and a resend resets it).
  const lastSubmittedCodeRef = useRef('');
  // Live theme palette — initialized from the server-baked theme (no flash) and
  // refreshed from /api/store so design presets apply to the auth pages too.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );

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
      if (res.ok && data.needsVerification) {
        setPendingEmail(data.email || email);
        setDevCode(data.devCode || '');
        setVerifyCode('');
        lastSubmittedCodeRef.current = '';
        setVerifyMsg(data.devCode ? 'Account created. Enter the dev-mode code below to finish.' : 'Account created — check your inbox for the 6-digit code.');
        setStep('verify');
        notify({ id: 'auth-signup', type: 'success', message: 'Account created — verify your email to unlock your rewards.' });
      } else if (res.ok) {
        notify({ id: 'auth-signup', type: 'success', message: 'Account created.' });
        router.push('/account');
      } else {
        setError(data.error || 'Signup failed');
        notify({ id: 'auth-signup', type: 'error', message: data.error || 'Signup failed.' });
      }
    } catch {
      setError('Network error');
      notify({ id: 'auth-signup', type: 'error', message: 'Network error.' });
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (verifyCode.length !== 6) {
      setVerifyMsg('Enter the 6-digit code from your email.');
      return;
    }
    setVerifyBusy(true);
    setVerifyMsg('');
    notify({ id: 'auth-verify', type: 'loading', message: 'Verifying your email...', persist: true });
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail, code: verifyCode }),
      });
      const data = await res.json();
      if (res.ok) {
        notify({ id: 'auth-verify', type: 'success', message: 'Email verified — your welcome rewards are unlocked.' });
        router.push('/account');
      } else {
        setVerifyMsg(data.error || 'Verification failed.');
        notify({ id: 'auth-verify', type: 'error', message: data.error || 'Verification failed.' });
      }
    } catch {
      setVerifyMsg('Network error.');
      notify({ id: 'auth-verify', type: 'error', message: 'Network error.' });
    }
    setVerifyBusy(false);
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || verifyBusy) return;
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingEmail }),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyMsg(data.devCode ? 'A fresh code was sent. Dev-mode code below.' : 'A fresh code was sent — it shows in your email notification.');
        if (data.devCode) setDevCode(data.devCode);
        lastSubmittedCodeRef.current = '';
        setResendCooldown(Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : 60);
      } else {
        setVerifyMsg(data.error || 'Could not resend the code.');
        if (res.status === 429 && Number(data.retryAfterSeconds) > 0) {
          setResendCooldown(Number(data.retryAfterSeconds));
        }
      }
    } catch {
      setVerifyMsg('Network error.');
    }
    setVerifyBusy(false);
  };

  // Tick the resend cooldown down once per second while it is active.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => {
      setResendCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  // AUTO-VERIFY: as soon as all 6 digits are present (typed, pasted, or filled
  // by the iOS/Android one-time-code autofill bar) submit immediately.
  useEffect(() => {
    if (verifyBusy || step !== 'verify') return;
    const code = verifyCode.trim();
    if (code.length === 6 && code !== lastSubmittedCodeRef.current) {
      lastSubmittedCodeRef.current = code;
      handleVerify();
    }
    // handleVerify is stable per-mount; keying on code length + busy + step is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyCode, verifyBusy, step]);

  const inputStyle = {
    padding: 12,
    borderRadius: themeRadius(configPalette, 12),
    background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`,
    border: `1px solid ${configPalette.cardBorder}`,
    color: configPalette.cardTextMain,
    fontSize: 14,
    boxSizing: 'border-box' as const,
    width: '100%',
  };


  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 16), padding: '24px 20px', maxWidth: 360, width: '100%', boxSizing: 'border-box' }}>
        {step === 'form' ? (
          <>
            <h2 style={{ fontSize: 20, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 6px', color: configPalette.cardTextMain }}>Create your account</h2>
            <p style={{ fontSize: 13, margin: '0 0 24px', color: configPalette.cardTextMuted, lineHeight: 1.6 }}>
              Track entries and earn rewards. New accounts get 250 welcome points and a one-time 10% credit on your first release — unlocked after you confirm your email.
            </p>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <input type="email" placeholder="email@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
              <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />
              <input type="password" placeholder="Confirm Password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required style={inputStyle} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#34d399', marginTop: -6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: '#22c55e', boxShadow: '0 0 0 2px rgba(34,197,94,0.16)' }} />
                Encrypted credential handoff
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.45, cursor: 'pointer' }}>
                <input type="checkbox" checked={termsAgreed} onChange={(e) => setTermsAgreed(e.target.checked)} style={{ marginTop: 1, accentColor: configPalette.checkoutCtaButton }} />
                <span>
                  I agree to the{' '}
                  <Link href="/terms" target="_blank" prefetch={false} style={{ color: configPalette.accentBlue, textDecoration: 'underline' }}>Terms of Service</Link>{' '}
                  and{' '}
                  <Link href="/privacy" target="_blank" prefetch={false} style={{ color: configPalette.accentBlue, textDecoration: 'underline' }}>Privacy Policy</Link>.
                </span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.45, cursor: 'pointer', marginTop: -8 }}>
                <input type="checkbox" checked={emailOptIn} onChange={(e) => setEmailOptIn(e.target.checked)} style={{ marginTop: 1, accentColor: configPalette.checkoutCtaButton }} />
                <span>Email me updates about upcoming drops, releases, and rewards. (Unsubscribe anytime.)</span>
              </label>
              {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}
              <button type="submit" disabled={loading} style={{ padding: 12, borderRadius: 999, border: 'none', background: configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' }}>{loading ? 'Signing up…' : 'Sign Up'}</button>
            </form>
            <p style={{ marginTop: 16, fontSize: 13, color: configPalette.cardTextMuted, textAlign: 'center' }}>
              Already have an account? <Link href="/auth/login" style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>Log In</Link>
            </p>
          </>
        ) : (
          <>


            <h2 style={{ fontSize: 20, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 6px' }}>Confirm your email</h2>
            <p style={{ fontSize: 13, margin: '0 0 16px', color: configPalette.cardTextMuted, lineHeight: 1.6 }}>
              We sent a 6-digit code to <strong style={{ color: configPalette.cardTextMain }}>{pendingEmail}</strong>. Enter it to verify the inbox is real — your welcome points and member credit unlock right after.
            </p>
            {devCode && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: themeRadius(configPalette, 10), background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.35)', fontSize: 12, color: '#facc15', lineHeight: 1.5 }}>
                <strong>Dev mode code:</strong> <span style={{ letterSpacing: 4, fontWeight: 800 }}>{devCode}</span> (production sends this only by email)
              </div>
            )}
            <input
              type="text"
              name="one-time-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              ref={(el) => {
                if (el) (el as HTMLInputElement & { textContentType?: string }).textContentType = 'oneTimeCode';
              }}
              placeholder="6-digit code"
              style={{ ...inputStyle, textAlign: 'center', letterSpacing: 6, fontSize: 16, marginBottom: 12 }}
            />
            {verifyMsg && <p style={{ color: verifyMsg.toLowerCase().includes('sent') ? '#34d399' : '#f87171', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>{verifyMsg}</p>}
            <button onClick={handleVerify} disabled={verifyBusy || verifyCode.length !== 6} style={{ padding: 12, borderRadius: 999, border: 'none', background: verifyBusy || verifyCode.length !== 6 ? '#555' : configPalette.checkoutCtaButton, color: '#fff', fontWeight: 700, fontSize: 14, cursor: verifyBusy || verifyCode.length !== 6 ? 'not-allowed' : 'pointer', width: '100%' }}>{verifyBusy ? 'Verifying…' : 'Verify & unlock rewards'}</button>
            <button onClick={handleResend} disabled={verifyBusy || resendCooldown > 0} style={{ marginTop: 8, width: '100%', padding: 10, borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, background: 'transparent', color: verifyBusy || resendCooldown > 0 ? configPalette.cardTextMuted : configPalette.cardTextMain, opacity: verifyBusy || resendCooldown > 0 ? 0.6 : 1, fontSize: 12, cursor: verifyBusy || resendCooldown > 0 ? 'not-allowed' : 'pointer' }}>{resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}</button>
            <p style={{ marginTop: 14, fontSize: 11, color: configPalette.cardTextMuted, textAlign: 'center', lineHeight: 1.5 }}>
              Codes expire in 30 minutes. Prefer to finish later? You can verify anytime from your account after logging in.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

