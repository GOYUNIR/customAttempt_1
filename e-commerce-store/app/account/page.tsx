'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { fetchStoreJson } from '@/lib/client-store-cache';

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
}

function notify(detail: { id?: string; type: string; message: string; persist?: boolean }) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('goyunir-notify', { detail }));
}

function statusBanner(entry: EntryRecord) {
  if (entry.status === 'WINNER_CHARGED') {
    return {
      color: '#34c759',
      text: `You won this allocation. Charged $${((entry.amountCents || 0) / 100).toFixed(2)}. Shipping: ${(entry.shippingStatus || 'PENDING_FULFILLMENT').replace(/_/g, ' ').toLowerCase()}.`,
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
  // Live theme palette — starts at the build-time config and upgrades to the
  // /admin → Settings theme (served through /api/store → config → themeColors)
  // so design presets apply to the account page too.
  const [configPalette, setConfigPalette] = useState<any>(GOYUNIR_STORE_SUITE.themeColors);
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const [entries, setEntries] = useState<EntryRecord[] | null>(null);
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [editingAddressFor, setEditingAddressFor] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [paymentPortalFor, setPaymentPortalFor] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const didAutoLookup = useRef(false);

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

  // Logged-in accounts get their entries loaded automatically — no need to
  // hunt for a "find my entries" button.
  useEffect(() => {
    if (isLoggedIn && user?.email && !didAutoLookup.current) {
      didAutoLookup.current = true;
      lookup(user.email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const hasOpenEntry = (entries || []).some((e) => !e.status || e.status === 'ENTERED');

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
      <div style={{ maxWidth: 420, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 44,
              padding: '0 18px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              color: configPalette.textMain,
              textDecoration: 'none',
              background: 'rgba(255,255,255,0.06)',
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
                borderRadius: 8,
                border: '1px solid #f87171',
                background: 'transparent',
                color: '#f87171',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Logout
            </button>
          )}
        </div>

        {isLoggedIn && user && (
          <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 12, padding: 12, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: configPalette.cardTextMain }}>{user.email}</div>
                <div style={{ fontSize: 11, color: configPalette.cardTextMuted }}>Rewards: {Number(user.rewards || 0).toLocaleString()} points</div>
              </div>
            </div>
            {user.welcomePromoCode ? (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ color: configPalette.cardTextMuted, fontSize: 11 }}>Your one-time 10% welcome credit (applies at checkout):</div>
                <div style={{ fontWeight: 800, letterSpacing: 1, color: '#34c759', marginTop: 4 }}>{user.welcomePromoCode}</div>
              </div>
            ) : (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.16)', fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ color: configPalette.cardTextMuted, fontSize: 11 }}>Unlock your welcome credit — 10% off your first release + a points balance.</div>
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
        )}

        <h1 style={{ fontSize: 20, fontFamily: 'serif', margin: '0 0 4px' }}>Manage My Entry</h1>
        <p style={{ fontSize: 12, color: configPalette.textMuted, margin: '0 0 24px' }}>
          {isLoggedIn
            ? 'Your entries are linked to your account for secure management.'
            : 'Sign in to securely view and manage your entries.'}
        </p>

        {!isLoggedIn && (
          <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: 16, padding: 16, marginBottom: 18 }}>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: configPalette.cardTextMuted }}>
              Account login is required to prevent address/entry access by guessing card digits.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link href="/auth/login" style={{ padding: '10px 14px', borderRadius: 999, background: configPalette.checkoutCtaButton, color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>Log in</Link>
              <Link href="/auth/signup" style={{ padding: '10px 14px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain, textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>Create account</Link>
            </div>
          </div>
        )}

        {isLoggedIn && <div
          style={{
            background: configPalette.cardBackground,
            border: `1px solid ${configPalette.cardBorder}`,
            borderRadius: 20,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.5 }}>
              Your entries load automatically from <strong style={{ color: configPalette.cardTextMain }}>{email}</strong>.
            </div>
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
          </div>
        </div>}

        {message && (
          <p style={{ marginTop: 16, fontSize: 12, textAlign: 'center', color: configPalette.cardTextMuted }}>{message}</p>
        )}

        {entries && entries.length > 0 && (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {entries.map((entry, idx) => {
              const isWinner = entry.status === 'WINNER_CHARGED';
              const isSettled = entry.status && entry.status !== 'ENTERED';
              const canEdit = !isSettled;
              const banner = statusBanner(entry);
              return (
                <div
                  key={`${entry.variant}-${entry.size}-${entry.registeredAt}-${idx}`}
                  style={{
                    background: configPalette.cardBackground,
                    border: `1px solid ${configPalette.cardBorder}`,
                    borderRadius: 16,
                    padding: 16,
                  }}
                >
                  <div style={{ fontWeight: 'bold', fontSize: 14, color: configPalette.cardTextMain }}>
                    {entry.variant} — {entry.size}
                  </div>
                  <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 2 }}>
                    {entry.status || 'Active entry'}
                  </div>
                  {(typeof entry.listPrice === 'number' ||
                    typeof entry.amountCents === 'number' ||
                    typeof entry.expectedAmountCents === 'number' ||
                    entry.promoCode) && (
                    <div style={{ fontSize: 12, marginTop: 8, lineHeight: 1.45 }}>
                      {entry.status === 'WINNER_CHARGED' && typeof entry.amountCents === 'number' ? (
                        <div style={{ color: '#34c759', fontWeight: 600 }}>
                          Charged ${(entry.amountCents / 100).toFixed(2)}
                          {entry.promoCode ? ` · promo ${entry.promoCode}` : ''}
                        </div>
                      ) : (
                        <>
                          {typeof entry.listPrice === 'number' && (
                            <div style={{ color: configPalette.cardTextMuted }}>
                              List ${entry.listPrice.toFixed(2)}
                              {entry.discountPercent && entry.discountPercent > 0 ? (
                                <>
                                  {' '}
                                  →{' '}
                                  <span style={{ color: '#edb210', fontWeight: 600 }}>
                                    $
                                    {(
                                      (entry.expectedAmountCents ??
                                        Math.round(
                                          entry.listPrice * 100 * (1 - entry.discountPercent / 100),
                                        )) / 100
                                    ).toFixed(2)}
                                  </span>
                                  {` if selected (${entry.discountPercent}% off)`}
                                </>
                              ) : (
                                <span> if selected</span>
                              )}
                            </div>
                          )}
                          {entry.promoCode && (
                            <div style={{ color: '#edb210', marginTop: 2 }}>
                              Promo {entry.promoCode}
                              {entry.discountPercent && entry.discountPercent > 0
                                ? ` · ${entry.discountPercent}% off`
                                : ''}
                            </div>
                          )}
                        </>
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
                              borderRadius: 10,
                              background: '#16161a',
                              border: `1px solid ${configPalette.cardBorder}`,
                              color: '#fff',
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
                                borderRadius: 10,
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
                                borderRadius: 10,
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
                              borderRadius: 10,
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
                              borderRadius: 10,
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
                              borderRadius: 10,
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
                    <p style={{ margin: '10px 0 0', fontSize: 11, color: '#666' }}>
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
                  borderRadius: 30,
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