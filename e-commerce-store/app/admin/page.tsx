'use client';

import Link from 'next/link';
import { useState } from 'react';

export default function AdminPortal() {
  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');

  const triggerDrop = async () => {
    setIsRunning(true);
    setResultMessage('Triggering drop...');

    try {
      const response = await fetch('/api/admin/trigger-drop', {
        method: 'POST',
      });
      const data = await response.json();

      if (response.ok) {
        setResultMessage(`Draw triggered successfully. Processed ${data.processedWinners?.length ?? 0} winners.`);
      } else {
        setResultMessage(data.error || 'Failed to trigger draw.');
      }
    } catch (error) {
      setResultMessage('Unable to reach the admin trigger endpoint.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', padding: '48px 24px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', margin: 0 }}>GOYUNIR Admin Portal</h1>
          <p style={{ color: '#a8a8a8', marginTop: '12px' }}>Secure control panel for manual drop activation and admin actions.</p>
        </div>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem' }}>Drop Control</h2>
          <button onClick={triggerDrop} disabled={isRunning} style={{ width: '100%', padding: '16px', borderRadius: '18px', border: 'none', background: '#edb210', color: '#09090b', fontWeight: '700', cursor: 'pointer' }}>
            {isRunning ? 'Triggering draw…' : 'Trigger draw now'}
          </button>
          {resultMessage && <p style={{ marginTop: '16px', color: '#d4d4d8' }}>{resultMessage}</p>}
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem' }}>Notes</h2>
          <ul style={{ color: '#c4c4c4', lineHeight: 1.8 }}>
            <li>Only the `/admin` route and `/api/admin/*` API are protected.</li>
            <li>Use HTTP Basic Auth with `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD`.</li>
            <li>The API also requires `ALLOW_DROP_TRIGGER=true`.</li>
          </ul>
        </section>

        <Link href="/" style={{ color: '#9ca3af', textDecoration: 'underline' }}>Return to storefront</Link>
      </div>
    </main>
  );
}
