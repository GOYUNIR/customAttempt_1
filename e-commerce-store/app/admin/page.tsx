'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useEffect } from 'react';

export default function AdminPortal() {
  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [status, setStatus] = useState<any>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/admin/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ error: 'Unable to fetch status' });
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

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
        // refresh status to reflect potential changes
        await fetchStatus();
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

        <section style={{ padding: '24px', borderRadius: '24px', background: '#07070a', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem' }}>System Status</h2>
          {!status && <p style={{ color: '#9ca3af' }}>Loading status…</p>}
          {status && (
            <div style={{ color: '#cbd5e1', fontSize: '13px' }}>
              <p>Stripe configured: <strong style={{ color: status.stripeConfigured ? '#34d399' : '#f87171' }}>{String(status.stripeConfigured)}</strong></p>
              <p>Redis configured: <strong style={{ color: status.redisConfigured ? '#34d399' : '#f87171' }}>{String(status.redisConfigured)}</strong></p>
              <p>Fallback entries: <strong>{status.fallbackEntriesCount}</strong></p>
              <div style={{ marginTop: '8px' }}>
                <h4 style={{ margin: '8px 0' }}>Pools</h4>
                <div style={{ maxHeight: '160px', overflow: 'auto', background: '#0b0b0d', padding: '8px', borderRadius: '8px' }}>
                  {status.pools && status.pools.map((p: any, i: number) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #0f172a' }}>
                      <div style={{ color: '#9ca3af' }}>{p.product} — {p.size}</div>
                      <div style={{ color: '#e2e8f0' }}>{p.count ?? '—'}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: '12px' }}>
                <h4 style={{ margin: '8px 0' }}>Last draw results</h4>
                {!status.lastDraw && <div style={{ color: '#9ca3af' }}>No draws recorded yet.</div>}
                {status.lastDraw && status.lastDraw.length === 0 && <div style={{ color: '#9ca3af' }}>Last draw ran but processed zero winners.</div>}
                {status.lastDraw && status.lastDraw.length > 0 && (
                  <div style={{ maxHeight: '240px', overflow: 'auto', background: '#0b0b0d', padding: '8px', borderRadius: '8px' }}>
                    {status.lastDraw.map((r: any, idx: number) => (
                      <div key={idx} style={{ padding: '8px', borderBottom: '1px solid #0f172a' }}>
                        <div style={{ color: '#cbd5e1' }}><strong>{r.email}</strong> — {r.scent} {r.size}</div>
                        <div style={{ color: '#9ca3af', fontSize: '12px' }}>{r.status} — {r.message}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <Link href="/" style={{ color: '#9ca3af', textDecoration: 'underline' }}>Return to storefront</Link>
      </div>
    </main>
  );
}
