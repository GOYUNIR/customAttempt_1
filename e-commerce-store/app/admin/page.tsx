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
  const [catalogMessage, setCatalogMessage] = useState('');
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [revealAddresses, setRevealAddresses] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/admin/status?t=${Date.now()}`);
      const data = await res.json();
      setStatus(data);
      setLastUpdatedAt(Date.now());
      setPulseTick((t) => t + 1);
    } catch {
      setStatus({ error: 'Unable to fetch status telemetry matrix parameters' });
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
      alert('🔒 Enter your admin password first.');
      return;
    }
    if (!confirm('🚨 MASTER LAUNCH CORE TRIGGER: Execute card charges for your active lottery rows?')) return;
    setIsRunning(true);
    setResultMessage('Authorizing variables with Vercel deployment parameters...');
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
        setResultMessage('Draw execution completed cleanly. Allocations archived successfully.');
        await fetchStatus();
      } else setResultMessage(data.error || 'Authorization handshake rejected.');
    } catch {
      setResultMessage('Fatal connection failure reaching trigger endpoint path.');
    } finally {
      setIsRunning(false);
    }
  };

  const archiveProduct = async (product: any) => {
    if (!triggerVerificationPassword) {
      alert('🔒 Enter your admin password above first.');
      return;
    }
    if (!confirm(`Archive "${product.name}"? It moves to the Catalog page's archive section.`)) return;
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
          verificationKey: triggerVerificationPassword,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMessage(`${product.name} archived.`);
        setArchivingId(null);
        setAvailableFromInput('');
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Could not archive product.');
    } catch {
      setCatalogMessage('Connection failed.');
    }
  };

  const unarchiveProduct = async (product: any) => {
    if (!triggerVerificationPassword) {
      alert('🔒 Enter your admin password above first.');
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
        setCatalogMessage(`${product.name} restored to active catalog.`);
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Could not restore product.');
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
          <p style={{ color: '#a8a8a8', marginTop: '12px', fontSize: '14px' }}>
            Secure control panel for drop execution and catalog management.
          </p>
        </div>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>Drop &amp; Product Control Center</h2>
          <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px 0' }}>
            Non-winners and expired intents are archived automatically. Re-entry opens automatically once a draw
            completes. This password unlocks both drop execution AND catalog archive controls below.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Target Execution Scope</label>
              <select
                value={selectedDrawTarget}
                onChange={(e) => setSelectedDrawTarget(e.target.value)}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: '13px', cursor: 'pointer' }}
              >
                <option value="ALL_POOLS">🌎 SWEEP ALL PRODUCT CONFIGURATIONS</option>
                {GOYUNIR_STORE_SUITE.productCatalog.flatMap((p) =>
                  ['50ml', '100ml'].map((sz) => (
                    <option key={`${p.name}-${sz}`} value={`drop_pool:${p.name}:${sz}`}>
                      🧪 {p.name} — {sz} Pool
                    </option>
                  )),
                )}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#f87171', textTransform: 'uppercase', fontWeight: 'bold' }}>🔒 Admin Password</label>
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
            style={{ width: '100%', padding: '16px', borderRadius: '18px', border: 'none', background: '#edb210', color: '#09090b', fontWeight: '700', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: '16px' }}
          >
            {isRunning ? 'Triggering draw…' : '🚨 Authorize & Trigger Draw Drop Now'}
          </button>
          {resultMessage && (
            <p style={{ margin: '0 0 16px 0', color: '#cbd5e1', fontSize: '13px', padding: '12px', background: '#09090b', borderRadius: '12px', border: '1px solid #1c1c1e' }}>
              ℹ️ {resultMessage}
            </p>
          )}

          <div style={{ borderTop: '1px solid #27272a', paddingTop: '16px' }}>
            <h3 style={{ margin: '0 0 4px 0', fontSize: '14px', textTransform: 'uppercase', color: '#f59e0b' }}>🗂️ Catalog Archive</h3>
            <p style={{ color: '#888', fontSize: '11px', margin: '0 0 12px 0' }}>
              Archive a product&apos;s run early, or restore it back to active. Cover uses frame 1 image automatically.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {GOYUNIR_STORE_SUITE.productCatalog.map((product) => {
                const isArchived = archivedIds.includes(product.id);
                return (
                  <div key={product.id} style={{ background: '#09090b', padding: '14px 16px', borderRadius: '12px', border: '1px solid #1c1c1e' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: '600', fontSize: '13px' }}>
                        {product.name} {isArchived && <span style={{ color: '#94a3b8', fontSize: '10px' }}>(ARCHIVED)</span>}
                      </div>
                      {isArchived ? (
                        <button
                          onClick={() => unarchiveProduct(product)}
                          style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid #34d399', background: 'transparent', color: '#34d399', fontSize: '11px', cursor: 'pointer' }}
                        >
                          Restore to Active
                        </button>
                      ) : (
                        <button
                          onClick={() => setArchivingId(archivingId === product.id ? null : product.id)}
                          style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', fontSize: '11px', cursor: 'pointer' }}
                        >
                          {archivingId === product.id ? 'Cancel' : 'Archive This Product'}
                        </button>
                      )}
                    </div>
                    {archivingId === product.id && (
                      <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
                        <input
                          type="text"
                          placeholder="Available from (e.g. Jan 2026)"
                          value={availableFromInput}
                          onChange={(e) => setAvailableFromInput(e.target.value)}
                          style={{ flex: 1, padding: '10px', borderRadius: '8px', background: '#000', border: '1px solid #27272a', color: '#fff', fontSize: '12px' }}
                        />
                        <button
                          onClick={() => archiveProduct(product)}
                          style={{ padding: '10px 14px', borderRadius: '8px', border: 'none', background: '#f59e0b', color: '#000', fontWeight: 'bold', fontSize: '11px', cursor: 'pointer' }}
                        >
                          Confirm
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {catalogMessage && <p style={{ marginTop: '12px', fontSize: '12px', color: '#cbd5e1' }}>{catalogMessage}</p>}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', textTransform: 'uppercase' }}>🧪 Live Database Pools</h2>
          <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px 0' }}>
            Current open-drop status. Resets after each draw — full history always lives in the ledger below.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {status?.pools &&
              status.pools.map((p: any, i: number) => {
                const intCount = p.intCount ?? 0,
                  subCount = p.subCount ?? 0,
                  maxLimit = p.maxLimit ?? 10;
                return (
                  <div key={i} style={{ background: '#09090b', padding: '14px 16px', borderRadius: '12px', border: '1px solid #1c1c1e', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: '600', fontSize: '13px' }}>
                        {p.product} <span style={{ color: '#555' }}>— {p.size}</span>
                      </div>
                      <div style={{ color: subCount >= maxLimit ? '#f87171' : '#34d399', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '13px' }}>
                        {intCount} INT / {subCount} SUB / {maxLimit} INV
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#07070a', border: '1px solid #27272a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', textTransform: 'uppercase' }}>Real-Time Draw Processing Matrix</h2>
            <button
              onClick={() => setRevealAddresses((v) => !v)}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #27272a',
                background: revealAddresses ? '#1c1c1e' : 'transparent',
                color: revealAddresses ? '#34d399' : '#888',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              {revealAddresses ? '🔒 Hide addresses' : '👁 Reveal addresses'}
            </button>
          </div>
          <div style={{ background: '#09090b', padding: '16px', borderRadius: '16px', border: '1px solid #1c1c1e', fontSize: '12px', color: '#a1a1aa', maxHeight: '280px', overflowY: 'auto' }}>
            {status?.lastDraw ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ color: '#888', fontSize: '11px', marginBottom: '4px' }}>
                  {status.lastDraw.executionTime} · {status.lastDraw.totalSuccessfulCharges ?? 0} charged
                </div>
                {(status.lastDraw.processedWinners || []).length === 0 && (
                  <p style={{ margin: 0, color: '#555' }}>No winners in last draw summary.</p>
                )}
                {(status.lastDraw.processedWinners || []).map((w: any, i: number) => (
                  <div key={i} style={{ background: '#050507', padding: '10px 12px', borderRadius: '8px', border: '1px solid #141416' }}>
                    <div style={{ color: '#fff' }}>{w.email}</div>
                    <div style={{ color: '#34d399', fontSize: '11px' }}>
                      {w.product || w.scent} — {w.size} · {w.status}
                    </div>
                    <div style={{ color: '#888', fontSize: '11px', marginTop: '4px' }}>
                      📍 {revealAddresses ? (w.shippingAddress || 'n/a') : '•••• •••• (hidden)'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#34d399' }}>No draw has been executed yet.</pre>
            )}
          </div>
        </section>

        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
            <motion.div
              key={pulseTick}
              initial={{ scale: 1.8, opacity: 0.3 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5 }}
              style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34d399', marginRight: '8px' }}
            />
            <h2 style={{ margin: 0, fontSize: '1.25rem', textTransform: 'uppercase' }}>Activity &amp; Ledger</h2>
          </div>
          <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px 0' }}>
            {lastUpdatedAt ? `Live • updated ${secondsAgo}s ago` : 'Loading…'}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '20px' }}>
            <div style={{ background: '#09090b', padding: '14px', borderRadius: '14px', border: '1px solid #1f1f23' }}>
              <span style={{ color: '#edb210', fontSize: '11px', display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>👥 CURRENTLY ONLINE</span>
              <strong style={{ color: '#fff', fontSize: '18px', fontFamily: 'monospace' }}>{status?.liveActiveUsersOnline ?? 1}</strong>
            </div>
            <div style={{ background: '#09090b', padding: '14px', borderRadius: '14px', border: '1px solid #1f1f23' }}>
              <span style={{ color: '#888', fontSize: '11px', display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>STRIPE</span>
              <strong style={{ color: '#34d399', fontSize: '13px', fontFamily: 'monospace' }}>● LINKED</strong>
            </div>
            <div style={{ background: '#09090b', padding: '14px', borderRadius: '14px', border: '1px solid #1f1f23' }}>
              <span style={{ color: '#888', fontSize: '11px', display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>REDIS</span>
              <strong style={{ color: '#34d399', fontSize: '13px', fontFamily: 'monospace' }}>● DISTRIBUTED</strong>
            </div>
          </div>

          <details style={{ marginBottom: '20px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '11px', color: '#888', textTransform: 'uppercase', fontWeight: 'bold' }}>
              View up to 50 most recent visitor sessions
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto', marginTop: '10px' }}>
              {(status?.onlineVisitors || []).length === 0 && <p style={{ fontSize: '12px', color: '#555' }}>No active visitors right now.</p>}
              {(status?.onlineVisitors || []).map((v: any) => (
                <div key={v.visitorId} style={{ display: 'flex', justifyContent: 'space-between', background: '#09090b', padding: '8px 12px', borderRadius: '8px', border: '1px solid #1c1c1e', fontSize: '11px' }}>
                  <span style={{ color: '#aaa', fontFamily: 'monospace' }}>{v.visitorId}</span>
                  <span style={{ color: v.lastSeenSecondsAgo < 15 ? '#34d399' : '#888' }}>{v.lastSeenSecondsAgo}s ago</span>
                </div>
              ))}
            </div>
          </details>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase' }}>👥 Searchable Customer Ledger</h3>
            <span style={{ fontSize: '12px', fontFamily: 'monospace', background: '#27272a', padding: '4px 8px', borderRadius: '6px', fontWeight: 'bold' }}>
              {isSearching ? 'SEARCHING…' : `FOUND: ${filteredEntries.length}`}
            </span>
          </div>
          <input
            type="text"
            placeholder="🔍 Search ALL-TIME entries by email, variant, or address..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', background: '#09090b', border: '1px solid #27272a', color: '#fff', fontSize: '13px', marginBottom: '16px' }}
          />

          {currentEntries.length === 0 ? (
            <p style={{ color: '#555', fontSize: '13px', margin: '10px 0', textAlign: 'center', border: '1px dashed #222', padding: '24px', borderRadius: '14px' }}>
              No client registration tracks match your search keywords.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
              {currentEntries.map((entry: any, index: number) => {
                const displayType = String(entry?.type || 'SUBMISSION');
                const typeColor =
                  displayType === 'WINNER_CHARGED'
                    ? '#34d399'
                    : displayType === 'NOT_SELECTED'
                      ? '#888'
                      : displayType === 'WINNER_DECLINED'
                        ? '#f87171'
                        : displayType === 'INTENT_EXPIRED'
                          ? '#666'
                          : displayType === 'INTENT_STARTED'
                            ? '#edb210'
                            : displayType === 'DUPLICATE_BLOCKED'
                              ? '#fb923c'
                              : displayType === 'CANCELLED_BY_USER'
                                ? '#94a3b8'
                                : '#34d399';
                const logTime = entry?.registeredAt
                  ? new Date(entry.registeredAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : 'Pending';
                return (
                  <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: '#09090b', border: '1px solid #1c1c1e', padding: '16px', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ color: '#fff', fontSize: '13px', fontWeight: '500' }}>{String(entry?.email || 'Anonymous Client')}</span>
                        <span style={{ color: '#555', fontSize: '11px', fontFamily: 'monospace' }}>Hash: {String(entry?.id || 'n/a')}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ color: '#34d399', fontSize: '12px', fontWeight: 'bold', display: 'block' }}>{String(entry?.variant || 'Elysian Variant')}</span>
                        <span style={{ color: '#888', fontSize: '11px' }}>{String(entry?.size || '50ml')} — {logTime}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#050507', padding: '8px 12px', borderRadius: '8px', border: '1px solid #141416', fontSize: '11px' }}>
                      <span style={{ color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
                        📍 <span style={{ color: '#aaa' }}>{revealAddresses ? String(entry?.shippingAddress || 'Form Input Field Entry') : '•••• •••• (hidden)'}</span>
                      </span>
                      <span style={{ padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace', fontWeight: 'bold', background: `${typeColor}1a`, color: typeColor }}>
                        {displayType}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #1c1c1e' }}>
              <button disabled={currentPage === 1} onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #27272a', background: currentPage === 1 ? 'transparent' : '#1c1c1e', color: currentPage === 1 ? '#444' : '#fff', fontSize: '12px', cursor: 'pointer' }}>
                Previous
              </button>
              <span style={{ fontSize: '12px', color: '#888' }}>
                Page <strong style={{ color: '#fff' }}>{currentPage}</strong> of {totalPages}
              </span>
              <button disabled={currentPage === totalPages} onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #27272a', background: currentPage === totalPages ? 'transparent' : '#1c1c1e', color: currentPage === totalPages ? '#444' : '#fff', fontSize: '12px', cursor: 'pointer' }}>
                Next
              </button>
            </div>
          )}
        </section>

        <Link href="/" style={{ color: '#9ca3af', textDecoration: 'underline', fontSize: '13px' }}>
          Return to storefront
        </Link>
      </div>
    </main>
  );
}