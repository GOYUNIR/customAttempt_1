'use client';

import { useState } from 'react';

export default function ReleaseWaitlist({
  source,
  headline,
  body,
}: {
  source: 'home' | 'catalog';
  headline: string;
  body: string;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    <section style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 24, padding: '18px 16px', background: 'linear-gradient(180deg, rgba(18,18,23,0.96), rgba(10,10,12,0.96))', boxShadow: '0 18px 50px rgba(0,0,0,0.24)', color: '#ffffff' }}>
      <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: '#7dd3fc', marginBottom: 8 }}>Private release list</div>
      <h3 style={{ margin: '0 0 8px', fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', lineHeight: 1.1, color: '#ffffff' }}>{headline}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.65, color: '#c8c8cf' }}>{body}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="Email for release alerts"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: '13px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)', background: '#09090b', color: '#fff', fontSize: 13 }}
        />
        <button
          onClick={subscribe}
          disabled={submitting}
          style={{ padding: '13px 18px', borderRadius: 999, border: 'none', background: '#f3f4f6', color: '#09090b', fontWeight: 700, fontSize: 13, cursor: submitting ? 'not-allowed' : 'pointer' }}
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