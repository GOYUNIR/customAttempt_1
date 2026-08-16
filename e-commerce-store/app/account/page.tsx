'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { surfaceBackground, themeRadius } from '@/lib/storefront-config';
import { useLiveTheme } from '@/components/ThemeProvider';

interface EntryRecord {
  variant: string;
  size: string;
  shippingAddress: string;
  registeredAt: string | number;
  status?: string;
  shippingStatus?: string;
  amountCents?: number;
  promoCode?: string;
  discountPercent?: number;
  listPrice?: number;
  expectedAmountCents?: number;
  orderRef?: string;
}

interface PromoInfo {
  code: string;
  fixedDiscountCents?: number;
  customerDiscountPercent?: number;
  welcome?: boolean;
  active?: boolean;
  uses?: number;
  maxUsesTotal?: number;
  createdAt?: string;
  used?: boolean;
}

const TERMINAL_STATUSES = [
  'WINNER_CHARGED',
  'WINNER_DECLINED',
  'NOT_SELECTED',
  'CANCELLED_BY_USER',
  'CANCELLED_BY_ADMIN',
];

function notify(detail: { id?: string; type: string; message: string; persist?: boolean }) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('goyunir-notify', { detail }));
}

function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    ENTERED: 'Entry active',
    WAITLIST_JOINED: 'On the waitlist',
    WINNER_CHARGED: '🏆 Won & charged',
    WINNER_DECLINED: 'Selected — charge declined',
    NOT_SELECTED: 'Not selected this round',
    CANCELLED_BY_USER: 'Cancelled by you',
    CANCELLED_BY_ADMIN: 'Cancelled by admin',
    DUPLICATE_BLOCKED: 'Already entered',
    INTENT_STARTED: 'Card setup started',
    INTENT_EXPIRED: 'Card setup unfinished',
    ADDRESS_UPDATED: 'Address updated',
    NO_ACTIVE_ENTRY: 'No active entries',
  };
  return labels[String(status || '')] || String(status || 'Entry active');
}

function statusBanner(entry: EntryRecord) {
  if (entry.status === 'WINNER_CHARGED') {
    let text = `You won this allocation. Charged $${((entry.amountCents || 0) / 100).toFixed(2)}.`;
    if (entry.promoCode) {
      text += ` Promo ${entry.promoCode} (${entry.discountPercent || 0}% off) applied.`;
    }
    if (entry.orderRef) {
      text += ` Order ref: ${entry.orderRef}.`;
    }
    text += ` Shipping: ${(entry.shippingStatus || 'PENDING_FULFILLMENT').replace(/_/g, ' ').toLowerCase()}.`;
    return {
      color: '#34c759',
      text,
    };
  }
  if (entry.status === 'WINNER_DECLINED') {
    return {
      color: '#f87171',
      text: 'You were selected, but the charge did not go through. Contact support.',
    };
  }
  if (entry.status === 'NOT_SELECTED') {
    return {
      color: '#94a3b8',
      text: 'Not selected this round — you stay entered for the next drop.',
    };
  }
  if (entry.status === 'CANCELLED_BY_USER' || entry.status === 'CANCELLED_BY_ADMIN') {
    return { color: '#94a3b8', text: 'This entry was cancelled.' };
  }
  if (entry.status === 'NO_ACTIVE_ENTRY') {
    return { color: '#94a3b8', text: 'No active entries found. Enter a drop to get started.' };
  }
  return null;
}

export default function AccountPage() {
  // Live theme palette — initialized from the server-baked /admin → Settings
  // theme (no flash) and upgraded via /api/store on mount so design presets
  // apply to the account page too.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  const [email, setEmail] = useState('');
  const [last4] = useState('');
  const [entries, setEntries] = useState<EntryRecord[] | null>(null);
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [editingAddressFor, setEditingAddressFor] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [paymentPortalFor, setPaymentPortalFor] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [promos, setPromos] = useState<PromoInfo[] | null>(null);
  const [copiedCode, setCopiedCode] = useState('');
  const [rewardsConfig, setRewardsConfig] = useState<{
    pointsPerDollar?: number;
    minRedeemPoints?: number;
    giftingEnabled?: boolean;
    giftDiscountPercent?: number;
    redemptionInfoMessage?: string;
  }>({});
  const didAutoLookup = useRef(false);
  // Email-verification card (new accounts must prove the inbox before rewards).
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyMsg, setVerifyMsg] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  // Guards the AUTO-VERIFY: a 6-digit code is submitted exactly once (a wrong
  // code isn't re-submitted on every re-render, and a resend resets it).
  const lastVerifyCodeRef = useRef('');

  const handleAccountVerify = async () => {
    if (!user?.email) return;
    if (verifyCode.length !== 6) {
      setVerifyMsg('Enter the 6-digit code from your email.');
      return;
    }
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, code: verifyCode }),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyMsg('Email verified — your welcome rewards are unlocked.');
        setVerifyCode('');
        setUser({ ...user, emailVerified: true, rewards: data.user?.rewards ?? user.rewards, welcomePromoCode: data.user?.welcomePromoCode ?? user.welcomePromoCode });
      } else {
        setVerifyMsg(data.error || 'Verification failed.');
      }
    } catch {
      setVerifyMsg('Network error.');
    }
    setVerifyBusy(false);
  };

  const handleAccountResend = async () => {
    if (!user?.email) return;
    setVerifyBusy(true);
    setVerifyMsg('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });
      const data = await res.json();
      if (res.ok) {
        setVerifyMsg(data.devCode ? `Dev-mode code: ${data.devCode}` : 'A fresh code was sent — it shows in your email notification.');
        lastVerifyCodeRef.current = '';
      } else {
        setVerifyMsg(data.error || 'Could not resend the code.');
      }
    } catch {
      setVerifyMsg('Network error.');
    }
    setVerifyBusy(false);
  };

  // AUTO-VERIFY: as soon as all 6 digits are present (typed, pasted, or filled
  // by the iOS/Android one-time-code autofill bar) submit immediately.
  useEffect(() => {
    if (verifyBusy) return;
    const code = verifyCode.trim();
    if (code.length === 6 && code !== lastVerifyCodeRef.current) {
      lastVerifyCodeRef.current = code;
      handleAccountVerify();
    }
    // handleAccountVerify is stable per-mount; keying on code length + busy is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyCode, verifyBusy]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(''), 1500);
    } catch {
      notify({ type: 'alert', message: 'Could not copy code — select it manually.' });
    }
  };

  // Check if user is logged in via session
  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.user) {
          setUser(data.user);
          setIsLoggedIn(true);
        }
      })
      .catch(() => {});
    // Pull the live theme so preset background/text colors apply here too.
    fetchStoreJson('/api/store').then((data) => {
      if (data?.config?.themeColors) {
        setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      }
    }).catch(() => {});
  }, []);

  // If logged in, use the user's email for lookup
  useEffect(() => {
    if (isLoggedIn && user?.email) {
      setEmail(user.email);
    }
  }, [isLoggedIn, user]);

  const lookup = async (emailArg?: string) => {
    const lookupEmail = String(emailArg || email || '').trim().toLowerCase();
    if (!lookupEmail) {
      setMessage('Please enter your email address.');
      notify({ type: 'alert', message: 'Enter your email address first.' });
      return;
    }
    setIsBusy(true);
    setMessage('');
    notify({ id: 'account-lookup', type: 'loading', message: 'Looking up your entries...', persist: true });
    try {
      const res = await fetch('/api/account/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email: lookupEmail, 
          last4: last4 || undefined 
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (Array.isArray(data.promos)) setPromos(data.promos);
        if (data.rewards && typeof data.rewards === 'object') setRewardsConfig(data.rewards);
        if (typeof data.welcomePromoCode === 'string' && data.welcomePromoCode) {
          setUser((prev: any) => ({ ...(prev || {}), welcomePromoCode: data.welcomePromoCode }));
        }
        const filteredEntries = (data.entries || []).filter(
          (e: EntryRecord) => e.status !== 'NO_ACTIVE_ENTRY'
        );
        if (filteredEntries.length === 0) {
          setEntries([]);
          setMessage('No active entries found for this email.');
          notify({ id: 'account-lookup', type: 'info', message: 'No active entries found for this email.' });
        } else {
          setEntries(filteredEntries);
          notify({ id: 'account-lookup', type: 'success', message: 'Entries loaded.' });
        }
      } else {
        setEntries(null);
        setMessage(data.error || 'No matching entry found.');
        notify({ id: 'account-lookup', type: 'error', message: data.error || 'No matching entry found.' });
      }
    } catch {
      setMessage('Connection failed. Please try again.');
      notify({ id: 'account-lookup', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setIsBusy(false);
    }
  };

  // Logged-in accounts get their entries loaded automatically — no need to
  // hunt for a "find my entries" button. Lives AFTER `lookup` so the closure
  // references the const before it runs (declared above — no TDZ access).
  useEffect(() => {
    if (isLoggedIn && user?.email && !didAutoLookup.current) {
      didAutoLookup.current = true;
      lookup(user.email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, user]);

  const cancelEntry = async (entry: EntryRecord) => {
    if (!confirm(`Cancel your entry for ${entry.variant} (${entry.size})?`)) return;
    setIsBusy(true);
    notify({ id: 'account-cancel', type: 'loading', message: 'Cancelling your entry...', persist: true });
    try {
      const res = await fetch('/api/account/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email, 
          last4: last4 || undefined, 
          variant: entry.variant, 
          size: entry.size 
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Your entry has been cancelled.');
        notify({ id: 'account-cancel', type: 'success', message: 'Your entry has been cancelled.' });
        await lookup();
      } else {
        setMessage(data.error || 'Could not cancel entry.');
        notify({ id: 'account-cancel', type: 'error', message: data.error || 'Could not cancel entry.' });
      }
    } catch {
      setMessage('Connection failed. Please try again.');
      notify({ id: 'account-cancel', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setIsBusy(false);
    }
  };

  const saveAddress = async (entry: EntryRecord) => {
    setIsBusy(true);
    notify({ id: 'account-address', type: 'loading', message: 'Updating your shipping address...', persist: true });
    try {
      const res = await fetch('/api/account/update-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          last4: last4 || undefined,
          variant: entry.variant,
          size: entry.size,
          newAddress: addressDraft,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Shipping address updated.');
        notify({ id: 'account-address', type: 'success', message: 'Shipping address updated.' });
        setEditingAddressFor(null);
        await lookup();
      } else {
        setMessage(data.error || 'Could not update address.');
        notify({ id: 'account-address', type: 'error', message: data.error || 'Could not update address.' });
      }
    } catch {
      setMessage('Connection failed. Please try again.');
      notify({ id: 'account-address', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setIsBusy(false);
    }
  };

  const openPaymentPortal = async (entry?: EntryRecord) => {
    setIsBusy(true);
    setPaymentPortalFor(entry ? `${entry.variant}|${entry.size}` : 'all');
    notify({ id: 'account-portal', type: 'loading', message: 'Opening secure payment portal...', persist: true });
    try {
      const res = await fetch('/api/account/payment-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email, 
          last4: last4 || undefined, 
          variant: entry?.variant, 
          size: entry?.size 
        }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        notify({ id: 'account-portal', type: 'success', message: 'Secure payment portal ready.' });
        window.location.assign(data.url);
      } else {
        setMessage(data.error || 'Could not open payment portal.');
        notify({ id: 'account-portal', type: 'error', message: data.error || 'Could not open payment portal.' });
      }
    } catch {
      setMessage('Connection failed. Please try again.');
      notify({ id: 'account-portal', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setIsBusy(false);
      setPaymentPortalFor(null);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  };

  const [claimingWelcome, setClaimingWelcome] = useState(false);

  const claimWelcome = async () => {
    if (user && user.emailVerified === false) {
      notify({ id: 'account-welcome', type: 'alert', message: 'Confirm your email first — the code above unlocks your welcome rewards.' });
      return;
    }
    setClaimingWelcome(true);
    notify({ id: 'account-welcome', type: 'loading', message: 'Issuing your welcome credit...', persist: true });
    try {
      const res = await fetch('/api/account/claim-welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.promoCode) {
        setUser((prev: any) => ({ ...(prev || {}), welcomePromoCode: data.promoCode, rewards: data.points }));
        setPromos((prev) => {
          const list = Array.isArray(prev) ? [...prev] : [];
          if (!list.some((p) => p.code === data.promoCode)) {
            list.push({
              code: data.promoCode,
              customerDiscountPercent: 10,
              welcome: true,
              active: true,
              uses: 0,
              maxUsesTotal: 1,
              used: data.used === true,
              createdAt: new Date().toISOString(),
            });
          }
          return list;
        });
        notify({ id: 'account-welcome', type: 'success', message: `Your welcome credit ${data.promoCode} is ready — check your inbox too.` });
      } else {
        notify({ id: 'account-welcome', type: 'error', message: data.error || 'Could not issue your credit right now.' });
      }
    } catch {
      notify({ id: 'account-welcome', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setClaimingWelcome(false);
    }
  };

  // ── Redeem points for store credit ─────────────────────────────────────────
  const [redeemPointsInput, setRedeemPointsInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState('');
  const [redeemedCode, setRedeemedCode] = useState('');

  const redeemPoints = async () => {
    const points = Math.floor(Number(redeemPointsInput || 0));
    if (!Number.isFinite(points) || points <= 0) {
      setRedeemMsg('Enter how many points to redeem.');
      return;
    }
    setRedeeming(true);
    setRedeemMsg('');
    setRedeemedCode('');
    notify({ id: 'account-redeem', type: 'loading', message: 'Creating your store credit...', persist: true });
    try {
      const res = await fetch('/api/account/redeem-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
      });
      const data = await res.json();
      if (res.ok && data.code) {
        setRedeemedCode(data.code);
        setRedeemMsg(data.message || 'Credit created.');
        setUser((prev: any) => ({ ...(prev || {}), rewards: data.remainingPoints }));
        notify({ id: 'account-redeem', type: 'success', message: data.message || 'Credit created.' });
      } else {
        setRedeemMsg(data.error || 'Could not redeem points right now.');
        notify({ id: 'account-redeem', type: 'error', message: data.error || 'Could not redeem points right now.' });
      }
    } catch {
      setRedeemMsg('Connection failed. Please try again.');
      notify({ id: 'account-redeem', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setRedeeming(false);
    }
  };

  // ── Change password ────────────────────────────────────────────────────────
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [showPwdForm, setShowPwdForm] = useState(false);

  const changePassword = async () => {
    if (pwdNew !== pwdConfirm) {
      setPwdMsg('New passwords do not match.');
      return;
    }
    if (pwdNew.length < 6) {
      setPwdMsg('New password must be at least 6 characters.');
      return;
    }
    setPwdBusy(true);
    setPwdMsg('');
    notify({ id: 'account-password', type: 'loading', message: 'Updating your password...', persist: true });
    try {
      const res = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pwdCurrent, newPassword: pwdNew }),
      });
      const data = await res.json();
      if (res.ok) {
        setPwdMsg(data.message || 'Password updated.');
        setPwdCurrent('');
        setPwdNew('');
        setPwdConfirm('');
        setShowPwdForm(false);
        notify({ id: 'account-password', type: 'success', message: 'Password updated. Log in again with your new password.' });
      } else {
        setPwdMsg(data.error || 'Could not update password.');
        notify({ id: 'account-password', type: 'error', message: data.error || 'Could not update password.' });
      }
    } catch {
      setPwdMsg('Connection failed. Please try again.');
      notify({ id: 'account-password', type: 'error', message: 'Connection failed. Please try again.' });
    } finally {
      setPwdBusy(false);
    }
  };

  const hasOpenEntry = (entries || []).some((e) => !e.status || e.status === 'ENTERED');

  // Credits shown in the card come from the lookup's promos array; if the welcome
  // code lives on the user record but its promo record is missing (e.g. deleted
  // in admin), still surface it so the customer never loses sight of their code.
  const creditPromos = (() => {
    const list = Array.isArray(promos) ? [...promos] : [];
    if (user?.welcomePromoCode && !list.some((p) => p.code === user.welcomePromoCode)) {
      list.push({
        code: user.welcomePromoCode,
        customerDiscountPercent: 10,
        welcome: true,
        active: true,
        uses: 0,
        maxUsesTotal: 1,
        used: false,
      });
    }
    return list;
  })();
  const welcomePromoUsed = creditPromos.find((p) => p.code === user?.welcomePromoCode)?.used === true;

  return (
    <main
      style={{
        minHeight: 'calc(100vh - 56px)',
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        padding: '24px 16px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <Link
            href="/"
            prefetch={false}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 44,
              padding: '0 18px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              color: configPalette.cardTextMain,
              textDecoration: 'none',
              background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency),
              border: `1px solid ${configPalette.cardBorder}`,
            }}
          >
            ← Back to store
          </Link>
          {isLoggedIn && (
            <button
              onClick={handleLogout}
              style={{
                padding: '8px 16px',
                borderRadius: 999,
                border: '1px solid #f87171',
                background: 'transparent',
                color: '#f87171',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Log out
            </button>
          )}
        </div>

        {/* Page header */}
        <div style={{ marginBottom: 22 }}>
          <h1 style={{ fontSize: 28, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 4px', color: configPalette.textMain }}>My Account</h1>
          <p style={{ fontSize: 13, color: configPalette.textMuted, margin: 0, lineHeight: 1.6 }}>
            {isLoggedIn
              ? `Signed in as ${user?.email} — manage your entries, rewards and credits.`
              : 'Sign in to securely view and manage your entries and rewards.'}
          </p>
        </div>

        {isLoggedIn && user && user.emailVerified === false && (
          <div style={{ background: configPalette.cardBackground, border: '1px solid rgba(250,204,21,0.35)', borderRadius: themeRadius(configPalette, 20), padding: 18, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: '#facc15', boxShadow: '0 0 0 3px rgba(250,204,21,0.16)' }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: configPalette.cardTextMain }}>Confirm your email to unlock rewards</div>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.6 }}>
              We emailed a 6-digit code to <strong style={{ color: configPalette.cardTextMain }}>{user.email}</strong> when you signed up. Enter it below to verify the inbox is real — your 250 welcome points and one-time 10% credit unlock right after.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                name="one-time-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                ref={(el) => {
                  if (el) (el as HTMLInputElement & { textContentType?: string }).textContentType = 'oneTimeCode';
                }}
                placeholder="6-digit code"
                style={{ flex: 1, minWidth: 130, padding: 9, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 13, letterSpacing: 4, textAlign: 'center' }}
              />
              <button onClick={handleAccountVerify} disabled={verifyBusy || verifyCode.length !== 6} style={{ padding: '9px 16px', borderRadius: 999, border: 'none', background: verifyBusy || verifyCode.length !== 6 ? '#555' : '#facc15', color: '#1a1a06', fontWeight: 700, fontSize: 12, cursor: verifyBusy || verifyCode.length !== 6 ? 'not-allowed' : 'pointer' }}>
                {verifyBusy ? 'Verifying…' : 'Verify'}
              </button>
              <button onClick={handleAccountResend} disabled={verifyBusy} style={{ padding: '9px 14px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, background: 'transparent', color: configPalette.cardTextMuted, fontSize: 12, cursor: verifyBusy ? 'not-allowed' : 'pointer' }}>Resend code</button>
            </div>
            {verifyMsg && <p style={{ margin: '10px 0 0', fontSize: 12, color: verifyMsg.toLowerCase().includes('verified') || verifyMsg.toLowerCase().includes('sent') ? '#34d399' : '#f87171', lineHeight: 1.5 }}>{verifyMsg}</p>}
          </div>
        )}

        {!isLoggedIn && (
          <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 20), padding: 20, marginBottom: 18 }}>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.6 }}>
              Account login is required to prevent address and entry access by guessing card digits. Entries are linked to your email — sign in to see them.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link href="/auth/login" prefetch={false} style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.checkoutCtaButton || '#635bff', color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>Log in</Link>
              <Link href="/auth/signup" prefetch={false} style={{ padding: '10px 16px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>Create account</Link>
            </div>
          </div>
        )}

        {isLoggedIn && user && (
          <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 22), padding: 20, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase', color: configPalette.cardTextMuted, marginBottom: 6 }}>Rewards balance</div>
                <div style={{ fontSize: 34, fontWeight: 800, color: configPalette.cardTextMain, lineHeight: 1 }}>
                  {Number(user.rewards || 0).toLocaleString()}
                  <span style={{ fontSize: 13, fontWeight: 500, color: configPalette.cardTextMuted, marginLeft: 8 }}>points</span>
                </div>
                <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 8 }}>
                  {rewardsConfig.pointsPerDollar
                    ? `${Number(rewardsConfig.pointsPerDollar).toLocaleString()} points = $1.00 credit`
                    : 'Points convert to store credit at checkout.'}
                  {rewardsConfig.minRedeemPoints ? ` · minimum ${Number(rewardsConfig.minRedeemPoints).toLocaleString()} points` : ''}
                </div>
              </div>
              {user.welcomePromoCode ? (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: themeRadius(configPalette, 12),
                    background: welcomePromoUsed ? 'rgba(148,163,184,0.06)' : 'rgba(34,197,94,0.08)',
                    border: welcomePromoUsed ? '1px solid rgba(148,163,184,0.2)' : '1px solid rgba(34,197,94,0.2)',
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxWidth: 220,
                  }}
                >
                  <div style={{ color: configPalette.cardTextMuted, fontSize: 11 }}>
                    {welcomePromoUsed
                      ? 'One-time welcome credit — used:'
                      : 'One-time welcome credit — ready at checkout:'}
                  </div>
                  <div style={{ fontWeight: 800, letterSpacing: 1, color: welcomePromoUsed ? '#94a3b8' : '#34c759', marginTop: 4, wordBreak: 'break-all' }}>{user.welcomePromoCode}</div>
                </div>
              ) : (
                <div style={{ padding: '10px 12px', borderRadius: themeRadius(configPalette, 12), background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.16)', fontSize: 12, lineHeight: 1.5, maxWidth: 220 }}>
                  <div style={{ color: configPalette.cardTextMuted, fontSize: 11 }}>Unlock your welcome credit — 10% off your first release.</div>
                  <button
                    onClick={claimWelcome}
                    disabled={claimingWelcome}
                    style={{ marginTop: 8, padding: '8px 12px', borderRadius: 999, border: 'none', background: '#34c759', color: '#06120a', fontWeight: 700, fontSize: 12, cursor: claimingWelcome ? 'not-allowed' : 'pointer' }}
                  >
                    {claimingWelcome ? 'Issuing…' : 'Claim my 10% credit'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

            {isLoggedIn && (
              <div style={{ marginTop: 0, padding: '16px 18px', borderRadius: themeRadius(configPalette, 18), background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
                <div style={{ color: configPalette.cardTextMuted, fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>Redeem points for store credit</div>
                <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginBottom: 8 }}>
                  {rewardsConfig.pointsPerDollar
                    ? `${Number(rewardsConfig.pointsPerDollar).toLocaleString()} points = $1.00 credit`
                    : 'Points convert to store credit at checkout.'}
                  {rewardsConfig.minRedeemPoints ? ` · minimum ${Number(rewardsConfig.minRedeemPoints).toLocaleString()} points` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    min={0}
                    placeholder="Points"
                    value={redeemPointsInput}
                    onChange={(e) => setRedeemPointsInput(e.target.value)}
                    style={{ flex: 1, padding: 9, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 12 }}
                  />
                  <button onClick={redeemPoints} disabled={redeeming} style={{ padding: '9px 14px', borderRadius: 999, border: 'none', background: '#7dd3fc', color: '#07121f', fontWeight: 700, fontSize: 12, cursor: redeeming ? 'not-allowed' : 'pointer' }}>
                    {redeeming ? 'Redeeming…' : 'Redeem'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 8, lineHeight: 1.5 }}>
                  {(() => {
                    const giftPercent = Math.max(0, Number(rewardsConfig.giftDiscountPercent) || 10);
                    const custom = String(rewardsConfig.redemptionInfoMessage || '').trim();
                    if (custom) {
                      return custom.replace(/\{giftPercent\}/g, String(giftPercent));
                    }
                    return `Every redemption issues a unique one-time promo code.${
                      rewardsConfig.giftingEnabled === false
                        ? ' It is reserved to your account only.'
                        : rewardsConfig.giftDiscountPercent
                          ? ` You can keep it or gift it to someone — a gifted code is worth ${giftPercent}% less than face value.`
                          : ' You can keep it or gift it to someone else.'
                    }`;
                  })()}
                </div>
                {redeemMsg && <div style={{ marginTop: 8, fontSize: 11, color: redeemedCode ? '#34d399' : '#fbbf24' }}>{redeemMsg}</div>}
                {redeemedCode && (
                  <div style={{ marginTop: 6, fontWeight: 800, letterSpacing: 1, color: '#7dd3fc' }}>{redeemedCode}</div>
                )}
              </div>
            )}

            {isLoggedIn && creditPromos.length > 0 && (
              <div style={{ marginBottom: 14, padding: '16px 18px', borderRadius: themeRadius(configPalette, 18), background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ color: configPalette.cardTextMuted, fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 4 }}>Your credits & codes</div>
                {creditPromos.map((promo) => (
                  <div
                    key={promo.code}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '10px 0',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontWeight: 800,
                            letterSpacing: 1,
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: promo.used ? '#94a3b8' : '#7dd3fc',
                            wordBreak: 'break-all',
                          }}
                        >
                          {promo.code}
                        </span>
                        {promo.welcome && <span style={{ fontSize: 10, color: configPalette.cardTextMuted }}>welcome credit</span>}
                      </div>
                      <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 2 }}>
                        {(promo.fixedDiscountCents || 0) > 0
                          ? `$${((promo.fixedDiscountCents || 0) / 100).toFixed(2)} credit`
                          : `${promo.customerDiscountPercent || 0}% off`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 700,
                          background: promo.used ? 'rgba(148,163,184,0.15)' : 'rgba(52,199,89,0.15)',
                          color: promo.used ? '#94a3b8' : '#34d399',
                        }}
                      >
                        {promo.used ? 'USED' : 'AVAILABLE'}
                      </span>
                      <button
                        onClick={() => copyCode(promo.code)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 999,
                          border: `1px solid ${configPalette.cardBorder}`,
                          background: 'transparent',
                          color: configPalette.cardTextMain,
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        {copiedCode === promo.code ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isLoggedIn && (
              <div style={{ marginBottom: 14, padding: '16px 18px', borderRadius: themeRadius(configPalette, 18), background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, fontSize: 12, lineHeight: 1.5 }}>
                {!showPwdForm ? (
                  <button
                    onClick={() => setShowPwdForm(true)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: configPalette.cardTextMuted,
                      fontSize: 12,
                      textDecoration: 'underline',
                      cursor: 'pointer',
                    }}
                  >
                    Change password
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ color: configPalette.cardTextMuted, fontSize: 11 }}>Change password</div>
                    <input type="password" placeholder="Current password" value={pwdCurrent} onChange={(e) => setPwdCurrent(e.target.value)} style={{ padding: 9, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 12 }} />
                    <input type="password" placeholder="New password (min 6 chars)" value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} style={{ padding: 9, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 12 }} />
                    <input type="password" placeholder="Confirm new password" value={pwdConfirm} onChange={(e) => setPwdConfirm(e.target.value)} style={{ padding: 9, borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, fontSize: 12 }} />
                    {pwdMsg && <div style={{ fontSize: 11, color: pwdMsg.includes('updated') ? '#34d399' : '#f87171' }}>{pwdMsg}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={changePassword} disabled={pwdBusy} style={{ padding: '9px 14px', borderRadius: 999, border: 'none', background: '#f3f4f6', color: '#09090b', fontWeight: 700, fontSize: 12, cursor: pwdBusy ? 'not-allowed' : 'pointer' }}>
                        {pwdBusy ? 'Saving…' : 'Update password'}
                      </button>
                      <button onClick={() => setShowPwdForm(false)} style={{ padding: '9px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: configPalette.cardTextMuted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}

        <div style={{ marginTop: 26, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 17, fontFamily: 'Georgia, Times New Roman, serif', margin: 0, color: configPalette.cardTextMain }}>My Entries</h2>
          {isLoggedIn && (
            <button
              onClick={() => lookup()}
              disabled={isBusy}
              style={{
                padding: '9px 14px',
                borderRadius: 999,
                background: 'transparent',
                border: `1px solid ${configPalette.cardBorder}`,
                color: configPalette.cardTextMain,
                fontSize: 12,
                fontWeight: 700,
                cursor: isBusy ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {isBusy ? 'Refreshing…' : '↻ Refresh entries'}
            </button>
          )}
        </div>
        {isLoggedIn && (
          <div style={{ fontSize: 11, color: configPalette.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
            Your entries load automatically from <strong style={{ color: configPalette.textMain }}>{email}</strong>.
          </div>
        )}

        {message && (
          <p style={{ marginTop: 16, fontSize: 12, textAlign: 'center', color: configPalette.textMuted }}>{message}</p>
        )}

        {entries && entries.length > 0 && (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {entries.map((entry, idx) => {
              const isWinner = entry.status === 'WINNER_CHARGED';
              const isSettled = entry.status && entry.status !== 'ENTERED';
              const isTerminal = TERMINAL_STATUSES.includes(entry.status || '');
              const canEdit = !isSettled;
              const banner = statusBanner(entry);
              return (
                <div
                  key={`${entry.variant}-${entry.size}-${entry.registeredAt}-${idx}`}
                  style={{
                    background: configPalette.cardBackground,
                    border: `1px solid ${configPalette.cardBorder}`,
                    borderRadius: themeRadius(configPalette, 16),
                    padding: 16,
                  }}
                >
                  <div style={{ fontWeight: 'bold', fontSize: 14, color: configPalette.cardTextMain }}>
                    {entry.variant} — {entry.size}
                  </div>
                  <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 2 }}>
                    {statusLabel(entry.status)}
                  </div>
                  {entry.orderRef && (
                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: configPalette.cardTextMuted, marginTop: 4 }}>
                      Order ref: {entry.orderRef}
                    </div>
                  )}
                  {(typeof entry.listPrice === 'number' ||
                    typeof entry.amountCents === 'number' ||
                    typeof entry.expectedAmountCents === 'number' ||
                    entry.promoCode) && (
                    <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.45 }}>
                      {isTerminal ? (
                        typeof entry.amountCents === 'number' && (
                          <div style={{ color: '#34c759', fontWeight: 600 }}>
                            Charged: ${(entry.amountCents / 100).toFixed(2)}
                          </div>
                        )
                      ) : (
                        <>
                          {(typeof entry.expectedAmountCents === 'number' ||
                            (typeof entry.listPrice === 'number' && entry.listPrice > 0)) && (
                            <div style={{ color: configPalette.cardTextMuted }}>
                              Charge if selected: $
                              {(
                                (entry.expectedAmountCents ??
                                  Math.round(
                                    (entry.listPrice || 0) * 100 * (1 - (entry.discountPercent || 0) / 100),
                                  )) / 100
                              ).toFixed(2)}
                            </div>
                          )}
                          {typeof entry.listPrice === 'number' && entry.listPrice > 0 && (
                            <div style={{ color: configPalette.cardTextMuted, marginTop: 2 }}>
                              List ${entry.listPrice.toFixed(2)}
                              {entry.discountPercent && entry.discountPercent > 0
                                ? ` → ${entry.discountPercent}% off`
                                : ''}
                            </div>
                          )}
                        </>
                      )}
                      {entry.promoCode && (
                        <div
                          style={{
                            color: isTerminal ? configPalette.cardTextMuted : '#edb210',
                            marginTop: 2,
                          }}
                        >
                          {isTerminal
                            ? `Promo ${entry.promoCode} applied`
                            : `Promo ${entry.promoCode}${
                                entry.discountPercent && entry.discountPercent > 0
                                  ? ` · ${entry.discountPercent}% off if selected`
                                  : ' if selected'
                              }`}
                        </div>
                      )}
                    </div>
                  )}
                  {entry.shippingAddress && (
                    <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 4 }}>
                      Shipping: {entry.shippingAddress}
                    </div>
                  )}
                  {banner && (
                    <div style={{ marginTop: 10, fontSize: 12, color: banner.color, fontWeight: 600 }}>
                      {banner.text}
                    </div>
                  )}

                  {canEdit && (
                    <>
                      {editingAddressFor === `${entry.variant}-${entry.size}` ? (
                        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input
                            type="text"
                            value={addressDraft}
                            onChange={(e) => setAddressDraft(e.target.value)}
                            style={{
                              width: '100%',
                              padding: 10,
                              borderRadius: themeRadius(configPalette, 12),
                              background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`,
                              border: `1px solid ${configPalette.cardBorder}`,
                              color: configPalette.cardTextMain,
                              fontSize: 12,
                              boxSizing: 'border-box',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={() => saveAddress(entry)}
                              disabled={isBusy}
                              style={{
                                flex: 1,
                                minHeight: 44,
                                borderRadius: 999,
                                border: 'none',
                                background: '#34c759',
                                color: '#000',
                                fontSize: 12,
                                fontWeight: 'bold',
                                cursor: 'pointer',
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingAddressFor(null)}
                              style={{
                                flex: 1,
                                minHeight: 44,
                                borderRadius: 999,
                                border: `1px solid ${configPalette.cardBorder}`,
                                background: 'transparent',
                                color: '#aaa',
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                          <button
                            onClick={() => {
                              setEditingAddressFor(`${entry.variant}-${entry.size}`);
                              setAddressDraft(entry.shippingAddress || '');
                            }}
                            style={{
                              minHeight: 44,
                              padding: '0 14px',
                              borderRadius: 999,
                              border: `1px solid ${configPalette.cardBorder}`,
                              background: 'transparent',
                              color: '#ccc',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Edit address
                          </button>
                          <button
                            onClick={() => cancelEntry(entry)}
                            disabled={isBusy}
                            style={{
                              minHeight: 44,
                              padding: '0 14px',
                              borderRadius: 999,
                              border: '1px solid #ff3b30',
                              background: 'transparent',
                              color: '#ff3b30',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel entry
                          </button>
                          <button
                            onClick={() => openPaymentPortal(entry)}
                            disabled={isBusy || paymentPortalFor !== null}
                            style={{
                              minHeight: 44,
                              padding: '0 14px',
                              borderRadius: 999,
                              border: `1px solid ${configPalette.cardBorder}`,
                              background: 'transparent',
                              color: '#60a5fa',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            {paymentPortalFor === `${entry.variant}|${entry.size}` ? 'Loading…' : 'Update payment'}
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {isWinner && (
                    <p style={{ margin: '10px 0 0', fontSize: 11, color: configPalette.cardTextMuted }}>
                      Address and payment are locked after a successful allocation.
                    </p>
                  )}
                </div>
              );
            })}

            {hasOpenEntry && (
              <button
                onClick={() => openPaymentPortal()}
                disabled={isBusy}
                style={{
                  width: '100%',
                  minHeight: 48,
                  borderRadius: 999,
                  background: 'transparent',
                  border: `1px solid ${configPalette.cardBorder}`,
                  color: configPalette.textMain,
                  fontSize: 13,
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  marginTop: 8,
                }}
              >
                Update payment method for all entries
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}