'use client';

import { useState } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function ReleaseWaitlist({
  source,
  headline,
  body,
  palette,
}: {
  source: 'home' | 'catalog';
  headline: string;
  body: string;
  /** Live theme palette (from /api/store → themeColors) so this card follows presets. */
  palette?: any;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const c = { ...GOYUNIR_STORE_SUITE.themeColors, ...(palette || {}) };
  const isLight = (() => {
    const hex = String(c.cardBackground || '').replace('#', '');
    if (hex.length !== 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return false;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.58;
  })();
  const cardText = isLight ? '#111113' : '#ffffff';
  const cardTextMuted = isLight ? '#57534e' : '#c8c8cf';

  const subscribe = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      setStatus('Enter a valid email address.');
      return;
    }

    setSubmitting(true);
    setStatus('');
    try {
      const res = await fetch('/api/alerts/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized, source, company: '' }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(data.message || 'You are on the release list.');
        setEmail('');
      } else {
        setStatus(data.error || 'Unable to save your email right now.');
      }
    } catch {
      setStatus('Unable to save your email right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section style={{ border: `1px solid ${c.cardBorder}`, borderRadius: 24, padding: '18px 16px', background: c.cardBackground || 'linear-gradient(180deg, rgba(18,18,23,0.96), rgba(10,10,12,0.96))', boxShadow: '0 18px 50px rgba(0,0,0,0.24)', color: cardText }}>
      <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: c.accentBlue || '#7dd3fc', marginBottom: 8 }}>Private release list</div>
      <h3 style={{ margin: '0 0 8px', fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', lineHeight: 1.1, color: cardText }}>{headline}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.65, color: cardTextMuted }}>{body}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="Email for release alerts"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: '13px 14px', borderRadius: 999, border: `1px solid ${c.cardBorder}`, background: isLight ? 'rgba(0,0,0,0.05)' : '#09090b', color: cardText, fontSize: 13 }}
        />
        <button
          onClick={subscribe}
          disabled={submitting}
          style={{ padding: '13px 18px', borderRadius: 999, border: 'none', background: c.checkoutCtaButton || '#f3f4f6', color: isLight ? '#ffffff' : '#09090b', fontWeight: 700, fontSize: 13, cursor: submitting ? 'not-allowed' : 'pointer' }}
        >
          {submitting ? 'Saving…' : 'Be first to know'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: status.includes('valid') || status.includes('Unable') ? '#fca5a5' : '#9ae6b4', marginTop: 10, minHeight: 16 }}>
        {status || 'Release notes stay operator-controlled from the admin portal.'}
      </div>
    </section>
  );
}