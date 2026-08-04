'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

type Tab = 'overview' | 'drops' | 'orders' | 'growth' | 'ledger' | 'system';

const SHIP_STATUSES = ['PENDING_FULFILLMENT', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED'] as const;

function typeColor(type: string | undefined) {
  if (!type) return '#a1a1aa';
  if (type === 'ENTERED' || type === 'WINNER_CHARGED') return '#34d399';
  if (type === 'INTENT_STARTED') return '#edb210';
  if (type === 'NOT_SELECTED' || type === 'INTENT_EXPIRED') return '#888888';
  if (type === 'WINNER_DECLINED' || type === 'ADDRESS_UPDATED') return '#60a5fa';
  if (type?.includes('CANCEL')) return '#f87171';
  if (type === 'ADMIN_NOTE') return '#c084fc';
  return '#a1a1aa';
}

function typeLabel(type: string | undefined) {
  const map: Record<string, string> = {
    ENTERED: 'Entered',
    WINNER_CHARGED: 'Won & Charged',
    WINNER_DECLINED: 'Charge Declined',
    NOT_SELECTED: 'Not Selected',
    INTENT_STARTED: 'Started (Unfinished)',
    INTENT_EXPIRED: 'Never Finished',
    ADDRESS_UPDATED: 'Address Changed',
    CANCELLED_BY_USER: 'Cancelled (Customer)',
    CANCELLED_BY_ADMIN: 'Cancelled (Admin)',
    ADMIN_NOTE: 'Admin Note',
  };
  return map[type || ''] || type || 'Unknown';
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max <= 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div style={{ height: 8, borderRadius: 6, background: '#1c1c1e', overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s ease' }} />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 20,
  borderRadius: 16,
  background: '#111',
  border: '1px solid #27272a',
};

const inputStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 8,
  background: '#09090b',
  border: '1px solid #27272a',
  color: '#fff',
  fontSize: 13,
  boxSizing: 'border-box',
};

const buttonPrimary: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 10,
  border: 'none',
  background: '#fff',
  color: '#000',
  fontWeight: 700,
  fontSize: 12,
  cursor: 'pointer',
};

const buttonGhost: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #27272a',
  background: 'transparent',
  color: '#ccc',
  fontSize: 11,
  cursor: 'pointer',
};


/** Always send Basic Auth credentials so /api/admin/* middleware does not 401. */
function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: 'include' });
}

export default function AdminPortal() {
  const [tab, setTab] = useState<Tab>('overview');
  const [drawsSub, setDrawsSub] = useState<'run' | 'inventory' | 'catalog' | 'schedule'>('run');
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

  const [orders, setOrders] = useState<any[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');
  const [editingOrderKey, setEditingOrderKey] = useState<string | null>(null);
  const [orderAddressDraft, setOrderAddressDraft] = useState('');
  const [orderMsg, setOrderMsg] = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 40;
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL');
  const [shipMsg, setShipMsg] = useState('');

  const [recovery, setRecovery] = useState({ enabled: true, earlyDelayHours: 3, preDrawHours: 24, preDrawEnabled: true });
  const [recoveryMsg, setRecoveryMsg] = useState('');

  const [promos, setPromos] = useState<any[]>([]);
  const [promoForm, setPromoForm] = useState({
    code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '0', promoterPayoutPercent: '10', maxUsesPerEmail: '1',
  });
  const [promoMsg, setPromoMsg] = useState('');
  const [audit, setAudit] = useState<any[]>([]);

  const [configData, setConfigData] = useState<any>(null);
  const [scheduleForm, setScheduleForm] = useState<any>({});
  const [socialForm, setSocialForm] = useState<any>({});
  const [priceForm, setPriceForm] = useState<Record<string, { price50ml: string; price100ml: string }>>({});
  const [configMsg, setConfigMsg] = useState('');

  const [selftestResults, setSelftestResults] = useState<any>(null);
  const [selftestRunning, setSelftestRunning] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await adminFetch(`/api/admin/status?t=${Date.now()}`);
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
      const res = await adminFetch('/api/admin/recovery-config');
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
      const res = await adminFetch('/api/admin/promos');
      const data = await res.json();
      setPromos(Array.isArray(data.promos) ? data.promos : []);
    } catch {}
  };

  const fetchAudit = async () => {
    if (!password) return;
    try {
      const res = await adminFetch(`/api/admin/audit?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setAudit(Array.isArray(data.entries) ? data.entries : []);
    } catch {}
  };

  const fetchConfig = async () => {
    try {
      const res = await adminFetch('/api/admin/config');
      const data = await res.json();
      setConfigData(data);
      setScheduleForm({ ...data.baseSchedule, ...(data.globalScheduleOverride || {}) });
      setSocialForm({ ...data.baseSocialProof, ...(data.socialProofOverride || {}) });
      const pf: Record<string, { price50ml: string; price100ml: string }> = {};
      for (const p of data.products || []) {
        const override = data.productOverrides?.[p.id];
        pf[p.id] = { price50ml: String(override?.price50ml ?? p.price50ml), price100ml: String(override?.price100ml ?? p.price100ml) };
      }
      setPriceForm(pf);
    } catch {}
  };

  const fetchOrders = async () => {
    if (!password) { setOrderMsg('Enter admin password first.'); return; }
    setOrdersLoading(true);
    try {
      const res = await adminFetch(`/api/admin/orders?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      if (res.ok) { setOrders(Array.isArray(data.orders) ? data.orders : []); setOrderMsg(''); }
      else setOrderMsg(data.error || 'Failed to load orders.');
    } catch {
      setOrderMsg('Connection failed.');
    } finally {
      setOrdersLoading(false);
    }
  };

  const cancelOrder = async (order: any) => {
    if (!password) return alert('Enter password');
    const reason = prompt(`Cancel ${order.email}'s entry for ${order.variant} (${order.size})? Optional reason:`);
    if (reason === null) return;
    try {
      const res = await adminFetch('/api/admin/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'cancel', variant: order.variant, size: order.size, email: order.email, reason }),
      });
      const data = await res.json();
      if (res.ok) { setOrderMsg('Order cancelled.'); await fetchOrders(); } else setOrderMsg(data.error || 'Failed.');
    } catch {
      setOrderMsg('Connection failed.');
    }
  };

  const saveOrderAddress = async (order: any) => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'updateAddress', variant: order.variant, size: order.size, email: order.email, newAddress: orderAddressDraft }),
      });
      const data = await res.json();
      if (res.ok) { setOrderMsg('Address updated.'); setEditingOrderKey(null); await fetchOrders(); } else setOrderMsg(data.error || 'Failed.');
    } catch {
      setOrderMsg('Connection failed.');
    }
  };

  const saveSchedule = async () => {
    if (!password) return alert('Enter password');
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'schedule', value: scheduleForm }),
    });
    setConfigMsg(res.ok ? 'Schedule saved — live immediately, no redeploy needed.' : 'Failed to save schedule.');
  };

  const saveSocial = async () => {
    if (!password) return alert('Enter password');
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'socialProof', value: socialForm }),
    });
    setConfigMsg(res.ok ? 'Social proof settings saved.' : 'Failed to save.');
  };

  const savePrice = async (productId: string) => {
    if (!password) return alert('Enter password');
    const v = priceForm[productId];
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'product', productId, value: { price50ml: Number(v.price50ml), price100ml: Number(v.price100ml) } }),
    });
    setConfigMsg(res.ok ? `Price saved for ${productId}.` : 'Failed to save price.');
  };

  const runSelftest = async () => {
    if (!password) return alert('Enter password');
    setSelftestRunning(true);
    setSelftestResults(null);
    try {
      const res = await adminFetch(`/api/admin/selftest?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setSelftestResults(data);
    } catch {
      setSelftestResults({ error: 'Could not run self-test — connection failed.' });
    } finally {
      setSelftestRunning(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchCatalogStatus();
    fetchRecovery();
    fetchPromos();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!pollTimer) pollTimer = setInterval(fetchStatus, 30000); };
    const stop = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
    const vis = () => { if (document.visibilityState === 'visible') { fetchStatus(); start(); } else stop(); };
    start();
    document.addEventListener('visibilitychange', vis);
    return () => { stop(); document.removeEventListener('visibilitychange', vis); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => { if (lastUpdatedAt) setSecondsAgo(Math.round((Date.now() - lastUpdatedAt) / 1000)); }, 1000);
    return () => clearInterval(t);
  }, [lastUpdatedAt]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const term = searchTerm.trim();
    if (!term) { setSearchResults(null); setCurrentPage(1); return; }
    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await adminFetch(`/api/admin/search?q=${encodeURIComponent(term)}`);
        const data = await res.json();
        setSearchResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
        setCurrentPage(1);
      }
    }, 400);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchTerm]);

  const toggleReveal = async () => {
    if (revealAddresses) { setRevealAddresses(false); return; }
    if (!password) return alert('Enter password');
    setRevealBusy(true);
    try {
      const res = await adminFetch('/api/admin/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
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
    if (!confirm('This will run the draw and charge selected winners\' saved cards. Continue?')) return;
    setIsRunning(true);
    setResultMessage('Running…');
    try {
      const res = await adminFetch('/api/admin/trigger-drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPool: selectedDrawTarget, verificationKey: password }),
      });
      const data = await res.json();
      if (res.ok) { setResultMessage(`Done. Charged ${data.drawSummary?.totalSuccessfulCharges ?? 0} winner(s).`); await fetchStatus(); }
      else setResultMessage(data.error || 'Failed');
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
      const res = await adminFetch('/api/admin/inventory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, productName, size, productId, inventoryRemaining: value }),
      });
      const data = await res.json();
      if (res.ok) { setInvMessage(`Saved ${productName} ${size} → ${value} remaining.`); await fetchStatus(); } else setInvMessage(data.error || 'Failed');
    } catch {
      setInvMessage('Connection failed');
    }
  };

  const archiveProduct = async (product: any) => {
    if (!password) return alert('Enter password');
    if (!confirm(`Archive ${product.name}? It moves to the public Catalog page's archive section immediately.`)) return;
    try {
      const res = await adminFetch('/api/admin/catalog-archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'archive', productId: product.id, name: product.name, description: product.desc,
          image: `/images/${product.prefix}/1.jpeg`, availableFrom: availableFromInput || 'Unknown',
          notes: archiveNotes || '', verificationKey: password,
        }),
      });
      const data = await res.json();
      if (res.ok) { setCatalogMessage(`${product.name} archived.`); setArchivingId(null); await fetchCatalogStatus(); } else setCatalogMessage(data.error || 'Failed');
    } catch {
      setCatalogMessage('Connection failed');
    }
  };

  const unarchiveProduct = async (product: any) => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/catalog-archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unarchive', productId: product.id, verificationKey: password }),
      });
      const data = await res.json();
      if (res.ok) { setCatalogMessage(`${product.name} restored to active.`); await fetchCatalogStatus(); } else setCatalogMessage(data.error || 'Failed');
    } catch {
      setCatalogMessage('Connection failed');
    }
  };

  const updateShipping = async (row: any, shippingStatus: string) => {
    if (!password) return alert('Enter password');
    setShipMsg('Updating…');
    try {
      const res = await adminFetch('/api/admin/shipping-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, email: row.email, variant: row.variant, size: row.size, shippingStatus }),
      });
      const data = await res.json();
      if (res.ok) { setShipMsg(`Updated ${data.updated || 0} record(s) → ${shippingStatus}.`); await fetchStatus(); } else setShipMsg(data.error || 'Failed');
    } catch {
      setShipMsg('Failed');
    }
  };

  const saveRecovery = async () => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/recovery-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...recovery }) });
      const data = await res.json();
      setRecoveryMsg(res.ok ? 'Recovery settings saved.' : data.error || 'Failed');
    } catch {
      setRecoveryMsg('Failed');
    }
  };

  const savePromo = async () => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/promos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password, action: 'upsert', code: promoForm.code, promoterName: promoForm.promoterName, promoterEmail: promoForm.promoterEmail,
          customerDiscountPercent: Number(promoForm.customerDiscountPercent), promoterPayoutPercent: Number(promoForm.promoterPayoutPercent), maxUsesPerEmail: Number(promoForm.maxUsesPerEmail ?? 1), active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPromoMsg(`Saved ${data.promo?.code}.`);
        setPromoForm({ code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '0', promoterPayoutPercent: '10', maxUsesPerEmail: '1' });
        await fetchPromos();
      } else setPromoMsg(data.error || 'Failed');
    } catch {
      setPromoMsg('Failed');
    }
  };

  const deletePromo = async (code: string) => {
    if (!password) return alert('Enter password');
    if (!confirm(`Delete promo code ${code}? This cannot be undone.`)) return;
    await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'delete', code }) });
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
  const rawFilteredEntries = Array.isArray(allEntries) ? allEntries : [];
  const filteredEntries = rawFilteredEntries.filter((e) => ledgerTypeFilter === 'ALL' || e.type === ledgerTypeFilter);
  const totalPages = Math.ceil(filteredEntries.length / itemsPerPage) || 1;
  const currentEntries = filteredEntries.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const winnerRows = (status?.fallbackEntries || []).filter((e: any) => e?.type === 'WINNER_CHARGED');

  const filteredOrders = orders.filter((o) => {
    if (!orderSearch.trim()) return true;
    const q = orderSearch.toLowerCase();
    return o.email.toLowerCase().includes(q) || o.variant.toLowerCase().includes(q) || (o.promoCode || '').toLowerCase().includes(q);
  });

  const totalOwed = promos.reduce((s, p) => s + (p.payoutOwedCents || 0), 0);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'drops', label: 'Drops' },
    { id: 'orders', label: 'Orders', badge: orders.length || undefined },
    { id: 'growth', label: 'Growth', badge: totalOwed > 0 ? Math.round(totalOwed / 100) : undefined },
    { id: 'ledger', label: 'Ledger' },
    { id: 'system', label: 'System' },
  ];

  return (
    <main style={{ minHeight: '100vh', padding: '28px 16px 60px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>GOYUNIR Admin</h1>
            <p style={{ color: '#888', margin: '6px 0 0', fontSize: 12 }}>
              {lastUpdatedAt ? `Updated ${secondsAgo}s ago` : 'Loading…'} ·{' '}
              <span style={{ color: status?.stripeConfigured ? '#34d399' : '#f87171' }}>Stripe</span> ·{' '}
              <span style={{ color: status?.redisConfigured ? '#34d399' : '#f87171' }}>Redis</span>{' · '}<span style={{ color: status?.resendConfigured ? '#34d399' : '#f87171' }}>Resend</span> ·{' '}
              <span style={{ color: '#34d399' }}>{status?.liveActiveUsersOnline ?? 0} online</span>
            </p>
          </div>
          <Link href="/" style={{ color: '#888', fontSize: 12, textDecoration: 'none', alignSelf: 'flex-start', padding: '6px 0' }}>← Store</Link>
        </div>

        <div style={{ ...cardStyle, marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password"
            style={{ ...inputStyle, flex: 1, minWidth: 160, padding: '10px 12px' }} />
          <button onClick={toggleReveal} disabled={revealBusy}
            style={{ ...buttonGhost, padding: '10px 14px', background: revealAddresses ? '#1c1c1e' : 'transparent', color: revealAddresses ? '#34d399' : '#ccc' }}>
            {revealAddresses ? 'Hide addresses' : 'Reveal addresses'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {tabs.map((t) => (
            <button key={t.id}
              onClick={() => {
                setTab(t.id);
                if (t.id === 'growth') { fetchPromos(); fetchAudit(); }
                if (t.id === 'orders' && orders.length === 0) fetchOrders();
                if (t.id === 'system') fetchAudit();
              }}
              style={{
                padding: '8px 14px', borderRadius: 20, border: tab === t.id ? '1px solid #fff' : '1px solid #27272a',
                background: tab === t.id ? '#fff' : 'transparent', color: tab === t.id ? '#000' : '#aaa',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}>
              {t.label}
              {t.badge ? (
                <span style={{ background: tab === t.id ? '#000' : '#edb210', color: tab === t.id ? '#fff' : '#000', fontSize: 9, padding: '1px 5px', borderRadius: 8, fontWeight: 700 }}>
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ============ OVERVIEW ============ */}
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
              {[
                { l: 'STARTED', v: totalInt, c: '#edb210' },
                { l: 'ENTERED', v: totalSub, c: '#34d399' },
                { l: 'CHARGED', v: totalSales, c: '#60a5fa' },
                { l: 'INVENTORY LEFT', v: totalInv, c: '#fff' },
              ].map((k) => (
                <div key={k.l} style={cardStyle}>
                  <div style={{ fontSize: 10, color: k.c, fontWeight: 700, letterSpacing: '0.5px' }}>{k.l}</div>
                  <div style={{ fontSize: 26, fontFamily: 'monospace', fontWeight: 700 }}>{k.v}</div>
                </div>
              ))}
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, marginBottom: 8, color: '#ccc' }}>Started → Entered conversion: <strong style={{ color: '#fff' }}>{conv}%</strong></div>
              <Bar value={totalInt} max={maxBar} color="#edb210" />
              <div style={{ height: 8 }} />
              <Bar value={totalSub} max={maxBar} color="#34d399" />
              <div style={{ height: 8 }} />
              <Bar value={totalSales} max={maxBar} color="#60a5fa" />
            </div>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 10px', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Pools</h2>
              {pools.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No pools yet.</p>}
              {pools.map((p: any, i: number) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span>{p.product} — {p.size}</span>
                    <span style={{ fontFamily: 'monospace', color: '#34d399' }}>{(p.intCount ?? 0)} started · {(p.subCount || 0)} entered · {(p.salesCount ?? 0)} sold · {p.maxLimit ?? 0} left</span>
                  </div>
                  <Bar value={p.subCount || 0} max={maxSubPool} color="#34d399" />
                </div>
              ))}
            </div>
            {totalOwed > 0 && (
              <div style={{ ...cardStyle, borderColor: '#edb210' }}>
                <div style={{ fontSize: 12, color: '#edb210', fontWeight: 700 }}>💰 ${(totalOwed / 100).toFixed(2)} owed to promoters — see Growth tab</div>
              </div>
            )}
          </div>
        )}

        {/* ============ DROPS (draw + inventory + catalog + schedule) ============ */}
        {tab === 'drops' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['run', 'inventory', 'catalog', 'schedule'] as const).map((s) => (
                <button key={s} onClick={() => { setDrawsSub(s); if (s === 'schedule') fetchConfig(); }}
                  style={{ ...buttonGhost, border: drawsSub === s ? '1px solid #fff' : '1px solid #333', background: drawsSub === s ? '#1c1c1e' : 'transparent', textTransform: 'capitalize' }}>
                  {s === 'run' ? 'Run Draw' : s}
                </button>
              ))}
            </div>

            {drawsSub === 'run' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Trigger a Draw</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  Randomly selects winners up to each pool&apos;s configured count and charges their saved cards immediately. Non-winners stay entered for next time.
                </p>
                <select value={selectedDrawTarget} onChange={(e) => setSelectedDrawTarget(e.target.value)}
                  style={{ ...inputStyle, width: '100%', marginBottom: 10 }}>
                  <option value="ALL_POOLS">All pools</option>
                  {GOYUNIR_STORE_SUITE.productCatalog.flatMap((p) =>
                    ['50ml', '100ml'].map((sz) => (
                      <option key={`${p.name}-${sz}`} value={`drop_pool:${p.name}:${sz}`}>{p.name} — {sz}</option>
                    )),
                  )}
                </select>
                <button onClick={triggerDrop} disabled={isRunning}
                  style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', background: isRunning ? '#333' : '#edb210', color: '#09090b', fontWeight: 700, cursor: isRunning ? 'not-allowed' : 'pointer' }}>
                  {isRunning ? 'Running…' : 'Authorize & Trigger Draw'}
                </button>
                {password && (
                  <a href={`/api/admin/export-winners?password=${encodeURIComponent(password)}`}
                    style={{ display: 'inline-block', marginTop: 12, fontSize: 12, color: '#60a5fa' }}>
                    ↓ Download all-time winners CSV
                  </a>
                )}
                {resultMessage && <p style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10 }}>{resultMessage}</p>}
                <div style={{ marginTop: 16, fontSize: 12 }}>
                  <div style={{ color: '#888', marginBottom: 8 }}>Most recent draw</div>
                  {status?.lastDraw ? (
                    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                      <div style={{ color: '#666', marginBottom: 6 }}>{status.lastDraw.executionTime} · {status.lastDraw.totalSuccessfulCharges ?? 0} charged</div>
                      {(status.lastDraw.processedWinners || []).map((w: any, i: number) => (
                        <div key={i} style={{ background: '#09090b', padding: 10, borderRadius: 8, marginBottom: 6 }}>
                          <div>{w.email}</div>
                          <div style={{ color: '#34d399', fontSize: 11 }}>{w.product} — {w.size} · {w.status}{w.promoCode ? ` · promo ${w.promoCode}` : ''}</div>
                          <div style={{ color: '#666', fontSize: 11 }}>{revealAddresses ? w.shippingAddress : '••••'}</div>
                        </div>
                      ))}
                    </div>
                  ) : <p style={{ color: '#555' }}>No draw has run yet.</p>}
                </div>
              </div>
            )}

            {drawsSub === 'inventory' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Live Inventory</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  Adjust remaining units per product/size at any time — takes effect immediately, no redeploy.
                </p>
                {pools.map((p: any, i: number) => {
                  const key = `${p.product}:${p.size}`;
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, background: '#09090b', padding: 12, borderRadius: 10 }}>
                      <div style={{ flex: 1, minWidth: 140, fontSize: 12 }}>
                        <strong>{p.product} · {p.size}</strong>
                        <div style={{ fontSize: 11, marginTop: 4 }}>
                          <span style={{ color: '#edb210' }}>{p.intCount ?? 0} started</span> · <span style={{ color: '#34d399' }}>{p.subCount ?? 0} entered</span> · <span style={{ color: '#60a5fa' }}>{p.salesCount ?? 0} sold</span> · <span style={{ color: '#fff' }}>{p.maxLimit ?? 0} left</span>
                        </div>
                      </div>
                      <input type="number" min={0} value={invEdits[key] ?? ''} placeholder={String(p.maxLimit ?? 0)}
                        onChange={(e) => setInvEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                        style={{ ...inputStyle, width: 72 }} />
                      <button onClick={() => saveInventory(p.product, p.size, p.productId)} style={buttonPrimary}>Save</button>
                    </div>
                  );
                })}
                {invMessage && <p style={{ fontSize: 12, color: '#cbd5e1' }}>{invMessage}</p>}
              </div>
            )}

            {drawsSub === 'catalog' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Catalog Archive</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  Archive a product early, or restore it. Products also auto-archive as &quot;Sold Out&quot; when inventory hits zero.
                </p>
                {GOYUNIR_STORE_SUITE.productCatalog.map((product) => {
                  const isArchived = archivedIds.includes(product.id);
                  return (
                    <div key={product.id} style={{ background: '#09090b', padding: 14, borderRadius: 10, marginBottom: 10, border: '1px solid #1c1c1e' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {product.name} <span style={{ color: '#555', fontSize: 10 }}>({product.slug})</span>{' '}
                          {isArchived && <span style={{ color: '#f59e0b' }}>ARCHIVED</span>}
                        </div>
                        {isArchived
                          ? <button onClick={() => unarchiveProduct(product)} style={{ ...buttonGhost, border: '1px solid #34d399', color: '#34d399' }}>Restore</button>
                          : <button onClick={() => setArchivingId(archivingId === product.id ? null : product.id)} style={{ ...buttonGhost, border: '1px solid #f59e0b', color: '#f59e0b' }}>Archive</button>}
                      </div>
                      {archivingId === product.id && (
                        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input placeholder="Available from (e.g. Next Spring)" value={availableFromInput} onChange={(e) => setAvailableFromInput(e.target.value)} style={inputStyle} />
                          <input placeholder="Archive notes / story" value={archiveNotes} onChange={(e) => setArchiveNotes(e.target.value)} style={inputStyle} />
                          <button onClick={() => archiveProduct(product)} style={{ ...buttonPrimary, background: '#f59e0b' }}>Confirm Archive</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {catalogMessage && <p style={{ fontSize: 12 }}>{catalogMessage}</p>}
              </div>
            )}

            {drawsSub === 'schedule' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Drop Schedule</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0 }}>Overrides goyunir.config.ts live — no redeploy needed.</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <label style={{ fontSize: 11 }}>Mode
                    <select value={scheduleForm.mode || 'weekly'} onChange={(e) => setScheduleForm((f: any) => ({ ...f, mode: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="fixed">Fixed date</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>Timezone
                    <input value={scheduleForm.timezone || ''} onChange={(e) => setScheduleForm((f: any) => ({ ...f, timezone: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  {scheduleForm.mode === 'fixed' && (
                    <label style={{ fontSize: 11, gridColumn: '1 / -1' }}>Fixed date/time (YYYY-MM-DDTHH:MM:SS)
                      <input value={scheduleForm.targetEndDateTime || ''} onChange={(e) => setScheduleForm((f: any) => ({ ...f, targetEndDateTime: e.target.value }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {scheduleForm.mode === 'weekly' && (
                    <label style={{ fontSize: 11 }}>Day of week (0=Sun..6=Sat)
                      <input type="number" min={0} max={6} value={scheduleForm.drawDayOfWeek ?? 6}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawDayOfWeek: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {scheduleForm.mode === 'monthly' && (
                    <label style={{ fontSize: 11 }}>Day of month (1-31)
                      <input type="number" min={1} max={31} value={scheduleForm.drawDayOfMonth ?? 1}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawDayOfMonth: Number(e.target.value) }))}
                        style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                    </label>
                  )}
                  {(scheduleForm.mode === 'daily' || scheduleForm.mode === 'weekly' || scheduleForm.mode === 'monthly') && (
                    <>
                      <label style={{ fontSize: 11 }}>Hour (0-23)
                        <input type="number" min={0} max={23} value={scheduleForm.drawHour ?? 21}
                          onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawHour: Number(e.target.value) }))}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                      </label>
                      <label style={{ fontSize: 11 }}>Minute (0-59)
                        <input type="number" min={0} max={59} value={scheduleForm.drawMinute ?? 0}
                          onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawMinute: Number(e.target.value) }))}
                          style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                      </label>
                    </>
                  )}
                </div>
                <button onClick={saveSchedule} style={buttonPrimary}>Save Schedule</button>

                <h3 style={{ margin: '24px 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Pricing</h3>
                <p style={{ fontSize: 11, color: '#f59e0b', marginTop: 0 }}>
                  This is what actually gets charged at draw time. If a charge falls back to a Stripe Checkout session (only happens on a declined direct charge), that fallback session uses the price attached to the Stripe Price ID instead — keep that in sync in Stripe too if you rely on that path.
                </p>
                {(configData?.products || []).map((p: any) => (
                  <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, background: '#09090b', padding: 10, borderRadius: 8 }}>
                    <div style={{ flex: 1, fontSize: 12 }}>{p.name}</div>
                    <input type="number" value={priceForm[p.id]?.price50ml ?? ''} placeholder="50ml $"
                      onChange={(e) => setPriceForm((f) => ({ ...f, [p.id]: { ...f[p.id], price50ml: e.target.value } }))}
                      style={{ ...inputStyle, width: 70 }} />
                    <input type="number" value={priceForm[p.id]?.price100ml ?? ''} placeholder="100ml $"
                      onChange={(e) => setPriceForm((f) => ({ ...f, [p.id]: { ...f[p.id], price100ml: e.target.value } }))}
                      style={{ ...inputStyle, width: 70 }} />
                    <button onClick={() => savePrice(p.id)} style={{ ...buttonPrimary, padding: '6px 10px', fontSize: 11 }}>Save</button>
                  </div>
                ))}

                <h3 style={{ margin: '24px 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Social Proof Number</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <label style={{ fontSize: 11 }}>Base count
                    <input type="number" value={socialForm.baseCount ?? 0} onChange={(e) => setSocialForm((f: any) => ({ ...f, baseCount: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginTop: 20 }}>
                    <input type="checkbox" checked={socialForm.autoIncrementEnabled !== false} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementEnabled: e.target.checked }))} />
                    Auto-increment hype ticks
                  </label>
                  <label style={{ fontSize: 11 }}>Max ticks/day
                    <input type="number" value={socialForm.autoIncrementMaxPerDay ?? 4} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMaxPerDay: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ fontSize: 11 }}>Min hours between ticks
                    <input type="number" value={socialForm.autoIncrementMinHourGap ?? 3} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMinHourGap: Number(e.target.value) }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                </div>
                <button onClick={saveSocial} style={buttonPrimary}>Save Social Proof</button>
                {configMsg && <p style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10 }}>{configMsg}</p>}
              </div>
            )}
          </div>
        )}

        {/* ============ ORDERS ============ */}
        {tab === 'orders' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Open Orders ({orders.length})</h2>
              <button onClick={fetchOrders} disabled={ordersLoading} style={buttonGhost}>{ordersLoading ? 'Loading…' : 'Refresh'}</button>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
              Every currently-active entry across every product. Cancel or edit any order directly — useful for resolving support requests without needing the customer's card details.
            </p>
            <input placeholder="Search by email, product, or promo code…" value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)}
              style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />
            {orderMsg && <p style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 10 }}>{orderMsg}</p>}
            {filteredOrders.length === 0 && !ordersLoading && (
              <p style={{ color: '#555', fontSize: 13, textAlign: 'center', border: '1px dashed #222', padding: 24, borderRadius: 12 }}>
                {orders.length === 0 ? 'No open orders, or click Refresh to load.' : 'No orders match your search.'}
              </p>
            )}
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {filteredOrders.map((o) => {
                const key = `${o.variant}-${o.size}-${o.email}`;
                return (
                  <div key={key} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ fontWeight: 600 }}>{o.email}</div>
                      <div style={{ color: '#34d399' }}>{o.variant} — {o.size}</div>
                    </div>
                    <div style={{ color: '#666', marginTop: 4 }}>
                      📍 {revealAddresses ? o.shippingAddress || 'n/a' : '•••• hidden'}
                      {o.cardLast4 && <span> · card ••{o.cardLast4}</span>}
                      {o.promoCode && <span style={{ color: '#edb210' }}> · promo {o.promoCode}</span>}
                    </div>
                    {editingOrderKey === key ? (
                      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                        <input value={orderAddressDraft} onChange={(e) => setOrderAddressDraft(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                        <button onClick={() => saveOrderAddress(o)} style={{ ...buttonPrimary, background: '#34d399', padding: '8px 12px', fontSize: 11 }}>Save</button>
                        <button onClick={() => setEditingOrderKey(null)} style={{ ...buttonGhost, padding: '8px 12px' }}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={() => { setEditingOrderKey(key); setOrderAddressDraft(o.shippingAddress); }} style={buttonGhost}>Edit Address</button>
                        <button onClick={() => cancelOrder(o)} style={{ ...buttonGhost, border: '1px solid #f87171', color: '#f87171' }}>Cancel Order</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============ GROWTH ============ */}
        {tab === 'growth' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Abandoned Entry Recovery</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Emails people who started but never finished checkout — an early nudge, and an optional pre-draw reminder. Sends at most twice per person per product. Runs hourly via your Upstash QStash schedule.
              </p>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={recovery.enabled} onChange={(e) => setRecovery((r) => ({ ...r, enabled: e.target.checked }))} />
                  Enable early nudge
                </label>
                <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={recovery.preDrawEnabled} onChange={(e) => setRecovery((r) => ({ ...r, preDrawEnabled: e.target.checked }))} />
                  Enable pre-draw reminder
                </label>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
                <label style={{ fontSize: 11 }}>Early nudge delay (hours)
                  <input type="number" value={recovery.earlyDelayHours} onChange={(e) => setRecovery((r) => ({ ...r, earlyDelayHours: Number(e.target.value) }))}
                    style={{ ...inputStyle, display: 'block', width: 80, marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11 }}>Pre-draw window (hours)
                  <input type="number" value={recovery.preDrawHours} onChange={(e) => setRecovery((r) => ({ ...r, preDrawHours: Number(e.target.value) }))}
                    style={{ ...inputStyle, display: 'block', width: 80, marginTop: 4 }} />
                </label>
              </div>
              <button onClick={saveRecovery} style={{ ...buttonPrimary, marginTop: 12 }}>Save Recovery Settings</button>
              {recoveryMsg && <p style={{ fontSize: 12, color: '#34d399' }}>{recoveryMsg}</p>}
            </div>

            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Promoter / Affiliate Codes</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Share <code style={{ color: '#aaa' }}>/product-slug?ref=CODE</code>. Applies automatically for the customer's session, blocks self-use by the promoter's own email, and emails the promoter an invoice the moment their code produces a paid winner. Payouts are tracked here — actually sending the money still happens outside this system (Venmo/PayPal/bank), then mark it paid below.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <input placeholder="Code" value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputStyle} />
                <input placeholder="Promoter Name" value={promoForm.promoterName} onChange={(e) => setPromoForm((f) => ({ ...f, promoterName: e.target.value }))} style={inputStyle} />
                <input placeholder="Promoter Email" value={promoForm.promoterEmail} onChange={(e) => setPromoForm((f) => ({ ...f, promoterEmail: e.target.value }))} style={inputStyle} />
                <input placeholder="Customer Discount %" value={promoForm.customerDiscountPercent} onChange={(e) => setPromoForm((f) => ({ ...f, customerDiscountPercent: e.target.value }))} style={inputStyle} />
                <input placeholder="Promoter Payout %" value={promoForm.promoterPayoutPercent} onChange={(e) => setPromoForm((f) => ({ ...f, promoterPayoutPercent: e.target.value }))} style={inputStyle} />
                <input placeholder="Max uses per email (1=once, 0=unlimited)" value={promoForm.maxUsesPerEmail} onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesPerEmail: e.target.value }))} style={inputStyle} />
              </div>
              <button onClick={savePromo} style={buttonPrimary}>{promoForm.code && promos.some((p) => p.code === promoForm.code) ? 'Update Promo' : 'Create Promo'}</button>
              {promoMsg && <p style={{ fontSize: 12, color: '#34d399' }}>{promoMsg}</p>}

              <div style={{ marginTop: 16 }}>
                {promos.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No promo codes yet.</p>}
                {promos.map((p) => (
                  <div key={p.code} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 700 }}>{p.code} {!p.active && <span style={{ color: '#f87171' }}>(disabled)</span>}</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => setPromoForm({
                          code: p.code, promoterName: p.promoterName, promoterEmail: p.promoterEmail,
                          customerDiscountPercent: String(p.customerDiscountPercent), promoterPayoutPercent: String(p.promoterPayoutPercent), maxUsesPerEmail: String(p.maxUsesPerEmail ?? 1),
                        })} style={buttonGhost}>Edit</button>
                        <button onClick={async () => {
                          if (!password) return alert('Enter password');
                          await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'toggle', code: p.code }) });
                          await fetchPromos();
                        }} style={{ ...buttonGhost, border: `1px solid ${p.active ? '#f87171' : '#34d399'}`, color: p.active ? '#f87171' : '#34d399' }}>
                          {p.active ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    </div>
                    <div style={{ color: '#888' }}>{p.promoterName} · {p.promoterEmail || 'no email on file'}</div>
                    <div style={{ color: '#aaa', marginTop: 4 }}>
                      {p.clicks || 0} link opens · {p.uses || 0} entries · ${Number(p.revenueAttributed || 0).toFixed(0)} attributed revenue · owed ${((p.payoutOwedCents || 0) / 100).toFixed(2)} · {p.promoterPayoutPercent}% payout · {p.customerDiscountPercent}% discount
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      {p.payoutOwedCents > 0 && (
                        <button onClick={async () => {
                          if (!password) return alert('Enter password');
                          if (!confirm(`Mark $${((p.payoutOwedCents || 0) / 100).toFixed(2)} as paid to ${p.promoterName}? Only do this after you've actually sent the money.`)) return;
                          await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'markPaid', code: p.code }) });
                          await fetchPromos();
                        }} style={{ fontSize: 11, color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                          Mark ${((p.payoutOwedCents || 0) / 100).toFixed(2)} as paid
                        </button>
                      )}
                      <button onClick={() => deletePromo(p.code)} style={{ fontSize: 11, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ============ LEDGER ============ */}
        {tab === 'ledger' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Full Ledger</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>Every event, ever, for every entry — nothing is deleted. Filter by type or search freely.</p>
            <select value={ledgerTypeFilter} onChange={(e) => setLedgerTypeFilter(e.target.value)} style={{ ...inputStyle, width: '100%', marginBottom: 10 }}>
              <option value="ALL">All event types</option>
              <option value="ENTERED">Entered</option>
              <option value="WINNER_CHARGED">Won & Charged</option>
              <option value="NOT_SELECTED">Not Selected</option>
              <option value="WINNER_DECLINED">Charge Declined</option>
              <option value="CANCELLED_BY_USER">Cancelled (Customer)</option>
              <option value="CANCELLED_BY_ADMIN">Cancelled (Admin)</option>
              <option value="INTENT_STARTED">Started (Unfinished)</option>
              <option value="ADDRESS_UPDATED">Address Changed</option>
            </select>
            <input placeholder="Search email, product, or address…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />
            {isSearching && <p style={{ fontSize: 11, color: '#666' }}>Searching…</p>}
            <div>
              {currentEntries.map((e: any, i: number) => (
                <div key={i} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>{e.email}</div>
                  <div style={{ color: '#888' }}>
                    {e.variant} · {e.size} · <span style={{ color: typeColor(e.type), fontWeight: 700 }}>{typeLabel(e.type)}</span>
                    {e.promoCode && <span style={{ color: '#edb210', marginLeft: 6 }}>· promo {e.promoCode}</span>}
                  </div>
                  <div style={{ color: '#666', marginTop: 4 }}>{revealAddresses ? e.shippingAddress || 'n/a' : '•••• hidden'}</div>
                  {e.type === 'WINNER_CHARGED' && (
                    <select defaultValue={e.shippingStatus || 'PENDING_FULFILLMENT'} onChange={(ev) => updateShipping(e, ev.target.value)}
                      style={{ ...inputStyle, marginTop: 8, padding: 6 }}>
                      {SHIP_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                    </select>
                  )}
                </div>
              ))}
            </div>
            {shipMsg && <p style={{ fontSize: 11, color: '#34d399' }}>{shipMsg}</p>}
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)} style={buttonGhost}>Prev</button>
                <span style={{ fontSize: 12, color: '#888' }}>{currentPage}/{totalPages}</span>
                <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => p + 1)} style={buttonGhost}>Next</button>
              </div>
            )}
          </div>
        )}

        {/* ============ SYSTEM ============ */}
        {tab === 'system' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Site Self-Test</h2>
                <button onClick={runSelftest} disabled={selftestRunning} style={buttonPrimary}>
                  {selftestRunning ? 'Running…' : 'Run All Checks'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
                Checks every environment variable, Stripe/Redis connectivity, every product's schedule/price/Stripe ID, and slug uniqueness — run this after any config change or before a big drop.
              </p>
              {selftestResults?.error && <p style={{ color: '#f87171', fontSize: 12 }}>{selftestResults.error}</p>}
              {selftestResults?.results && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: selftestResults.allPassed ? '#34d399' : '#f87171' }}>
                    {selftestResults.summary} {selftestResults.allPassed ? '✓' : '— fix the items below'}
                  </div>
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {selftestResults.results.map((r: any, i: number) => (
                      <div key={i} style={{
                        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px',
                        background: r.pass ? 'transparent' : 'rgba(248,113,113,0.08)', borderRadius: 8, marginBottom: 2,
                      }}>
                        <span style={{ color: r.pass ? '#34d399' : '#f87171', fontSize: 13, marginTop: 1 }}>{r.pass ? '✓' : '✗'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{r.name}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{r.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Admin Action Audit Log</h2>
                <button onClick={fetchAudit} style={buttonGhost}>Refresh</button>
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 10, fontSize: 11, color: '#888' }}>
                {audit.length === 0 && <p>No audit entries loaded (requires password).</p>}
                {audit.map((a, i) => <div key={i} style={{ marginBottom: 6 }}>{a.at} — {a.action} {a.detail || ''}</div>)}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
