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
}

function statusBanner(entry: EntryRecord) {
  if (entry.status === 'WINNER_CHARGED') {
    return {
      color: '#34c759',
      text: `🎉 You won! Charged $${((entry.amountCents || 0) / 100).toFixed(2)}. Shipping status: ${(entry.shippingStatus || 'PENDING_FULFILLMENT').replace(/_/g, ' ').toLowerCase()}.`,
    };
  }
  if (entry.status === 'WINNER_DECLINED') {
    return { color: '#f87171', text: 'You were selected, but the charge failed. Contact support to resolve.' };
  }
  if (entry.status === 'NOT_SELECTED') {
    return { color: '#94a3b8', text: 'Not selected this round — you stay entered automatically for the next drop.' };
  }
  if (entry.status === 'CANCELLED_BY_USER') {
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
    setIsBusy(true); setMessage('');
    try {
      const res = await fetch('/api/account/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, last4 }) });
      const data = await res.json();
      if (res.ok) setEntries(data.entries); else { setEntries(null); setMessage(data.error || 'No matching entry found.'); }
    } catch { setMessage('Connection failed. Please try again.'); }
    finally { setIsBusy(false); }
  };

  const cancelEntry = async (entry: EntryRecord) => {
    if (!confirm(`Cancel your entry for ${entry.variant} (${entry.size})? This cannot be undone.`)) return;
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, last4, variant: entry.variant, size: entry.size }) });
      const data = await res.json();
      if (res.ok) { setMessage('Your entry has been cancelled.'); await lookup(); } else setMessage(data.error || 'Could not cancel entry.');
    } catch { setMessage('Connection failed. Please try again.'); }
    finally { setIsBusy(false); }
  };

  const saveAddress = async (entry: EntryRecord) => {
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/update-address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, last4, variant: entry.variant, size: entry.size, newAddress: addressDraft }) });
      const data = await res.json();
      if (res.ok) { setMessage('Shipping address updated.'); setEditingAddressFor(null); await lookup(); } else setMessage(data.error || 'Could not update address.');
    } catch { setMessage('Connection failed. Please try again.'); }
    finally { setIsBusy(false); }
  };

  const openPaymentPortal = async () => {
    setIsBusy(true);
    try {
      const res = await fetch('/api/account/payment-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, last4 }) });
      const data = await res.json();
      if (res.ok && data.url) window.location.assign(data.url); else setMessage(data.error || 'Could not open payment portal.');
    } catch { setMessage('Connection failed. Please try again.'); }
    finally { setIsBusy(false); }
  };

  return (
    <main style={{ minHeight: '100vh', background: configPalette.primaryBackground, color: configPalette.textMain, padding: '80px 20px 60px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '420px', margin: '0 auto' }}>
        <Link href="/" style={{ fontSize: '13px', color: configPalette.textMuted, textDecoration: 'none', display: 'inline-block', marginBottom: '24px', padding: '10px 14px', borderRadius: '20px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${configPalette.cardBorder}` }}>← Back to storefront</Link>
        <h1 style={{ fontSize: '20px', fontFamily: 'serif', margin: '0 0 4px 0' }}>Manage My Entry</h1>
        <p style={{ fontSize: '12px', color: configPalette.textMuted, margin: '0 0 24px 0' }}>Verify with the email and the last 4 digits of the card you used to enter.</p>

        <div style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: '20px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input type="email" placeholder="Email used at entry" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: '#16161a', border: `1px solid ${configPalette.cardBorder}`, color: '#fff', fontSize: '13px', boxSizing: 'border-box' }} />
          <input type="text" inputMode="numeric" maxLength={4} placeholder="Last 4 digits of card" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: '#16161a', border: `1px solid ${configPalette.cardBorder}`, color: '#fff', fontSize: '13px', boxSizing: 'border-box' }} />
          <button onClick={lookup} disabled={isBusy || !email || last4.length !== 4} style={{ width: '100%', padding: '14px', borderRadius: '30px', background: configPalette.checkoutCtaButton, color: '#fff', border: 'none', fontWeight: 'bold', fontSize: '13px', cursor: isBusy ? 'not-allowed' : 'pointer' }}>
            {isBusy ? 'Checking…' : 'Find My Entry'}
          </button>
        </div>

        {message && <p style={{ marginTop: '16px', fontSize: '12px', textAlign: 'center', color: '#cbd5e1' }}>{message}</p>}

        {entries && entries.length > 0 && (
          <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {entries.map((entry) => {
              const isSettled = entry.status && entry.status !== 'ENTERED';
              const banner = statusBanner(entry);
              return (
                <div key={`${entry.variant}-${entry.size}`} style={{ background: configPalette.cardBackground, border: `1px solid ${configPalette.cardBorder}`, borderRadius: '16px', padding: '16px' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{entry.variant} — {entry.size}</div>
                  {entry.shippingAddress && <div style={{ fontSize: '11px', color: configPalette.textMuted, marginTop: '4px' }}>Shipping to: {entry.shippingAddress}</div>}

                  {banner && (
                    <div style={{ marginTop: '10px', fontSize: '12px', color: banner.color, fontWeight: 600 }}>{banner.text}</div>
                  )}

                  {!isSettled && (
                    editingAddressFor === `${entry.variant}-${entry.size}` ? (
                      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <input type="text" value={addressDraft} onChange={(e) => setAddressDraft(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '10px', background: '#16161a', border: `1px solid ${configPalette.cardBorder}`, color: '#fff', fontSize: '12px', boxSizing: 'border-box' }} />
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => saveAddress(entry)} disabled={isBusy} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: '#34c759', color: '#000', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>Save</button>
                          <button onClick={() => setEditingAddressFor(null)} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: `1px solid ${configPalette.cardBorder}`, background: 'transparent', color: '#aaa', fontSize: '11px', cursor: 'pointer' }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
                        <button onClick={() => { setEditingAddressFor(`${entry.variant}-${entry.size}`); setAddressDraft(entry.shippingAddress); }} style={{ padding: '8px 12px', borderRadius: '10px', border: `1px solid ${configPalette.cardBorder}`, background: 'transparent', color: '#ccc', fontSize: '11px', cursor: 'pointer' }}>Edit Address</button>
                        <button onClick={() => cancelEntry(entry)} disabled={isBusy} style={{ padding: '8px 12px', borderRadius: '10px', border: '1px solid #ff3b30', background: 'transparent', color: '#ff3b30', fontSize: '11px', cursor: 'pointer' }}>Cancel Entry</button>
                      </div>
                    )
                  )}
                </div>
              );
            })}
            <button onClick={openPaymentPortal} disabled={isBusy} style={{ width: '100%', padding: '14px', borderRadius: '30px', background: 'transparent', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', marginTop: '8px' }}>🔒 Update Payment Method (via Stripe)</button>
          </div>
        )}
      </div>
    </main>
  );
}