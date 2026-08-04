'use client';
import { useState } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

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
  return null;
}

export default function AccountPage() {
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const [entries, setEntries] = useState<EntryRecord[] | null>(null);
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [editingAddressFor, setEditingAddressFor] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');

  const lookup = async () => {
    setIsBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/account/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, last4 }),
      });
      const data = await res.json();
      if (res.ok) setEntries(data.entries);
      else {
        setEntries(null);
        setMessage(data.error || 'No matching entry found.');
      }
    } catch {
      setMessage('Connection failed. Please try again.');
    } finally {
      setIsBusy(false);
    }
  };

  const cancelEntry = async (entry: EntryRecord) => {
    if (!confirm(`Cancel your entry for ${entry.variant} (${entry.size})?`)) return;
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, last4, variant: entry.variant, size: entry.size }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Your entry has been cancelled.');
        await lookup();
      } else setMessage(data.error || 'Could not cancel entry.');
    } catch {
      setMessage('Connection failed. Please try again.');
    } finally {
      setIsBusy(false);
    }
  };

  const saveAddress = async (entry: EntryRecord) => {
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/update-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          last4,
          variant: entry.variant,
          size: entry.size,
          newAddress: addressDraft,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Shipping address updated.');
        setEditingAddressFor(null);
        await lookup();
      } else setMessage(data.error || 'Could not update address.');
    } catch {
      setMessage('Connection failed. Please try again.');
    } finally {
      setIsBusy(false);
    }
  };

  const openPaymentPortal = async () => {
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/payment-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, last4 }),
      });
      const data = await res.json();
      if (res.ok && data.url) window.location.assign(data.url);
      else setMessage(data.error || 'Could not open payment portal.');
    } catch {
      setMessage('Connection failed. Please try again.');
    } finally {
      setIsBusy(false);
    }
  };

  const hasOpenEntry = (entries || []).some((e) => !e.status || e.status === 'ENTERED');

  return (
    <main
      style={{
        minHeight: '100vh',
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        padding: '24px 16px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 420, margin: '0 auto' }}>
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
            marginBottom: 24,
          }}
        >
          ← Back to store
        </Link>

        <h1 style={{ fontSize: 20, fontFamily: 'serif', margin: '0 0 4px' }}>Manage My Entry</h1>
        <p style={{ fontSize: 12, color: configPalette.textMuted, margin: '0 0 24px' }}>
          Verify with the email and last 4 digits of the card used to enter.
        </p>

        <div
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
          <input
            type="email"
            placeholder="Email used at entry"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 12,
              background: '#16161a',
              border: `1px solid ${configPalette.cardBorder}`,
              color: '#fff',
              fontSize: 13,
              boxSizing: 'border-box',
            }}
          />
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            placeholder="Last 4 digits of card"
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 12,
              background: '#16161a',
              border: `1px solid ${configPalette.cardBorder}`,
              color: '#fff',
              fontSize: 13,
              boxSizing: 'border-box',
            }}
          />
          <button
            onClick={lookup}
            disabled={isBusy || !email || last4.length !== 4}
            style={{
              width: '100%',
              minHeight: 48,
              borderRadius: 30,
              background: configPalette.checkoutCtaButton,
              color: '#fff',
              border: 'none',
              fontWeight: 'bold',
              fontSize: 13,
              cursor: isBusy ? 'not-allowed' : 'pointer',
            }}
          >
            {isBusy ? 'Checking…' : 'Find My Entry'}
          </button>
        </div>

        {message && (
          <p style={{ marginTop: 16, fontSize: 12, textAlign: 'center', color: '#cbd5e1' }}>{message}</p>
        )}

        {entries && entries.length > 0 && (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {entries.map((entry) => {
              const isWinner = entry.status === 'WINNER_CHARGED';
              const isSettled = entry.status && entry.status !== 'ENTERED';
              const canEdit = !isSettled;
              const banner = statusBanner(entry);
              return (
                <div
                  key={`${entry.variant}-${entry.size}-${entry.registeredAt}`}
                  style={{
                    background: configPalette.cardBackground,
                    border: `1px solid ${configPalette.cardBorder}`,
                    borderRadius: 16,
                    padding: 16,
                  }}
                >
                  <div style={{ fontWeight: 'bold', fontSize: 14 }}>
                    {entry.variant} — {entry.size}
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
                            <div style={{ color: configPalette.textMuted }}>
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
                                          entry.listPrice *
                                            100 *
                                            (1 - entry.discountPercent / 100),
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
                    <div style={{ fontSize: 11, color: configPalette.textMuted, marginTop: 4 }}>
                      Shipping: {entry.shippingAddress}
                    </div>
                  )}
                  {banner && (
                    <div style={{ marginTop: 10, fontSize: 12, color: banner.color, fontWeight: 600 }}>
                      {banner.text}
                    </div>
                  )}

                  {canEdit &&
                    (editingAddressFor === `${entry.variant}-${entry.size}` ? (
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
                      </div>
                    ))}

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
                onClick={openPaymentPortal}
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
                Update payment method
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}