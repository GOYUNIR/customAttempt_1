'use client';
import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function AdminPortal() {
  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedDrawTarget, setSelectedDrawTarget] = useState('ALL_POOLS');
  const [triggerVerificationPassword, setTriggerVerificationPassword] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [pulseTick, setPulseTick] = useState(0);
  const [secondsAgo, setSecondsAgo] = useState(0);

  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [availableFromInput, setAvailableFromInput] = useState('');
  const [archiveNotes, setArchiveNotes] = useState('');
  const [catalogMessage, setCatalogMessage] = useState('');
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [revealAddresses, setRevealAddresses] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/admin/status?t=${Date.now()}`);
      const data = await res.json();
      setStatus(data);
      setLastUpdatedAt(Date.now());
      setPulseTick((t) => t + 1);
    } catch {
      setStatus({ error: 'Unable to fetch status' });
    }
  };

  const fetchCatalogStatus = async () => {
    try {
      const res = await fetch('/api/catalog/status');
      const data = await res.json();
      if (Array.isArray(data.archivedProductIds)) setArchivedIds(data.archivedProductIds);
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    fetchCatalogStatus();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(fetchStatus, 10000);
    };
    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus();
        startPolling();
      } else stopPolling();
    };
    startPolling();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      if (lastUpdatedAt) setSecondsAgo(Math.round((Date.now() - lastUpdatedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdatedAt]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const term = searchTerm.trim();
    if (!term) {
      setSearchResults(null);
      setCurrentPage(1);
      return;
    }
    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/search?q=${encodeURIComponent(term)}`);
        const data = await res.json();
        setSearchResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
        setCurrentPage(1);
      }
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchTerm]);

  const triggerDrop = async () => {
    if (!triggerVerificationPassword) {
      alert('Enter your admin password first.');
      return;
    }
    if (!confirm('Execute draw and charge winners?')) return;
    setIsRunning(true);
    setResultMessage('Running draw…');
    try {
      const response = await fetch('/api/admin/trigger-drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetPool: selectedDrawTarget,
          verificationKey: triggerVerificationPassword,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setResultMessage('Draw completed.');
        await fetchStatus();
      } else setResultMessage(data.error || 'Draw failed.');
    } catch {
      setResultMessage('Connection failed.');
    } finally {
      setIsRunning(false);
    }
  };

  const toggleRevealAddresses = async () => {
    if (revealAddresses) {
      setRevealAddresses(false);
      return;
    }
    if (!triggerVerificationPassword) {
      alert('Enter admin password in Drop & Product Control Center first.');
      return;
    }
    setRevealBusy(true);
    try {
      const res = await fetch('/api/admin/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: triggerVerificationPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || 'Invalid password.');
        return;
      }
      setRevealAddresses(true);
    } catch {
      alert('Could not verify password.');
    } finally {
      setRevealBusy(false);
    }
  };

  const archiveProduct = async (product: any) => {
    if (!triggerVerificationPassword) {
      alert('Enter admin password first.');
      return;
    }
    if (!confirm(`Archive "${product.name}"?`)) return;
    try {
      const res = await fetch('/api/admin/catalog-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive',
          productId: product.id,
          name: product.name,
          description: product.desc,
          image: `/images/${product.prefix}_1.jpg`,
          availableFrom: availableFromInput || 'Unknown',
          notes: archiveNotes || '',
          verificationKey: triggerVerificationPassword,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMessage(`${product.name} archived.`);
        setArchivingId(null);
        setAvailableFromInput('');
        setArchiveNotes('');
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Could not archive.');
    } catch {
      setCatalogMessage('Connection failed.');
    }
  };

  const unarchiveProduct = async (product: any) => {
    if (!triggerVerificationPassword) {
      alert('Enter admin password first.');
      return;
    }
    try {
      const res = await fetch('/api/admin/catalog-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'unarchive',
          productId: product.id,
          verificationKey: triggerVerificationPassword,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMessage(`${product.name} restored.`);
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Could not restore.');
    } catch {
      setCatalogMessage('Connection failed.');
    }
  };

  const allEntries = searchResults !== null ? searchResults : status?.fallbackEntries || [];
  const filteredEntries = Array.isArray(allEntries) ? allEntries : [];
  const totalPages = Math.ceil(filteredEntries.length / itemsPerPage) || 1;
  const currentEntries = filteredEntries.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  return (
    <main style={{ minHeight: '100vh', padding: '48px 24px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', margin: 0, fontWeight: '800', letterSpacing: '-0.03em', textTransform: 'uppercase' }}>
            GOYUNIR Admin Portal
          </h1>
          <p style={{ color: '#a8a8a8', marginTop: '12px', fontSize: '14px' }}>Drop execution, inventory, and ledger.</p>
        </div>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Drop &amp; Product Control Center</h2>
          <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px 0' }}>
            Password unlocks draw, archive, and address reveal.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Target</label>
              <select
                value={selectedDrawTarget}
                onChange={(e) => setSelectedDrawTarget(e.target.value)}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: '13px' }}
              >
                <option value="ALL_POOLS">ALL POOLS</option>
                {GOYUNIR_STORE_SUITE.productCatalog.flatMap((p) =>
                  ['50ml', '100ml'].map((sz) => (
                    <option key={`${p.name}-${sz}`} value={`drop_pool:${p.name}:${sz}`}>
                      {p.name} — {sz}
                    </option>
                  )),
                )}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#f87171', textTransform: 'uppercase', fontWeight: 'bold' }}>Admin Password</label>
              <input
                type="password"
                placeholder="Verify master key..."
                value={triggerVerificationPassword}
                onChange={(e) => setTriggerVerificationPassword(e.target.value)}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: '13px' }}
              />
            </div>
          </div>

          <button
            onClick={triggerDrop}
            disabled={isRunning}
            style={{ width: '100%', padding: '16px', borderRadius: '18px', border: 'none', background: '#edb210', color: '#09090b', fontWeight: '700', cursor: 'pointer', marginBottom: '12px' }}
          >
            {isRunning ? 'Triggering…' : 'Authorize & Trigger Draw'}
          </button>

          <button
            onClick={toggleRevealAddresses}
            disabled={revealBusy}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: '12px',
              border: '1px solid #27272a',
              background: revealAddresses ? '#1c1c1e' : 'transparent',
              color: revealAddresses ? '#34d399' : '#ccc',
              fontSize: '12px',
              cursor: 'pointer',
              marginBottom: '16px',
            }}
          >
            {revealBusy ? 'Verifying…' : revealAddresses ? '🔒 Hide addresses' : '👁 Reveal addresses (password required)'}
          </button>

          {resultMessage && (
            <p style={{ margin: '0 0 16px 0', color: '#cbd5e1', fontSize: '13px', padding: '12px', background: '#09090b', borderRadius: '12px' }}>
              {resultMessage}
            </p>
          )}

          <div style={{ borderTop: '1px solid #27272a', paddingTop: '16px' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#f59e0b' }}>Catalog Archive</h3>
            {GOYUNIR_STORE_SUITE.productCatalog.map((product) => {
              const isArchived = archivedIds.includes(product.id);
              return (
                <div key={product.id} style={{ background: '#09090b', padding: '14px 16px', borderRadius: '12px', border: '1px solid #1c1c1e', marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {product.name} {isArchived && <span style={{ color: '#94a3b8', fontSize: 10 }}>(ARCHIVED)</span>}
                    </div>
                    {isArchived ? (
                      <button onClick={() => unarchiveProduct(product)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #34d399', background: 'transparent', color: '#34d399', fontSize: 11, cursor: 'pointer' }}>
                        Restore
                      </button>
                    ) : (
                      <button onClick={() => setArchivingId(archivingId === product.id ? null : product.id)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', fontSize: 11, cursor: 'pointer' }}>
                        {archivingId === product.id ? 'Cancel' : 'Archive'}
                      </button>
                    )}
                  </div>
                  {archivingId === product.id && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input placeholder="Available from" value={availableFromInput} onChange={(e) => setAvailableFromInput(e.target.value)} style={{ padding: 10, borderRadius: 8, background: '#000', border: '1px solid #27272a', color: '#fff', fontSize: 12 }} />
                      <input placeholder="Archive notes (shown on product page)" value={archiveNotes} onChange={(e) => setArchiveNotes(e.target.value)} style={{ padding: 10, borderRadius: 8, background: '#000', border: '1px solid #27272a', color: '#fff', fontSize: 12 }} />
                      <button onClick={() => archiveProduct(product)} style={{ padding: 10, borderRadius: 8, border: 'none', background: '#f59e0b', color: '#000', fontWeight: 'bold', fontSize: 11, cursor: 'pointer' }}>
                        Confirm archive
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {catalogMessage && <p style={{ marginTop: 12, fontSize: 12, color: '#cbd5e1' }}>{catalogMessage}</p>}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 16px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Live Database Pools</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(status?.pools || []).map((p: any, i: number) => (
              <div key={i} style={{ background: '#09090b', padding: '14px 16px', borderRadius: 12, border: '1px solid #1c1c1e' }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  {p.product} — {p.size}
                  <div style={{ fontSize: 10, color: '#666', fontWeight: 400 }}>{p.productId}</div>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold' }}>
                  <span style={{ color: '#edb210' }}>{p.intCount ?? 0} INT</span>
                  {' / '}
                  <span style={{ color: '#34d399' }}>{p.subCount ?? 0} SUB</span>
                  {' / '}
                  <span style={{ color: '#60a5fa' }}>{p.salesCount ?? 0} SLS</span>
                  {' / '}
                  <span style={{ color: (p.maxLimit ?? 0) <= 0 ? '#f87171' : '#fff' }}>{p.maxLimit ?? 0} INV</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#07070a', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 12px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Real-Time Draw Processing Matrix</h2>
          <div style={{ background: '#09090b', padding: 16, borderRadius: 16, border: '1px solid #1c1c1e', fontSize: 12, maxHeight: 280, overflowY: 'auto' }}>
            {status?.lastDraw ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ color: '#888', fontSize: 11 }}>
                  {status.lastDraw.executionTime} · {status.lastDraw.totalSuccessfulCharges ?? 0} charged
                </div>
                {(status.lastDraw.processedWinners || []).map((w: any, i: number) => (
                  <div key={i} style={{ background: '#050507', padding: '10px 12px', borderRadius: 8 }}>
                    <div style={{ color: '#fff' }}>{w.email}</div>
                    <div style={{ color: '#34d399', fontSize: 11 }}>
                      {w.product || w.scent} — {w.size} · {w.status}
                    </div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
                      📍 {revealAddresses ? w.shippingAddress || 'n/a' : '•••• (hidden)'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, color: '#555' }}>No draw executed yet.</p>
            )}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <motion.div
              key={pulseTick}
              initial={{ scale: 1.8, opacity: 0.3 }}
              animate={{ scale: 1, opacity: 1 }}
              style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399', marginRight: 8 }}
            />
            <h2 style={{ margin: 0, fontSize: '1.25rem', textTransform: 'uppercase' }}>Activity &amp; Ledger</h2>
          </div>
          <p style={{ color: '#888', fontSize: 12, margin: '0 0 16px 0' }}>
            {lastUpdatedAt ? `Live • updated ${secondsAgo}s ago` : 'Loading…'} · Stripe {status?.stripeConfigured ? '● LINKED' : '○'} · Redis{' '}
            {status?.redisConfigured ? '● DISTRIBUTED' : '○'}
          </p>

          <input
            placeholder="Search email / address / product…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: 12, borderRadius: 10, background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
          />
          {isSearching && <p style={{ fontSize: 11, color: '#666' }}>Searching…</p>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
            {currentEntries.map((e: any, i: number) => (
              <div key={i} style={{ background: '#09090b', padding: 12, borderRadius: 10, border: '1px solid #1c1c1e', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{e.email}</div>
                <div style={{ color: '#888' }}>
                  {e.variant} · {e.size} · <span style={{ color: '#edb210' }}>{e.type}</span>
                </div>
                <div style={{ color: '#666', marginTop: 4 }}>
                  📍 {revealAddresses ? e.shippingAddress || 'n/a' : '••••'}
                </div>
              </div>
            ))}
            {currentEntries.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No ledger rows yet.</p>}
          </div>
          {totalPages > 1 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)} style={{ padding: '8px 12px', cursor: 'pointer' }}>
                Prev
              </button>
              <span style={{ fontSize: 12, color: '#888' }}>
                {currentPage}/{totalPages}
              </span>
              <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => p + 1)} style={{ padding: '8px 12px', cursor: 'pointer' }}>
                Next
              </button>
            </div>
          )}
        </section>

        <Link href="/" style={{ color: '#888', fontSize: 12 }}>
          ← Storefront
        </Link>
      </div>
    </main>
  );
}