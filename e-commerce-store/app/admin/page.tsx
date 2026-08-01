'use client';
import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

type Tab =
  | 'overview'
  | 'ops'
  | 'fulfillment'
  | 'growth'
  | 'support'
  | 'ledger';

const SHIP_STATUSES = ['PENDING_FULFILLMENT', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'] as const;

function typeColor(type: string | undefined) {
  if (!type) return '#a1a1aa';
  if (type === 'ENTERED' || type === 'WINNER_CHARGED') return '#34d399';
  if (type === 'INTENT_STARTED') return '#edb210';
  if (type === 'NOT_SELECTED' || type === 'INTENT_EXPIRED') return '#888888';
  if (type === 'WINNER_DECLINED' || type === 'ADDRESS_UPDATED') return '#60a5fa';
  if (type?.includes('CANCEL')) return '#f87171';
  return '#a1a1aa';
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max <= 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div style={{ height: 8, borderRadius: 6, background: '#1c1c1e', overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  );
}

export default function AdminPortal() {
  const [tab, setTab] = useState<Tab>('overview');
  const [opsSub, setOpsSub] = useState<'draw' | 'inventory' | 'catalog'>('draw');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [pulseTick, setPulseTick] = useState(0);
  const [revealAddresses, setRevealAddresses] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [selectedDrawTarget, setSelectedDrawTarget] = useState('ALL_POOLS');

  const [invEdits, setInvEdits] = useState<Record<string, string>>({});
  const [invMessage, setInvMessage] = useState('');
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [availableFromInput, setAvailableFromInput] = useState('');
  const [archiveNotes, setArchiveNotes] = useState('');
  const [catalogMessage, setCatalogMessage] = useState('');
  const [archivedIds, setArchivedIds] = useState<string[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 40;
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [supportEmail, setSupportEmail] = useState('');
  const [supportRows, setSupportRows] = useState<any[]>([]);
  const [supportMsg, setSupportMsg] = useState('');
  const [shipMsg, setShipMsg] = useState('');

  const [recovery, setRecovery] = useState({
    enabled: true,
    earlyDelayHours: 3,
    preDrawHours: 24,
    preDrawEnabled: true,
  });
  const [recoveryMsg, setRecoveryMsg] = useState('');

  const [promos, setPromos] = useState<any[]>([]);
  const [promoForm, setPromoForm] = useState({
    code: '',
    promoterName: '',
    promoterEmail: '',
    customerDiscountPercent: '0',
    promoterPayoutPercent: '10',
  });
  const [promoMsg, setPromoMsg] = useState('');
  const [audit, setAudit] = useState<any[]>([]);

  const card: React.CSSProperties = {
    padding: 20,
    borderRadius: 16,
    background: '#111',
    border: '1px solid #27272a',
  };

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

  const fetchRecovery = async () => {
    try {
      const res = await fetch('/api/admin/recovery-config');
      const data = await res.json();
      setRecovery({
        enabled: data.enabled !== false,
        earlyDelayHours: data.earlyDelayHours ?? 3,
        preDrawHours: data.preDrawHours ?? 24,
        preDrawEnabled: data.preDrawEnabled !== false,
      });
    } catch {}
  };

  const fetchPromos = async () => {
    try {
      const res = await fetch('/api/admin/promos');
      const data = await res.json();
      setPromos(Array.isArray(data.promos) ? data.promos : []);
    } catch {}
  };

  const fetchAudit = async () => {
    if (!password) return;
    try {
      const res = await fetch(`/api/admin/audit?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setAudit(Array.isArray(data.entries) ? data.entries : []);
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    fetchCatalogStatus();
    fetchRecovery();
    fetchPromos();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!pollTimer) pollTimer = setInterval(fetchStatus, 30000);
    };
    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const vis = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus();
        start();
      } else stop();
    };
    start();
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (lastUpdatedAt) setSecondsAgo(Math.round((Date.now() - lastUpdatedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
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

  const toggleReveal = async () => {
    if (revealAddresses) {
      setRevealAddresses(false);
      return;
    }
    if (!password) return alert('Enter password');
    setRevealBusy(true);
    try {
      const res = await fetch('/api/admin/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) return alert(data.error || 'Invalid password');
      setRevealAddresses(true);
    } catch {
      alert('Verify failed');
    } finally {
      setRevealBusy(false);
    }
  };

  const triggerDrop = async () => {
    if (!password) return alert('Enter password');
    if (!confirm('Run draw and charge winners?')) return;
    setIsRunning(true);
    setResultMessage('Running…');
    try {
      const res = await fetch('/api/admin/trigger-drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPool: selectedDrawTarget, verificationKey: password }),
      });
      const data = await res.json();
      if (res.ok) {
        setResultMessage(`Done. Charged ${data.drawSummary?.totalSuccessfulCharges ?? 0}.`);
        await fetchStatus();
      } else setResultMessage(data.error || 'Failed');
    } catch {
      setResultMessage('Connection failed');
    } finally {
      setIsRunning(false);
    }
  };

  const saveInventory = async (productName: string, size: string, productId: string) => {
    if (!password) return alert('Enter password');
    const key = `${productName}:${size}`;
    const value = Number(invEdits[key]);
    if (!Number.isFinite(value) || value < 0) return alert('Invalid number');
    try {
      const res = await fetch('/api/admin/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, productName, size, productId, inventoryRemaining: value }),
      });
      const data = await res.json();
      if (res.ok) {
        setInvMessage(`Saved ${productName} ${size} → ${value}`);
        await fetchStatus();
      } else setInvMessage(data.error || 'Failed');
    } catch {
      setInvMessage('Connection failed');
    }
  };

  const archiveProduct = async (product: any) => {
    if (!password) return alert('Enter password');
    if (!confirm(`Archive ${product.name}?`)) return;
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
          verificationKey: password,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMessage(`${product.name} archived`);
        setArchivingId(null);
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Failed');
    } catch {
      setCatalogMessage('Connection failed');
    }
  };

  const unarchiveProduct = async (product: any) => {
    if (!password) return alert('Enter password');
    try {
      const res = await fetch('/api/admin/catalog-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unarchive', productId: product.id, verificationKey: password }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMessage(`${product.name} restored`);
        await fetchCatalogStatus();
      } else setCatalogMessage(data.error || 'Failed');
    } catch {
      setCatalogMessage('Connection failed');
    }
  };

  const updateShipping = async (row: any, shippingStatus: string) => {
    if (!password) return alert('Enter password');
    setShipMsg('Updating…');
    try {
      const res = await fetch('/api/admin/shipping-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          email: row.email,
          variant: row.variant,
          size: row.size,
          shippingStatus,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShipMsg(`Updated ${data.updated || 0} → ${shippingStatus}`);
        await fetchStatus();
      } else setShipMsg(data.error || 'Failed');
    } catch {
      setShipMsg('Failed');
    }
  };

  const runSupportLookup = async () => {
    const q = supportEmail.trim();
    if (!q) return;
    setSupportMsg('Searching…');
    try {
      const res = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      setSupportRows(rows);
      setSupportMsg(`${rows.length} result(s)`);
    } catch {
      setSupportMsg('Failed');
      setSupportRows([]);
    }
  };

  const saveRecovery = async () => {
    if (!password) return alert('Enter password');
    try {
      const res = await fetch('/api/admin/recovery-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, ...recovery }),
      });
      const data = await res.json();
      if (res.ok) setRecoveryMsg('Recovery settings saved');
      else setRecoveryMsg(data.error || 'Failed');
    } catch {
      setRecoveryMsg('Failed');
    }
  };

  const savePromo = async () => {
    if (!password) return alert('Enter password');
    try {
      const res = await fetch('/api/admin/promos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          action: 'upsert',
          code: promoForm.code,
          promoterName: promoForm.promoterName,
          promoterEmail: promoForm.promoterEmail,
          customerDiscountPercent: Number(promoForm.customerDiscountPercent),
          promoterPayoutPercent: Number(promoForm.promoterPayoutPercent),
          active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPromoMsg(`Saved ${data.promo?.code}`);
        setPromoForm({
          code: '',
          promoterName: '',
          promoterEmail: '',
          customerDiscountPercent: '0',
          promoterPayoutPercent: '10',
        });
        await fetchPromos();
      } else setPromoMsg(data.error || 'Failed');
    } catch {
      setPromoMsg('Failed');
    }
  };

  const deletePromo = async (code: string) => {
    if (!password) return alert('Enter password');
    if (!confirm(`Delete ${code}?`)) return;
    await fetch('/api/admin/promos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, action: 'delete', code }),
    });
    await fetchPromos();
  };

  const pools = status?.pools || [];
  const totalInt = pools.reduce((s: number, p: any) => s + (p.intCount || 0), 0);
  const totalSub = pools.reduce((s: number, p: any) => s + (p.subCount || 0), 0);
  const totalSales = pools.reduce((s: number, p: any) => s + (p.salesCount || 0), 0);
  const totalInv = pools.reduce((s: number, p: any) => s + (p.maxLimit || 0), 0);
  const maxBar = Math.max(totalInt, totalSub, totalSales, totalInv, 1);
  const maxSubPool = Math.max(...pools.map((x: any) => x.subCount || 0), 1);
  const conv = totalInt + totalSub > 0 ? Math.round((totalSub / (totalInt + totalSub)) * 100) : 0;

  const allEntries = searchResults !== null ? searchResults : status?.fallbackEntries || [];
  const filteredEntries = Array.isArray(allEntries) ? allEntries : [];
  const totalPages = Math.ceil(filteredEntries.length / itemsPerPage) || 1;
  const currentEntries = filteredEntries.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const winnerRows = (status?.fallbackEntries || []).filter((e: any) => e?.type === 'WINNER_CHARGED');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'ops', label: 'Ops' },
    { id: 'fulfillment', label: 'Fulfillment' },
    { id: 'growth', label: 'Growth' },
    { id: 'support', label: 'Support' },
    { id: 'ledger', label: 'Ledger' },
  ];

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: '28px 16px 60px',
        background: '#060606',
        color: '#f7f7f7',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>GOYUNIR Admin</h1>
            <p style={{ color: '#888', margin: '6px 0 0', fontSize: 12 }}>
              {lastUpdatedAt ? `Updated ${secondsAgo}s ago` : 'Loading…'} ·{' '}
              <span style={{ color: status?.stripeConfigured ? '#34d399' : '#f87171' }}>Stripe</span> ·{' '}
              <span style={{ color: status?.redisConfigured ? '#34d399' : '#f87171' }}>Redis</span> ·{' '}
              <span style={{ color: '#34d399' }}>{status?.liveActiveUsersOnline ?? 0} online</span>
            </p>
          </div>
          <Link href="/" style={{ color: '#888', fontSize: 12, textDecoration: 'none' }}>
            ← Store
          </Link>
        </div>

        <div style={{ ...card, marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            style={{
              flex: 1,
              minWidth: 160,
              padding: '10px 12px',
              borderRadius: 10,
              background: '#09090b',
              border: '1px solid #27272a',
              color: '#fff',
              fontSize: 13,
            }}
          />
          <button
            onClick={toggleReveal}
            disabled={revealBusy}
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid #27272a',
              background: revealAddresses ? '#1c1c1e' : 'transparent',
              color: revealAddresses ? '#34d399' : '#ccc',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {revealAddresses ? 'Hide addresses' : 'Reveal addresses'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                if (t.id === 'growth') {
                  fetchPromos();
                  fetchAudit();
                }
              }}
              style={{
                padding: '8px 14px',
                borderRadius: 20,
                border: tab === t.id ? '1px solid #fff' : '1px solid #27272a',
                background: tab === t.id ? '#fff' : 'transparent',
                color: tab === t.id ? '#000' : '#aaa',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
              {[
                { l: 'INT', v: totalInt, c: '#edb210' },
                { l: 'SUB', v: totalSub, c: '#34d399' },
                { l: 'SLS', v: totalSales, c: '#60a5fa' },
                { l: 'INV', v: totalInv, c: '#fff' },
              ].map((k) => (
                <div key={k.l} style={card}>
                  <div style={{ fontSize: 10, color: k.c, fontWeight: 700 }}>{k.l}</div>
                  <div style={{ fontSize: 26, fontFamily: 'monospace', fontWeight: 700 }}>{k.v}</div>
                </div>
              ))}
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, marginBottom: 8 }}>INT → SUB {conv}%</div>
              <Bar value={totalInt} max={maxBar} color="#edb210" />
              <div style={{ height: 8 }} />
              <Bar value={totalSub} max={maxBar} color="#34d399" />
              <div style={{ height: 8 }} />
              <Bar value={totalSales} max={maxBar} color="#60a5fa" />
            </div>
            <div style={card}>
              <h2 style={{ margin: '0 0 10px', fontSize: 13, textTransform: 'uppercase' }}>Pools</h2>
              {pools.map((p: any, i: number) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span>
                      {p.product} {p.size}
                    </span>
                    <span style={{ fontFamily: 'monospace', color: '#34d399' }}>
                      {p.subCount || 0} sub · {p.maxLimit ?? 0} inv
                    </span>
                  </div>
                  <Bar value={p.subCount || 0} max={maxSubPool} color="#34d399" />
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'ops' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['draw', 'inventory', 'catalog'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setOpsSub(s)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: opsSub === s ? '1px solid #fff' : '1px solid #333',
                    background: opsSub === s ? '#1c1c1e' : 'transparent',
                    color: '#ccc',
                    fontSize: 11,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            {opsSub === 'draw' && (
              <div style={card}>
                <select
                  value={selectedDrawTarget}
                  onChange={(e) => setSelectedDrawTarget(e.target.value)}
                  style={{
                    width: '100%',
                    padding: 12,
                    marginBottom: 10,
                    borderRadius: 10,
                    background: '#09090b',
                    border: '1px solid #27272a',
                    color: '#fff',
                  }}
                >
                  <option value="ALL_POOLS">All pools</option>
                  {GOYUNIR_STORE_SUITE.productCatalog.flatMap((p) =>
                    ['50ml', '100ml'].map((sz) => (
                      <option key={`${p.name}-${sz}`} value={`drop_pool:${p.name}:${sz}`}>
                        {p.name} — {sz}
                      </option>
                    )),
                  )}
                </select>
                <button
                  onClick={triggerDrop}
                  disabled={isRunning}
                  style={{
                    width: '100%',
                    padding: 14,
                    borderRadius: 12,
                    border: 'none',
                    background: '#edb210',
                    color: '#09090b',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {isRunning ? 'Running…' : 'Authorize & trigger draw'}
                </button>
                {password && (
                  <a
                    href={`/api/admin/export-winners?password=${encodeURIComponent(password)}`}
                    style={{ display: 'inline-block', marginTop: 12, fontSize: 12, color: '#60a5fa' }}
                  >
                    Download winners CSV
                  </a>
                )}
                {resultMessage && <p style={{ fontSize: 12, color: '#cbd5e1' }}>{resultMessage}</p>}
                <div style={{ marginTop: 16, fontSize: 12 }}>
                  <div style={{ color: '#888', marginBottom: 8 }}>Last draw</div>
                  {status?.lastDraw ? (
                    <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                      <div style={{ color: '#666', marginBottom: 6 }}>
                        {status.lastDraw.executionTime} · {status.lastDraw.totalSuccessfulCharges ?? 0} charged
                      </div>
                      {(status.lastDraw.processedWinners || []).map((w: any, i: number) => (
                        <div key={i} style={{ background: '#09090b', padding: 10, borderRadius: 8, marginBottom: 6 }}>
                          <div>{w.email}</div>
                          <div style={{ color: '#34d399', fontSize: 11 }}>
                            {w.product} — {w.size} · {w.status}
                          </div>
                          <div style={{ color: '#666', fontSize: 11 }}>
                            {revealAddresses ? w.shippingAddress : '••••'}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: '#555' }}>No draw yet</p>
                  )}
                </div>
              </div>
            )}

            {opsSub === 'inventory' && (
              <div style={card}>
                {pools.map((p: any, i: number) => {
                  const key = `${p.product}:${p.size}`;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        marginBottom: 10,
                        background: '#09090b',
                        padding: 12,
                        borderRadius: 10,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 140, fontSize: 12 }}>
                        <strong>
                          {p.product} · {p.size}
                        </strong>
                        <div style={{ color: '#666', fontSize: 10 }}>{p.productId}</div>
                        <div style={{ fontSize: 11, marginTop: 4 }}>
                          <span style={{ color: '#edb210' }}>{p.intCount ?? 0} INT</span> ·{' '}
                          <span style={{ color: '#34d399' }}>{p.subCount ?? 0} SUB</span> ·{' '}
                          <span style={{ color: '#60a5fa' }}>{p.salesCount ?? 0} SLS</span> ·{' '}
                          <span style={{ color: '#fff' }}>{p.maxLimit ?? 0} INV</span>
                        </div>
                      </div>
                      <input
                        type="number"
                        min={0}
                        value={invEdits[key] ?? ''}
                        placeholder={String(p.maxLimit ?? 0)}
                        onChange={(e) => setInvEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                        style={{
                          width: 72,
                          padding: 8,
                          borderRadius: 8,
                          background: '#000',
                          border: '1px solid #27272a',
                          color: '#fff',
                        }}
                      />
                      <button
                        onClick={() => saveInventory(p.product, p.size, p.productId)}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 8,
                          border: 'none',
                          background: '#fff',
                          color: '#000',
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Save
                      </button>
                    </div>
                  );
                })}
                {invMessage && <p style={{ fontSize: 12 }}>{invMessage}</p>}
              </div>
            )}

            {opsSub === 'catalog' && (
              <div style={card}>
                <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>
                  Available from + notes show on archived product pages.
                </p>
                {GOYUNIR_STORE_SUITE.productCatalog.map((product) => {
                  const isArchived = archivedIds.includes(product.id);
                  return (
                    <div
                      key={product.id}
                      style={{
                        background: '#09090b',
                        padding: 14,
                        borderRadius: 10,
                        marginBottom: 10,
                        border: '1px solid #1c1c1e',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {product.name}{' '}
                          <span style={{ color: '#555', fontSize: 10 }}>({product.slug})</span>
                          {isArchived && <span style={{ color: '#f59e0b' }}> ARCHIVED</span>}
                        </div>
                        {isArchived ? (
                          <button
                            onClick={() => unarchiveProduct(product)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 8,
                              border: '1px solid #34d399',
                              background: 'transparent',
                              color: '#34d399',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            onClick={() => setArchivingId(archivingId === product.id ? null : product.id)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 8,
                              border: '1px solid #f59e0b',
                              background: 'transparent',
                              color: '#f59e0b',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            {archivingId === product.id ? 'Cancel' : 'Archive'}
                          </button>
                        )}
                      </div>
                      {archivingId === product.id && (
                        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input
                            placeholder="Available from (shown on site)"
                            value={availableFromInput}
                            onChange={(e) => setAvailableFromInput(e.target.value)}
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              background: '#000',
                              border: '1px solid #27272a',
                              color: '#fff',
                            }}
                          />
                          <input
                            placeholder="Notes (shown on site)"
                            value={archiveNotes}
                            onChange={(e) => setArchiveNotes(e.target.value)}
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              background: '#000',
                              border: '1px solid #27272a',
                              color: '#fff',
                            }}
                          />
                          <button
                            onClick={() => archiveProduct(product)}
                            style={{
                              padding: 10,
                              borderRadius: 8,
                              border: 'none',
                              background: '#f59e0b',
                              color: '#000',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Confirm archive
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {catalogMessage && <p style={{ fontSize: 12 }}>{catalogMessage}</p>}
              </div>
            )}
          </div>
        )}

        {tab === 'fulfillment' && (
          <div style={card}>
            <h2 style={{ margin: '0 0 8px', fontSize: 14, textTransform: 'uppercase' }}>Shipping queue</h2>
            {shipMsg && <p style={{ fontSize: 12, color: '#cbd5e1' }}>{shipMsg}</p>}
            {winnerRows.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No winners in ledger snapshot.</p>}
            {winnerRows.map((row: any, i: number) => (
              <div
                key={i}
                style={{
                  background: '#09090b',
                  padding: 12,
                  borderRadius: 10,
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>{row.email}</div>
                <div style={{ color: '#888' }}>
                  {row.variant} · {row.size}
                </div>
                <div style={{ color: '#666', marginTop: 4 }}>
                  {revealAddresses ? row.shippingAddress || 'n/a' : '••••'}
                </div>
                <select
                  defaultValue={row.shippingStatus || 'PENDING_FULFILLMENT'}
                  onChange={(e) => updateShipping(row, e.target.value)}
                  style={{
                    marginTop: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: '#000',
                    border: '1px solid #27272a',
                    color: '#fff',
                  }}
                >
                  {SHIP_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        {tab === 'growth' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={card}>
              <h2 style={{ margin: '0 0 8px', fontSize: 14, textTransform: 'uppercase' }}>Entry recovery</h2>
              <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>
                Tasteful INT reminders: ~{recovery.earlyDelayHours}h after start
                {recovery.preDrawEnabled ? ` + within ${recovery.preDrawHours}h of draw` : ''}. Max 2. Hourly cron.
              </p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={recovery.enabled}
                  onChange={(e) => setRecovery((r) => ({ ...r, enabled: e.target.checked }))}
                />
                Enabled
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={recovery.preDrawEnabled}
                  onChange={(e) => setRecovery((r) => ({ ...r, preDrawEnabled: e.target.checked }))}
                />
                Pre-draw nudge
              </label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <label style={{ fontSize: 12 }}>
                  Early delay (h)
                  <input
                    type="number"
                    min={1}
                    value={recovery.earlyDelayHours}
                    onChange={(e) =>
                      setRecovery((r) => ({ ...r, earlyDelayHours: Number(e.target.value) || 3 }))
                    }
                    style={{
                      display: 'block',
                      width: 80,
                      marginTop: 4,
                      padding: 8,
                      borderRadius: 8,
                      background: '#09090b',
                      border: '1px solid #27272a',
                      color: '#fff',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  Pre-draw window (h)
                  <input
                    type="number"
                    min={1}
                    value={recovery.preDrawHours}
                    onChange={(e) =>
                      setRecovery((r) => ({ ...r, preDrawHours: Number(e.target.value) || 24 }))
                    }
                    style={{
                      display: 'block',
                      width: 80,
                      marginTop: 4,
                      padding: 8,
                      borderRadius: 8,
                      background: '#09090b',
                      border: '1px solid #27272a',
                      color: '#fff',
                    }}
                  />
                </label>
              </div>
              <button
                onClick={saveRecovery}
                style={{
                  padding: '10px 16px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#fff',
                  color: '#000',
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Save recovery
              </button>
              {recoveryMsg && <p style={{ fontSize: 12 }}>{recoveryMsg}</p>}
            </div>

            <div style={card}>
              <h2 style={{ margin: '0 0 8px', fontSize: 14, textTransform: 'uppercase' }}>Promo / affiliates</h2>
              <p style={{ fontSize: 12, color: '#888' }}>
                Share link: <code style={{ color: '#aaa' }}>/elysian-white?ref=CODE</code>. Credit on entry; revenue
                on charge. Self-use blocked by promoter email.
              </p>
              <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                <input
                  placeholder="CODE"
                  value={promoForm.code}
                  onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value }))}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: '#09090b',
                    border: '1px solid #27272a',
                    color: '#fff',
                  }}
                />
                <input
                  placeholder="Promoter name"
                  value={promoForm.promoterName}
                  onChange={(e) => setPromoForm((f) => ({ ...f, promoterName: e.target.value }))}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: '#09090b',
                    border: '1px solid #27272a',
                    color: '#fff',
                  }}
                />
                <input
                  placeholder="Promoter email (block self-use)"
                  value={promoForm.promoterEmail}
                  onChange={(e) => setPromoForm((f) => ({ ...f, promoterEmail: e.target.value }))}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: '#09090b',
                    border: '1px solid #27272a',
                    color: '#fff',
                  }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    placeholder="Customer % off (on charge later)"
                    value={promoForm.customerDiscountPercent}
                    onChange={(e) => setPromoForm((f) => ({ ...f, customerDiscountPercent: e.target.value }))}
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 8,
                      background: '#09090b',
                      border: '1px solid #27272a',
                      color: '#fff',
                    }}
                  />
                  <input
                    placeholder="Promoter payout %"
                    value={promoForm.promoterPayoutPercent}
                    onChange={(e) => setPromoForm((f) => ({ ...f, promoterPayoutPercent: e.target.value }))}
                    style={{
                      flex: 1,
                      padding: 10,
                      borderRadius: 8,
                      background: '#09090b',
                      border: '1px solid #27272a',
                      color: '#fff',
                    }}
                  />
                </div>
                <button
                  onClick={savePromo}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: 'none',
                    background: '#edb210',
                    color: '#000',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Save promo
                </button>
              </div>
              {promoMsg && <p style={{ fontSize: 12 }}>{promoMsg}</p>}
              {promos.map((p) => (
                <div
                  key={p.code}
                  style={{
                    background: '#09090b',
                    padding: 12,
                    borderRadius: 10,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{p.code}</div>
                  <div style={{ color: '#888' }}>
                    {p.promoterName} · {p.promoterEmail || 'no email'}
                  </div>
                  <div style={{ color: '#aaa', marginTop: 4 }}>
                    uses {p.uses || 0} · attributed ${Number(p.revenueAttributed || 0).toFixed(0)} · payout{' '}
                    {p.promoterPayoutPercent}% · discount {p.customerDiscountPercent}%
                  </div>
                  <button
                    onClick={() => deletePromo(p.code)}
                    style={{
                      marginTop: 8,
                      fontSize: 11,
                      color: '#f87171',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>

            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase' }}>Audit</h2>
                <button
                  onClick={fetchAudit}
                  style={{
                    fontSize: 11,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid #333',
                    background: 'transparent',
                    color: '#ccc',
                    cursor: 'pointer',
                  }}
                >
                  Refresh
                </button>
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 10, fontSize: 11, color: '#888' }}>
                {audit.length === 0 && <p>No audit rows (password required to load).</p>}
                {audit.map((a, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    {a.at} — {a.action} {a.detail || ''}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'support' && (
          <div style={card}>
            <h2 style={{ margin: '0 0 8px', fontSize: 14, textTransform: 'uppercase' }}>Lookup</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <input
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="email or fragment"
                style={{
                  flex: 1,
                  minWidth: 160,
                  padding: 12,
                  borderRadius: 10,
                  background: '#09090b',
                  border: '1px solid #27272a',
                  color: '#fff',
                }}
              />
              <button
                onClick={runSupportLookup}
                style={{
                  padding: '12px 16px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#fff',
                  color: '#000',
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Search
              </button>
            </div>
            {supportMsg && <p style={{ fontSize: 12, color: '#888' }}>{supportMsg}</p>}
            {supportRows.map((e: any, i: number) => (
              <div
                key={i}
                style={{
                  background: '#09090b',
                  padding: 12,
                  borderRadius: 10,
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>{e.email}</div>
                <div style={{ color: '#888' }}>
                  {e.variant} · {e.size} ·{' '}
                  <span style={{ color: typeColor(e.type), fontWeight: 700 }}>{e.type}</span>
                </div>
                <div style={{ color: '#666', marginTop: 4 }}>
                  {revealAddresses ? e.shippingAddress || 'n/a' : '••••'}
                </div>
                {e.type === 'WINNER_CHARGED' && (
                  <select
                    defaultValue={e.shippingStatus || 'PENDING_FULFILLMENT'}
                    onChange={(ev) => updateShipping(e, ev.target.value)}
                    style={{
                      marginTop: 8,
                      padding: 6,
                      borderRadius: 8,
                      background: '#000',
                      border: '1px solid #27272a',
                      color: '#fff',
                    }}
                  >
                    {SHIP_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'ledger' && (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <motion.div
                key={pulseTick}
                initial={{ scale: 1.6, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 1 }}
                style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399', marginRight: 8 }}
              />
              <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase' }}>Ledger</h2>
            </div>
            <input
              placeholder="Search…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: 12,
                borderRadius: 10,
                background: '#09090b',
                border: '1px solid #27272a',
                color: '#fff',
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
            />
            {isSearching && <p style={{ fontSize: 11, color: '#666' }}>Searching…</p>}
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {currentEntries.map((e: any, i: number) => (
                <div
                  key={i}
                  style={{
                    background: '#09090b',
                    padding: 12,
                    borderRadius: 10,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{e.email}</div>
                  <div style={{ color: '#888' }}>
                    {e.variant} · {e.size} ·{' '}
                    <span style={{ color: typeColor(e.type), fontWeight: 700 }}>{e.type}</span>
                  </div>
                  <div style={{ color: '#666', marginTop: 4 }}>
                    {revealAddresses ? e.shippingAddress || 'n/a' : '••••'}
                  </div>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)}>
                  Prev
                </button>
                <span style={{ fontSize: 12, color: '#888' }}>
                  {currentPage}/{totalPages}
                </span>
                <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}