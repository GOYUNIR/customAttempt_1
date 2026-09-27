'use client';

/**
 * Landing page for a platform support handoff (lib/merchant-support-handoff.ts).
 * The one-time code arrives in the URL fragment, which never reaches a server;
 * it is removed from the address bar at once and exchanged for the session.
 */
import { useEffect, useState } from 'react';

export default function SupportHandoff() {
  const [error, setError] = useState('');
  useEffect(() => {
    const code = window.location.hash.replace(/^#/, '');
    try { window.history.replaceState(null, '', '/app/support'); } catch { /* ignore */ }
    if (!code) { setError('This link is incomplete. Start again from the sales hub.'); return; }
    fetch('/api/merchant-support/redeem', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) window.location.replace(body.next || '/app');
        else setError(body.error || 'This link could not be used.');
      })
      .catch(() => setError('Network error. Try again from the sales hub.'));
  }, []);
  return (
    <main style={{ minHeight: '100vh', background: '#0b0b0d', color: '#ececf0', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <p>{error || 'Opening the store…'}</p>
    </main>
  );
}
