'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

export default function AdminPortal() {
  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [status, setStatus] = useState<any>(null);
  
  // Safe high-volume ledger filtering and pagination states
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

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
    const interval = setInterval(fetchStatus, 6000);
    return () => clearInterval(interval);
  }, []);

  const triggerDrop = async () => {
    setIsRunning(true);
    setResultMessage('Triggering draw...');

    try {
      const response = await fetch('/api/admin/trigger-drop', {
        method: 'POST',
      });
      const data = await response.json();

      if (response.ok) {
        setResultMessage(`Draw triggered successfully. Processed ${data.processedWinners?.length ?? 0} winners.`);
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

  // Safe string normalization logic prevents bad inputs from crashing the page view
  const allEntries = status?.fallbackEntries || [];
  const filteredEntries = Array.isArray(allEntries) ? allEntries.filter((entry: any) => {
    if (!entry) return false;
    const safeEmail = String(entry.email || '').toLowerCase();
    const safeVariant = String(entry.variant || entry.product || '').toLowerCase();
    const safeSearch = String(searchTerm || '').toLowerCase();
    return safeEmail.includes(safeSearch) || safeVariant.includes(safeSearch);
  }) : [];

  const totalPages = Math.ceil(filteredEntries.length / itemsPerPage) || 1;
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentEntries = filteredEntries.slice(indexOfFirstItem, indexOfLastItem);
  return (
    <main style={{ minHeight: '100vh', padding: '48px 24px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', margin: 0, fontWeight: '800', letterSpacing: '-0.02em', textTransform: 'uppercase' }}>GOYUNIR Admin Portal</h1>
          <p style={{ color: '#a8a8a8', marginTop: '12px', fontSize: '14px' }}>Secure control panel for manual drop activation and admin actions.</p>
        </div>

        {/* CORE TRANSACTION MATRIX TRIGGER */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Drop Control</h2>
          <button onClick={triggerDrop} disabled={isRunning} style={{ width: '100%', padding: '16px', borderRadius: '18px', border: 'none', background: '#edb210', color: '#09090b', fontWeight: '700', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
            {isRunning ? 'Triggering draw…' : 'Trigger draw now'}
          </button>
          {resultMessage && <p style={{ marginTop: '16px', color: '#cbd5e1', fontSize: '13px', padding: '12px', background: '#09090b', borderRadius: '12px', border: '1px solid #1c1c1e' }}>ℹ️ {resultMessage}</p>}
        </section>

        {/* REQUESTED LIVE DATABASE POOLS (X INT / Y SUB / Z INV METRICS GRID) */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>🧪 Live Database Pools</h2>
          <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px 0' }}>Real-time telemetry showing initiated intents, completed submissions, and inventory depth.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {status?.pools && status.pools.map((p: any, i: number) => {
              const productName = p.product || 'Elysian White';
              const productSize = p.size || '50ml';
              const intCount = p.intCount ?? 0;
              const subCount = p.subCount ?? p.count ?? 0;
              const maxLimit = p.maxLimit ?? (productSize === '50ml' ? 10 : 5);

              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#09090b', padding: '14px 16px', borderRadius: '12px', border: '1px solid #1c1c1e' }}>
                  <div style={{ fontWeight: '600', fontSize: '13px' }}>{productName} <span style={{ color: '#555' }}>— {productSize}</span></div>
                  <div style={{ color: subCount >= maxLimit ? '#f87171' : '#34d399', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '13px' }}>
                    {intCount} INT / {subCount} SUB / {maxLimit} INV
                  </div>
                </div>
              );
            })}
            {(!status?.pools || status.pools.length === 0) && (
              <p style={{ color: '#555', margin: 0, padding: '12px', background: '#09090b', borderRadius: '12px', textAlign: 'center', fontSize: '13px' }}>No active allocation pools detected.</p>
            )}
          </div>
        </section>

        {/* SYSTEM STATUS OVERVIEW WIDGETS */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#07070a', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 16px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>System Status Overview</h2>
          {!status && <p style={{ color: '#9ca3af', fontSize: '13px' }}>Loading platform variables…</p>}
          {status && (
            <div style={{ color: '#cbd5e1', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                <div style={{ background: '#111', padding: '14px', borderRadius: '14px', border: '1px solid #1f1f23' }}>
                  <span style={{ color: '#888', fontSize: '11px', display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>STRIPE INTERFACE</span>
                  <strong style={{ color: status.stripeConfigured ? '#34d399' : '#f87171', fontSize: '14px', fontFamily: 'monospace' }}>
                    {status.stripeConfigured ? '● LINKED (ONLINE)' : '○ KEY ERROR'}
                  </strong>
                </div>
                <div style={{ background: '#111', padding: '14px', borderRadius: '14px', border: '1px solid #1f1f23' }}>
                  <span style={{ color: '#888', fontSize: '11px', display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>REDIS ENGINES</span>
                  <strong style={{ color: status.redisConfigured ? '#34d399' : '#f87171', fontSize: '14px', fontFamily: 'monospace' }}>
                    {status.redisConfigured ? '● DISTRIBUTED' : '○ DISCONNECTED'}
                  </strong>
                </div>
              </div>

              <div>
                <span style={{ color: '#888', display: 'block', marginBottom: '8px', textTransform: 'uppercase', fontSize: '11px', fontWeight: 'bold' }}>Real-Time Draw Processing Matrix</span>
                <div style={{ background: '#09090b', padding: '16px', borderRadius: '16px', border: '1px solid #1c1c1e', fontFamily: 'monospace', fontSize: '12px', color: '#a1a1aa', overflowX: 'auto', maxHeight: '200px' }}>
                  {status.lastDraw ? (
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#34d399' }}>
                      {JSON.stringify(status.lastDraw, null, 2)}
                    </pre>
                  ) : (
                    <span style={{ color: '#444' }}>No transaction draw session executed yet. Waiting for system launch parameters...</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
        {/* REQUESTED SEARCHABLE HIGH-VOLUME CUSTOMER LEDGER */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.25rem', textTransform: 'uppercase' }}>👥 Searchable Customer Ledger</h2>
                <p style={{ color: '#888', fontSize: '12px', margin: '4px 0 0 0' }}>Streaming registrants in memory-safe chunks.</p>
              </div>
              <span style={{ fontSize: '12px', fontFamily: 'monospace', background: '#27272a', padding: '4px 8px', borderRadius: '6px', fontWeight: 'bold' }}>
                FOUND: {filteredEntries.length}
              </span>
            </div>

            <input 
              type="text" 
              placeholder="🔍 Search entries by email or product variant name..." 
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: '13px' }}
            />
          </div>

          {currentEntries.length === 0 ? (
            <p style={{ color: '#555', fontSize: '13px', margin: '10px 0', textAlign: 'center', border: '1px dashed #222', padding: '24px', borderRadius: '14px' }}>
              No client registration tracks match your search keywords.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
              {currentEntries.map((entry: any, index: number) => {
                const displayEmail = typeof entry === 'object' ? String(entry.email || 'Anonymous') : String(entry);
                const displayVariant = typeof entry === 'object' ? String(entry.variant || entry.product || 'Elysian Variant') : 'Elysian Variant';
                const displaySize = typeof entry === 'object' ? String(entry.size || '50ml') : '50ml';
                const displayId = typeof entry === 'object' ? String(entry.id || entry.stripeCustomerId || 'Active Track') : 'Legacy Ref';

                return (
                  <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#09090b', border: '1px solid #1c1c1e', padding: '12px 16px', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: '#fff', fontSize: '13px', fontWeight: '500' }}>{displayEmail}</span>
                      <span style={{ color: '#555', fontSize: '11px', fontFamily: 'monospace' }}>Hash: {displayId}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ color: '#34d399', fontSize: '12px', fontWeight: 'bold', display: 'block' }}>{displayVariant}</span>
                      <span style={{ color: '#888', fontSize: '11px' }}>{displaySize}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #1c1c1e' }}>
              <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => Math.max(p - 1, 1))} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #27272a', background: currentPage === 1 ? 'transparent' : '#1c1c1e', color: currentPage === 1 ? '#444' : '#fff', fontSize: '12px', cursor: 'pointer' }}>
                Previous
              </button>
              <span style={{ fontSize: '12px', color: '#888' }}>
                Page <strong style={{ color: '#fff' }}>{currentPage}</strong> of {totalPages}
              </span>
              <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #27272a', background: currentPage === totalPages ? 'transparent' : '#1c1c1e', color: currentPage === totalPages ? '#444' : '#fff', fontSize: '12px', cursor: 'pointer' }}>
                Next
              </button>
            </div>
          )}
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Notes</h2>
          <ul style={{ color: '#c4c4c4', lineHeight: 1.8, fontSize: '13px', margin: 0, paddingLeft: '20px' }}>
            <li>Only the `/admin` route and `/api/admin/*` API are protected.</li>
            <li>Use HTTP Basic Auth with `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD`.</li>
            <li>The API also requires `ALLOW_DROP_TRIGGER=true`.</li>
          </ul>
        </section>

        <Link href="/" style={{ color: '#9ca3af', textDecoration: 'underline', fontSize: '13px' }}>Return to storefront</Link>
      </div>
    </main>
  );
}
