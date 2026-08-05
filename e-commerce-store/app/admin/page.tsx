'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

type Tab = 'overview' | 'drops' | 'ledger' | 'growth' | 'system' | 'settings' | 'products';

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

function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: 'include' });
}

export default function AdminPortal() {
  const [tab, setTab] = useState<Tab>('overview');
  const [drawsSub, setDrawsSub] = useState<'run' | 'automation'>('run');
  const [password, setPassword] = useState('');
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [pulseTick, setPulseTick] = useState(0);
  const [revealAddresses, setRevealAddresses] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [selectedDrawTarget, setSelectedDrawTarget] = useState('ALL_POOLS');

  const [invEdits, setInvEdits] = useState<Record<string, string>>({});
  const [winnersEdits, setWinnersEdits] = useState<Record<string, string>>({});
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
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('ALL');
  const [shipMsg, setShipMsg] = useState('');
  const [editingAddressEntry, setEditingAddressEntry] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');

  const [recovery, setRecovery] = useState({ enabled: true, earlyDelayHours: 3, preDrawHours: 6, preDrawEnabled: true });
  const [recoveryMsg, setRecoveryMsg] = useState('');

  const [promos, setPromos] = useState<any[]>([]);
  const [promoForm, setPromoForm] = useState({
    code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '',
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
  
  const [drawHistory, setDrawHistory] = useState<any[]>([]);
  const [drawHistoryLoading, setDrawHistoryLoading] = useState(false);
  const [expandedDraw, setExpandedDraw] = useState<number | null>(null);

  // Products state
  const [products, setProducts] = useState<any[]>([]);
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<any>({
    name: '', slug: '', prefix: '', tagline: '', desc: '',
    price50ml: '', price100ml: '', stripeId50ml: '', stripeId100ml: '',
    maxRaffleAllocationLimit: '', totalInventory: '', winnerTiers: '',
    isActive: true, isArchived: false, isUpcoming: false, notes: [], images: []
  });
  const [productMsg, setProductMsg] = useState('');
  const [showProductForm, setShowProductForm] = useState(false);
  const [imageInput, setImageInput] = useState('');
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null);
  const [noteForm, setNoteForm] = useState({ label: '', name: '', text: '' });
  const [productActionLoading, setProductActionLoading] = useState(false);

  const [themeSettings, setThemeSettings] = useState(GOYUNIR_STORE_SUITE.themeColors);
  const [heroSettings, setHeroSettings] = useState(GOYUNIR_STORE_SUITE.heroContent);
  const [formSettings, setFormSettings] = useState(GOYUNIR_STORE_SUITE.raffleRegistrationForm);
  const [footerSettings, setFooterSettings] = useState(GOYUNIR_STORE_SUITE.brandFooterData);
  const [productNotes, setProductNotes] = useState<Record<string, any[]>>({});
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2800);
  };

  // ============================================================
  // FETCH FUNCTIONS
  // ============================================================

  const fetchStatus = async () => {
    try {
      const res = await adminFetch(`/api/admin/status?t=${Date.now()}`);
      if (res.status === 401 || res.status === 403) {
        setAuthFailed(true);
        window.location.href = '/';
        return;
      }
      const data = await res.json();
      setStatus(data);
      setLastUpdatedAt(Date.now());
      setPulseTick((t) => t + 1);
    } catch {
      setStatus({ error: 'Unable to fetch status' });
    }
  };

  const refreshAll = async () => {
    setIsRefreshing(true);
    await Promise.all([
      fetchStatus(),
      fetchCatalogStatus(),
      fetchRecovery(),
      fetchPromos(),
      fetchConfig(),
      fetchDrawHistory(),
      fetchSettings(),
      fetchProducts(),
    ]);
    setIsRefreshing(false);
    showToast('🔄 All data refreshed');
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
        preDrawHours: data.preDrawHours ?? 6,
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
    if (!password) {
      setAudit([]);
      return;
    }
    try {
      const res = await adminFetch(`/api/admin/audit?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setAudit(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      console.error('[Audit] Error:', err);
      setAudit([]);
    }
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
      
      const notes: Record<string, any[]> = {};
      for (const p of GOYUNIR_STORE_SUITE.productCatalog) {
        notes[p.id] = p.notes || [];
      }
      setProductNotes(notes);
    } catch {}
  };

  const fetchDrawHistory = async () => {
    setDrawHistoryLoading(true);
    try {
      const res = await adminFetch('/api/admin/draw-history');
      const data = await res.json();
      if (Array.isArray(data.draws)) setDrawHistory(data.draws);
    } catch {}
    setDrawHistoryLoading(false);
  };

  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await adminFetch('/api/admin/settings');
      const data = await res.json();
      if (data.settings) {
        if (data.settings.theme) setThemeSettings(data.settings.theme);
        if (data.settings.hero) setHeroSettings(data.settings.hero);
        if (data.settings.form) setFormSettings(data.settings.form);
        if (data.settings.footer) setFooterSettings(data.settings.footer);
        if (data.settings.productNotes) setProductNotes(data.settings.productNotes);
      }
      setSettingsMsg('');
    } catch (err: any) {
      setSettingsMsg('Could not load settings: ' + err.message);
    }
    setSettingsLoading(false);
  };

  const fetchProducts = async () => {
    setProductsLoading(true);
    try {
      const res = await adminFetch('/api/admin/products?includeArchived=true');
      const data = await res.json();
      if (data.products) {
        setAllProducts(data.products);
        setProducts(data.products.filter((p: any) => !p.isArchived && !p.isUpcoming));
      }
    } catch (err) {
      console.error('[Products] Fetch error:', err);
    }
    setProductsLoading(false);
  };

  // ============================================================
  // PRODUCT FUNCTIONS
  // ============================================================

  const resetProductForm = () => {
    setProductForm({
      name: '', slug: '', prefix: '', tagline: '', desc: '',
      price50ml: '', price100ml: '', stripeId50ml: '', stripeId100ml: '',
      maxRaffleAllocationLimit: '', totalInventory: '', winnerTiers: '',
      isActive: true, isArchived: false, isUpcoming: false, notes: [], images: []
    });
    setEditingProduct(null);
    setEditingNoteIdx(null);
    setNoteForm({ label: '', name: '', text: '' });
    setImageInput('');
  };

  const editProduct = (product: any) => {
    setEditingProduct(product.id);
    setProductForm({
      ...product,
      price50ml: product.price50ml || '',
      price100ml: product.price100ml || '',
      maxRaffleAllocationLimit: product.maxRaffleAllocationLimit || '',
      totalInventory: product.totalInventory || '',
      winnerTiers: product.winnerTiers ? product.winnerTiers.join(',') : '',
      notes: product.notes || [],
      images: product.images || [],
      isUpcoming: product.isUpcoming || false,
    });
    setShowProductForm(true);
  };

  const saveProduct = async () => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!productForm.name) { alert('Product name is required'); return; }
    
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          action: 'upsert',
          ...productForm,
          price50ml: Number(productForm.price50ml) || 0,
          price100ml: Number(productForm.price100ml) || 0,
          maxRaffleAllocationLimit: Number(productForm.maxRaffleAllocationLimit) || 0,
          totalInventory: Number(productForm.totalInventory) || 0,
          winnerTiers: productForm.winnerTiers ? productForm.winnerTiers.split(',').map(Number) : [0],
          notes: productForm.notes || [],
          images: productForm.images || [],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setProductMsg(`✅ Product "${data.product.name}" saved successfully!`);
        showToast('UPDATED · Product');
        await fetchProducts();
        setShowProductForm(false);
        resetProductForm();
      } else {
        setProductMsg('❌ Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setProductMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const deleteProduct = async (id: string) => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!confirm('Are you sure you want to delete this product? This cannot be undone.')) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'delete', id }),
      });
      if (res.ok) {
        showToast('DELETED · Product');
        await fetchProducts();
      } else {
        const data = await res.json();
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const toggleArchive = async (id: string, currentArchived: boolean) => {
    if (!password) { alert('Enter admin password first'); return; }
    const action = currentArchived ? 'unarchive' : 'archive';
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentArchived ? 'Unarchived' : 'Archived'}`);
        await fetchProducts();
        await fetchCatalogStatus();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const toggleActive = async (id: string, currentActive: boolean) => {
    if (!password) { alert('Enter admin password first'); return; }
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'toggleActive', id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentActive ? 'Hidden' : 'Visible'}`);
        await fetchProducts();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const toggleUpcoming = async (id: string, currentUpcoming: boolean) => {
    if (!password) { alert('Enter admin password first'); return; }
    const action = currentUpcoming ? 'moveToActive' : 'moveToUpcoming';
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentUpcoming ? 'Moved to Active' : 'Moved to Upcoming'}`);
        await fetchProducts();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const addNote = () => {
    if (!noteForm.label || !noteForm.name) return;
    setProductForm((prev: any) => ({
      ...prev,
      notes: [...prev.notes, { ...noteForm }]
    }));
    setNoteForm({ label: '', name: '', text: '' });
    setEditingNoteIdx(null);
  };

  const removeNote = (idx: number) => {
    setProductForm((prev: any) => ({
      ...prev,
      notes: prev.notes.filter((_: any, i: number) => i !== idx)
    }));
  };

  const editNote = (idx: number) => {
    setEditingNoteIdx(idx);
    setNoteForm(productForm.notes[idx]);
  };

  const addImage = async () => {
    if (!imageInput.trim()) return;
    if (!editingProduct) return;
    try {
      const res = await adminFetch('/api/admin/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          productId: editingProduct,
          action: 'add',
          images: [imageInput.trim()]
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setProductForm((prev: any) => ({ ...prev, images: data.images }));
        setImageInput('');
        await fetchProducts();
        showToast('UPDATED · Image added');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const removeImage = async (index: number) => {
    if (!editingProduct) return;
    try {
      const res = await adminFetch('/api/admin/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          productId: editingProduct,
          action: 'remove',
          index
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setProductForm((prev: any) => ({ ...prev, images: data.images }));
        await fetchProducts();
        showToast('UPDATED · Image removed');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const seedDefaultProducts = async () => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!confirm('This will seed default placeholder products into Redis. Existing products will NOT be overwritten. Continue?')) return;
    setProductActionLoading(true);
    try {
      const res = await adminFetch(`/api/admin/seed?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      if (res.ok) {
        setProductMsg('✅ ' + data.message);
        showToast('SEEDED · Default products');
        await fetchProducts();
      } else {
        setProductMsg('❌ Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setProductMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // ============================================================
  // OTHER FUNCTIONS
  // ============================================================

  const saveSchedule = async () => {
    if (!password) return alert('Enter password');
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'schedule', value: scheduleForm }),
    });
    if (res.ok) { setConfigMsg('Schedule saved — live immediately, no redeploy needed.'); showToast('UPDATED · Schedule'); } else setConfigMsg('Failed to save schedule.');
  };

  const saveSocial = async () => {
    if (!password) return alert('Enter password');
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'socialProof', value: socialForm }),
    });
    if (res.ok) { setConfigMsg('Social proof settings saved.'); showToast('UPDATED · Social proof'); } else setConfigMsg('Failed to save.');
  };

  const savePrice = async (productId: string) => {
    if (!password) return alert('Enter password');
    const v = priceForm[productId];
    const res = await adminFetch('/api/admin/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, section: 'product', productId, value: { price50ml: Number(v.price50ml), price100ml: Number(v.price100ml) } }),
    });
    if (res.ok) { setConfigMsg(`Price saved for ${productId}.`); showToast('UPDATED · Price'); } else setConfigMsg('Failed to save price.');
  };

  const runSelftest = async () => {
    if (!password) return alert('Enter password');
    setSelftestRunning(true);
    setSelftestResults(null);
    try {
      const res = await adminFetch(`/api/admin/self-test?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setSelftestResults(data);
    } catch {
      setSelftestResults({ error: 'Could not run self-test — connection failed.' });
    } finally {
      setSelftestRunning(false);
    }
  };

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
      if (res.ok) {
        const ds = data.drawSummary || {};
        const winners = ds.processedWinners || [];
        const charged = winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged');
        const revenue = (ds.totalRevenueCents != null
          ? ds.totalRevenueCents
          : charged.reduce((sum: number, w: any) => sum + (Number(w.amountCents) || 0), 0)) / 100;
        const lines = [
          `Done · ${ds.totalSuccessfulCharges ?? charged.length} charged`,
          ds.executionTime ? `Time: ${ds.executionTime}` : '',
          revenue > 0 ? `Revenue: $${revenue.toFixed(2)}` : '',
          ...charged.slice(0, 8).map((w: any) =>
            `${w.email} · ${w.product || ''} ${w.size || ''} · $${((w.amountCents || 0) / 100).toFixed(2)}${w.promoCode ? ` · promo ${w.promoCode}` : ''}`
          ),
          ...winners.filter((w: any) => w.status && w.status !== 'SUCCESS_CHARGED' && w.status !== 'charged').slice(0, 5).map((w: any) =>
            `${w.email}: ${w.status}`
          ),
        ].filter(Boolean);
        setResultMessage(lines.join('\n'));
        showToast('UPDATED · Draw complete');
        await fetchStatus();
        await fetchDrawHistory();
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
    const payload: any = { password, productName, size, productId };
    if (invEdits[key] !== undefined && invEdits[key] !== '') {
      const value = Number(invEdits[key]);
      if (!Number.isFinite(value) || value < 0) return alert('Invalid inventory number');
      payload.inventoryRemaining = value;
    }
    if (winnersEdits[key] !== undefined && winnersEdits[key] !== '') {
      let w = Number(winnersEdits[key]);
      if (!Number.isFinite(w) || w < 0) return alert('Winners per draw must be 0 or more');
      w = Math.floor(w);
      const invCap = payload.inventoryRemaining !== undefined
        ? payload.inventoryRemaining
        : Number(pools.find((p: any) => p.product === productName && p.size === size)?.maxLimit ?? 0);
      if (w > invCap && invCap > 0) {
        alert(`Winners per draw cannot exceed inventory left (${invCap}). Capping to ${Math.max(0, invCap)}.`);
        w = Math.max(0, invCap);
      }
      payload.winnersPerDraw = w;
    }
    if (payload.inventoryRemaining === undefined && payload.winnersPerDraw === undefined) {
      return alert('Enter inventory and/or winners per draw');
    }
    try {
      const res = await adminFetch('/api/admin/inventory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        const parts = [];
        if (payload.inventoryRemaining !== undefined) parts.push(`${payload.inventoryRemaining} left`);
        if (payload.winnersPerDraw !== undefined) parts.push(`${payload.winnersPerDraw} winners/draw`);
        setInvMessage(`Saved ${productName} ${size} → ${parts.join(' · ')}`);
        showToast('UPDATED · Inventory / draw size');
        await fetchStatus();
      } else setInvMessage(data.error || 'Failed');
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

  const updateAddress = async (entry: any, newAddress: string) => {
    if (!password) return alert('Enter password');
    setShipMsg('Updating address…');
    try {
      const res = await adminFetch('/api/admin/update-address', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          password, 
          email: entry.email, 
          variant: entry.variant, 
          size: entry.size, 
          newAddress
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShipMsg('Address updated.');
        showToast('UPDATED · Address');
        await fetchStatus();
        setEditingAddressEntry(null);
      } else setShipMsg(data.error || 'Failed: ' + (data.error || 'Unknown error'));
    } catch (err: any) {
      setShipMsg('Failed: ' + err.message);
    }
  };

  const saveRecovery = async () => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/recovery-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...recovery }) });
      const data = await res.json();
      if (res.ok) { setRecoveryMsg('Recovery settings saved.'); showToast('UPDATED · Recovery'); } else setRecoveryMsg(data.error || 'Failed');
    } catch {
      setRecoveryMsg('Failed');
    }
  };

  const savePromo = async () => {
    if (!password) return alert('Enter password');
    const customerDiscount = Number(promoForm.customerDiscountPercent);
    const promoterPayout = Number(promoForm.promoterPayoutPercent);
    const maxUses = Number(promoForm.maxUsesPerEmail);
    
    if (isNaN(customerDiscount) || customerDiscount < 0 || customerDiscount > 50) {
      return alert('Customer discount must be between 0 and 50');
    }
    if (isNaN(promoterPayout) || promoterPayout < 0 || promoterPayout > 50) {
      return alert('Promoter payout must be between 0 and 50');
    }
    if (isNaN(maxUses) || maxUses < 0) {
      return alert('Max uses must be 0 or more');
    }
    
    try {
      const res = await adminFetch('/api/admin/promos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password, action: 'upsert', code: promoForm.code, promoterName: promoForm.promoterName, promoterEmail: promoForm.promoterEmail,
          customerDiscountPercent: customerDiscount, promoterPayoutPercent: promoterPayout, maxUsesPerEmail: maxUses, active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPromoMsg(`Saved ${data.promo?.code}.`); showToast('UPDATED · Promo');
        setPromoForm({ code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '' });
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

  const cancelOrder = async (entry: any) => {
    if (!password) return alert('Enter password');
    const reason = prompt(`Cancel ${entry.email}'s entry for ${entry.variant} (${entry.size})? Optional reason:`);
    if (reason === null) return;
    try {
      const res = await adminFetch('/api/admin/cancel-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, variant: entry.variant, size: entry.size, email: entry.email, reason }),
      });
      const data = await res.json();
      if (res.ok) { setShipMsg('Entry cancelled.'); await fetchStatus(); } else setShipMsg(data.error || 'Failed.');
    } catch {
      setShipMsg('Connection failed.');
    }
  };

  const saveSettings = async () => {
    if (!password) return alert('Enter password');
    setSettingsLoading(true);
    try {
      const res = await adminFetch('/api/admin/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          theme: themeSettings,
          hero: heroSettings,
          form: formSettings,
          footer: footerSettings,
          productNotes,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSettingsMsg('Settings saved successfully!');
        showToast('UPDATED · Settings');
      } else setSettingsMsg(data.error || 'Failed to save settings.');
    } catch (err: any) {
      setSettingsMsg('Connection failed: ' + err.message);
    }
    setSettingsLoading(false);
  };

  // ============================================================
  // USE EFFECTS
  // ============================================================

  useEffect(() => {
    fetchStatus();
    fetchCatalogStatus();
    fetchRecovery();
    fetchPromos();
    fetchProducts();
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

  const totalOwed = promos.reduce((s, p) => s + (p.payoutOwedCents || 0), 0);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'drops', label: 'Drops' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'products', label: 'Products', badge: allProducts.filter(p => !p.isArchived && !p.isUpcoming).length || undefined },
    { id: 'growth', label: 'Growth' },
    { id: 'system', label: 'System' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <main style={{ minHeight: '100vh', padding: '28px 16px 60px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>GOYUNIR Admin</h1>
            {toast ? (
              <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 200, background: '#14532d', color: '#bbf7d0', border: '1px solid #22c55e', padding: '10px 16px', borderRadius: 12, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
                {toast}
              </div>
            ) : null}
            <p style={{ color: '#888', margin: '6px 0 0', fontSize: 12 }}>
              {lastUpdatedAt ? `Updated ${secondsAgo}s ago` : 'Loading…'} ·{' '}
              <span style={{ color: status?.stripeConfigured ? '#34d399' : '#f87171' }}>Stripe</span> ·{' '}
              <span style={{ color: status?.redisConfigured ? '#34d399' : '#f87171' }}>Redis</span>{' · '}<span style={{ color: status?.resendConfigured ? '#34d399' : '#f87171' }}>Resend</span> ·{' '}
              <span style={{ color: '#34d399' }}>{status?.liveActiveUsersOnline ?? 0} online</span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={refreshAll} disabled={isRefreshing} style={{ ...buttonGhost, padding: '6px 12px' }}>
              {isRefreshing ? '⟳' : '🔄 Refresh'}
            </button>
            <Link href="/" style={{ color: '#888', fontSize: 12, textDecoration: 'none', padding: '6px 0' }}>← Store</Link>
          </div>
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
                if (t.id === 'system') { if (password) fetchAudit(); fetchDrawHistory(); }
                if (t.id === 'drops') fetchConfig();
                if (t.id === 'drops' && drawsSub === 'run') fetchDrawHistory();
                if (t.id === 'settings') fetchSettings();
                if (t.id === 'products') fetchProducts();
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

        {/* ============ DROPS ============ */}
        {tab === 'drops' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['run', 'automation'] as const).map((s) => (
                <button key={s} onClick={() => { setDrawsSub(s); if (s === 'automation') fetchConfig(); if (s === 'run') fetchDrawHistory(); }}
                  style={{ ...buttonGhost, border: drawsSub === s ? '1px solid #fff' : '1px solid #333', background: drawsSub === s ? '#1c1c1e' : 'transparent', textTransform: 'capitalize' }}>
                  {s === 'run' ? 'Run Draw' : 'Automation'}
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
                  {allProducts.map((p) =>
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
                {resultMessage && <pre style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10, whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#09090b', padding: 12, borderRadius: 10 }}>{resultMessage}</pre>}
                
                <div style={{ marginTop: 16, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ color: '#888' }}>Draw History</div>
                    <button onClick={fetchDrawHistory} disabled={drawHistoryLoading} style={buttonGhost}>
                      {drawHistoryLoading ? 'Loading…' : 'Refresh'}
                    </button>
                  </div>
                  {drawHistory.length === 0 && !drawHistoryLoading && (
                    <p style={{ color: '#555' }}>No draws have been run yet.</p>
                  )}
                  {drawHistoryLoading && <p style={{ color: '#555' }}>Loading history…</p>}
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {drawHistory.map((draw: any, idx: number) => {
                      const isExpanded = expandedDraw === idx;
                      const winners = draw.processedWinners || [];
                      const chargedCount = winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged').length;
                      const totalRevenue = draw.totalRevenueCents != null ? draw.totalRevenueCents : 
                        winners.filter((w: any) => w.status === 'SUCCESS_CHARGED' || w.status === 'charged')
                          .reduce((s: number, w: any) => s + (Number(w.amountCents) || 0), 0);
                      
                      return (
                        <div key={idx} style={{ background: '#09090b', padding: 12, borderRadius: 8, marginBottom: 8 }}>
                          <div 
                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                            onClick={() => setExpandedDraw(isExpanded ? null : idx)}
                          >
                            <span style={{ color: '#34d399', fontWeight: 600 }}>
                              Draw #{draw.drawNumber || idx + 1}
                              {draw.executionTime ? ` · ${draw.executionTime}` : ''}
                            </span>
                            <span style={{ color: '#888', fontSize: 11 }}>
                              {chargedCount} charged · ${(totalRevenue / 100).toFixed(2)}
                              <span style={{ marginLeft: 8 }}>{isExpanded ? '▼' : '▶'}</span>
                            </span>
                          </div>
                          {isExpanded && (
                            <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
                              {winners.length === 0 && <div style={{ color: '#555', fontSize: 11 }}>No winners recorded.</div>}
                              {winners.map((w: any, wi: number) => (
                                <div key={wi} style={{ fontSize: 11, color: '#666', marginTop: 4, paddingLeft: 8, borderLeft: '2px solid #222' }}>
                                  {w.email} · {w.product || w.variant || ''} {w.size || ''}
                                  {w.status === 'SUCCESS_CHARGED' || w.status === 'charged' ? (
                                    <span style={{ color: '#34d399' }}> ✓ ${((w.amountCents || 0) / 100).toFixed(2)}</span>
                                  ) : (
                                    <span style={{ color: '#f87171' }}> ✗ {w.status}</span>
                                  )}
                                  {w.promoCode && <span style={{ color: '#edb210', marginLeft: 4 }}>· {w.promoCode}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {drawsSub === 'automation' && (
              <div style={cardStyle}>
                <h3 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase' }}>Automation</h3>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>Schedule and social proof settings — overrides goyunir.config.ts live, no redeploy needed.</p>
                
                <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Drop Schedule</h4>
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
                {configMsg && <p style={{ fontSize: 12, color: '#cbd5e1', marginTop: 10 }}>{configMsg}</p>}

                <h4 style={{ fontSize: 11, color: '#aaa', margin: '20px 0 8px', textTransform: 'uppercase' }}>Social Proof Counter</h4>
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

                <h4 style={{ fontSize: 11, color: '#aaa', margin: '20px 0 8px', textTransform: 'uppercase' }}>Abandoned Entry Recovery</h4>
                <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                  When someone starts an entry (enters email + address) but doesn't complete card setup in Stripe, this system sends them reminder emails to finish. The "early nudge" goes out a few hours after they start, and the "pre-draw reminder" goes out before the allocation closes (default 6 hours before). Each person gets at most one of each type per product, so they won't be spammed.
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
            )}
          </div>
        )}

        {/* ============ LEDGER ============ */}
        {tab === 'ledger' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Full Ledger</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>Every event, ever, for every entry — nothing is deleted. Filter, search, and manage entries directly.</p>
            
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <select value={ledgerTypeFilter} onChange={(e) => setLedgerTypeFilter(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 120 }}>
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
            </div>
            <input placeholder="Search email, product, or address…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />
            {isSearching && <p style={{ fontSize: 11, color: '#666' }}>Searching…</p>}
            {shipMsg && <p style={{ fontSize: 12, color: '#34d399', marginBottom: 10 }}>{shipMsg}</p>}
            
            <div>
              {currentEntries.map((e: any, i: number) => {
                const entryKey = `${e.email}|${e.variant}|${e.size}|${i}`;
                const isEditingAddress = editingAddressEntry === entryKey;
                const orderRef = e.orderRef || `GOY-${new Date(e.registeredAt || 0).getTime().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
                const displayPrice = e.amountCents ? (e.amountCents / 100).toFixed(2) : (e.listPrice || 0).toFixed(2);
                
                return (
                  <div key={i} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 600 }}>{e.email}</div>
                    <div style={{ color: '#666', fontSize: 10 }}>Ref: {orderRef}</div>
                    <div style={{ color: '#888' }}>
                      {e.variant} · {e.size} · <span style={{ color: typeColor(e.type), fontWeight: 700 }}>{typeLabel(e.type)}</span>
                      {e.promoCode && <span style={{ color: '#edb210', marginLeft: 6 }}>· promo {e.promoCode}</span>}
                      {(e.amountCents || e.listPrice) && (
                        <span style={{ color: '#34d399', marginLeft: 6 }}>· ${displayPrice}</span>
                      )}
                    </div>
                    <div style={{ color: '#666', marginTop: 4 }}>
                      📍 {revealAddresses ? e.shippingAddress || 'n/a' : '•••• hidden'}
                      {e.cardLast4 && <span style={{ marginLeft: 6 }}>💳 ••{e.cardLast4}</span>}
                    </div>
                    {(e.type === 'WINNER_CHARGED' || e.type === 'ENTERED') && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {isEditingAddress ? (
                          <>
                            <input type="text" value={addressDraft} onChange={(ev) => setAddressDraft(ev.target.value)}
                              placeholder="New address" style={{ ...inputStyle, padding: 6, flex: 2 }} />
                            <button onClick={() => updateAddress(e, addressDraft)} style={{ ...buttonPrimary, padding: '6px 10px', fontSize: 11 }}>Save</button>
                            <button onClick={() => setEditingAddressEntry(null)} style={{ ...buttonGhost, padding: '6px 10px', fontSize: 11 }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => { setEditingAddressEntry(entryKey); setAddressDraft(e.shippingAddress || ''); }} style={buttonGhost}>
                              Edit Address
                            </button>
                            <button onClick={() => cancelOrder(e)} style={{ ...buttonGhost, border: '1px solid #f87171', color: '#f87171' }}>Cancel Entry</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)} style={buttonGhost}>Prev</button>
                <span style={{ fontSize: 12, color: '#888' }}>{currentPage}/{totalPages}</span>
                <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => p + 1)} style={buttonGhost}>Next</button>
              </div>
            )}
          </div>
        )}

        {/* ============ PRODUCTS ============ */}
        {tab === 'products' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Product Management</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  onClick={() => {
                    if (!password) { alert('Enter admin password first'); return; }
                    seedDefaultProducts();
                  }} 
                  disabled={productActionLoading} 
                  style={{ ...buttonGhost, border: '1px solid #34d399', color: '#34d399' }}
                >
                  {productActionLoading ? 'Loading…' : 'Seed Defaults'}
                </button>
                <button 
                  onClick={() => { 
                    resetProductForm(); 
                    setShowProductForm(true); 
                    setEditingProduct(null); 
                  }} 
                  style={buttonPrimary}
                >
                  + Add Product
                </button>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage all products. Active products appear on the storefront. Archived products go to the catalog archive. Upcoming products appear in the catalog's upcoming section.
              {allProducts.length === 0 && ' No products exist yet — click "Seed Defaults" to add placeholder products or "Add Product" to create your own.'}
            </p>
            
            {productMsg && (
              <p style={{ fontSize: 12, color: productMsg.includes('Error') || productMsg.includes('❌') ? '#f87171' : '#34d399', marginBottom: 10 }}>
                {productMsg}
              </p>
            )}

            {showProductForm && (
              <div style={{ background: '#09090b', padding: 16, borderRadius: 12, marginBottom: 16 }}>
                <h4 style={{ margin: '0 0 8px', fontSize: 12, color: '#aaa' }}>
                  {editingProduct ? 'Edit Product' : 'New Product'}
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input type="text" placeholder="Name *" value={productForm.name} onChange={(e) => setProductForm((p: any) => ({ ...p, name: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Slug (auto-generated if blank)" value={productForm.slug} onChange={(e) => setProductForm((p: any) => ({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') }))} style={inputStyle} />
                  <input type="text" placeholder="Prefix (image folder name)" value={productForm.prefix} onChange={(e) => setProductForm((p: any) => ({ ...p, prefix: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Tagline" value={productForm.tagline} onChange={(e) => setProductForm((p: any) => ({ ...p, tagline: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Description" value={productForm.desc} onChange={(e) => setProductForm((p: any) => ({ ...p, desc: e.target.value }))} style={{ ...inputStyle, gridColumn: '1 / -1' }} />
                  <input type="number" placeholder="Price 50ml" value={productForm.price50ml} onChange={(e) => setProductForm((p: any) => ({ ...p, price50ml: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Price 100ml" value={productForm.price100ml} onChange={(e) => setProductForm((p: any) => ({ ...p, price100ml: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Stripe ID 50ml" value={productForm.stripeId50ml} onChange={(e) => setProductForm((p: any) => ({ ...p, stripeId50ml: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Stripe ID 100ml" value={productForm.stripeId100ml} onChange={(e) => setProductForm((p: any) => ({ ...p, stripeId100ml: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Max Inventory" value={productForm.maxRaffleAllocationLimit} onChange={(e) => setProductForm((p: any) => ({ ...p, maxRaffleAllocationLimit: e.target.value }))} style={inputStyle} />
                  <input type="number" placeholder="Total Inventory" value={productForm.totalInventory} onChange={(e) => setProductForm((p: any) => ({ ...p, totalInventory: e.target.value }))} style={inputStyle} />
                  <input type="text" placeholder="Winner Tiers (comma separated, e.g. 2,2,2,1)" value={productForm.winnerTiers} onChange={(e) => setProductForm((p: any) => ({ ...p, winnerTiers: e.target.value }))} style={{ ...inputStyle, gridColumn: '1 / -1' }} />
                </div>
                
                <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isActive} onChange={(e) => setProductForm((p: any) => ({ ...p, isActive: e.target.checked }))} />
                    Active (visible on storefront)
                  </label>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isArchived} onChange={(e) => setProductForm((p: any) => ({ ...p, isArchived: e.target.checked }))} />
                    Archived (moved to catalog archive)
                  </label>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isUpcoming} onChange={(e) => setProductForm((p: any) => ({ ...p, isUpcoming: e.target.checked }))} />
                    Upcoming (shown in upcoming section)
                  </label>
                </div>

                <h5 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 4px' }}>Product Notes (scrollable cards on product page)</h5>
                <div style={{ marginBottom: 8 }}>
                  {productForm.notes && productForm.notes.map((note: any, idx: number) => (
                    <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#060606', padding: 6, borderRadius: 6 }}>
                      <span style={{ fontSize: 10, color: '#888', minWidth: 60 }}>{note.label}</span>
                      <span style={{ fontSize: 11, color: '#ccc', flex: 1 }}>{note.name}</span>
                      <span style={{ fontSize: 10, color: '#666', flex: 1 }}>{note.text}</span>
                      <button onClick={() => editNote(idx)} style={{ ...buttonGhost, padding: '2px 8px', fontSize: 10 }}>Edit</button>
                      <button onClick={() => removeNote(idx)} style={{ ...buttonGhost, padding: '2px 8px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>✕</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <input type="text" placeholder="Label (e.g. TOP PROFILE)" value={noteForm.label} onChange={(e) => setNoteForm((n) => ({ ...n, label: e.target.value }))} style={{ ...inputStyle, width: 120, padding: 6, fontSize: 11 }} />
                  <input type="text" placeholder="Name" value={noteForm.name} onChange={(e) => setNoteForm((n) => ({ ...n, name: e.target.value }))} style={{ ...inputStyle, width: 140, padding: 6, fontSize: 11 }} />
                  <input type="text" placeholder="Text" value={noteForm.text} onChange={(e) => setNoteForm((n) => ({ ...n, text: e.target.value }))} style={{ ...inputStyle, flex: 1, padding: 6, fontSize: 11 }} />
                  <button onClick={addNote} style={{ ...buttonPrimary, padding: '6px 12px', fontSize: 11 }}>{editingNoteIdx !== null ? 'Update' : 'Add'}</button>
                  {editingNoteIdx !== null && <button onClick={() => { setEditingNoteIdx(null); setNoteForm({ label: '', name: '', text: '' }); }} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 11 }}>Cancel</button>}
                </div>

                <h5 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 4px' }}>Images (360° rotation)</h5>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  <input type="text" placeholder="Image URL" value={imageInput} onChange={(e) => setImageInput(e.target.value)} style={{ ...inputStyle, flex: 1, padding: 6, fontSize: 11 }} />
                  <button onClick={addImage} disabled={!editingProduct} style={{ ...buttonPrimary, padding: '6px 12px', fontSize: 11 }}>Add Image</button>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(productForm.images || []).map((img: string, idx: number) => (
                    <div key={idx} style={{ position: 'relative', background: '#060606', padding: 4, borderRadius: 4 }}>
                      <span style={{ fontSize: 10, color: '#888' }}>#{idx + 1}</span>
                      <button onClick={() => removeImage(idx)} style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171', marginLeft: 4 }}>✕</button>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={saveProduct} disabled={productActionLoading} style={buttonPrimary}>
                    {productActionLoading ? 'Saving…' : 'Save Product'}
                  </button>
                  <button onClick={() => { setShowProductForm(false); resetProductForm(); }} style={buttonGhost}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {allProducts.length === 0 && !productsLoading && (
                <div style={{ textAlign: 'center', padding: 30, color: '#555', border: '1px dashed #333', borderRadius: 12 }}>
                  No products yet. Click "Seed Defaults" to add placeholder products or "Add Product" to create your own.
                </div>
              )}
              {allProducts.length > 0 && allProducts.map((product) => {
                const isActive = product.isActive && !product.isArchived && !product.isUpcoming;
                const isArchived = product.isArchived;
                const isUpcoming = product.isUpcoming;
                const isHidden = !isActive && !isArchived && !isUpcoming;
                return (
                  <div key={product.id} style={{ background: '#09090b', padding: 12, borderRadius: 8, border: `1px solid ${isActive ? '#1c1c1e' : isArchived ? '#5a3d1a' : isUpcoming ? '#1a3a5a' : '#2a1a1a'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{product.name}</div>
                        <div style={{ fontSize: 10, color: '#666' }}>
                          slug: {product.slug} · images: {product.images?.length || 0} · ${product.price50ml || 0} / ${product.price100ml || 0}
                          {isActive && <span style={{ color: '#34d399', marginLeft: 8 }}>● Active</span>}
                          {isArchived && <span style={{ color: '#f59e0b', marginLeft: 8 }}>● Archived</span>}
                          {isUpcoming && <span style={{ color: '#3b82f6', marginLeft: 8 }}>● Upcoming</span>}
                          {isHidden && <span style={{ color: '#f87171', marginLeft: 8 }}>● Hidden</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => editProduct(product)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Edit</button>
                        <button 
                          onClick={() => {
                            if (!password) { alert('Enter admin password first'); return; }
                            toggleActive(product.id, isActive);
                          }} 
                          disabled={productActionLoading} 
                          style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isActive ? '#f87171' : '#34d399', color: isActive ? '#f87171' : '#34d399' }}
                        >
                          {isActive ? 'Hide' : 'Show'}
                        </button>
                        <button 
                          onClick={() => {
                            if (!password) { alert('Enter admin password first'); return; }
                            toggleArchive(product.id, isArchived);
                          }} 
                          disabled={productActionLoading} 
                          style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isArchived ? '#34d399' : '#f59e0b', color: isArchived ? '#34d399' : '#f59e0b' }}
                        >
                          {isArchived ? 'Unarchive' : 'Archive'}
                        </button>
                        <button 
                          onClick={() => {
                            if (!password) { alert('Enter admin password first'); return; }
                            toggleUpcoming(product.id, isUpcoming);
                          }} 
                          disabled={productActionLoading} 
                          style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isUpcoming ? '#34d399' : '#3b82f6', color: isUpcoming ? '#34d399' : '#3b82f6' }}
                        >
                          {isUpcoming ? 'Remove from Upcoming' : 'Move to Upcoming'}
                        </button>
                        <button 
                          onClick={() => {
                            if (!password) { alert('Enter admin password first'); return; }
                            deleteProduct(product.id);
                          }} 
                          disabled={productActionLoading} 
                          style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
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
              <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Promoter / Affiliate Codes</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Share <code style={{ color: '#aaa' }}>/product-slug?ref=CODE</code>. Applies automatically for the customer's session, blocks self-use by the promoter's own email, and emails the promoter an invoice the moment their code produces a paid winner. Payouts are tracked here — actually sending the money still happens outside this system (Venmo/PayPal/bank), then mark it paid below.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <input placeholder="Code" value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputStyle} />
                <input placeholder="Promoter Name" value={promoForm.promoterName} onChange={(e) => setPromoForm((f) => ({ ...f, promoterName: e.target.value }))} style={inputStyle} />
                <input placeholder="Promoter Email" value={promoForm.promoterEmail} onChange={(e) => setPromoForm((f) => ({ ...f, promoterEmail: e.target.value }))} style={inputStyle} />
                <input type="number" min="0" max="50" placeholder="Customer Discount %" value={promoForm.customerDiscountPercent} 
                  onChange={(e) => setPromoForm((f) => ({ ...f, customerDiscountPercent: e.target.value }))} style={inputStyle} />
                <input type="number" min="0" max="50" placeholder="Promoter Payout %" value={promoForm.promoterPayoutPercent} 
                  onChange={(e) => setPromoForm((f) => ({ ...f, promoterPayoutPercent: e.target.value }))} style={inputStyle} />
                <input type="number" min="0" placeholder="Max uses per email (0=unlimited)" value={promoForm.maxUsesPerEmail} 
                  onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesPerEmail: e.target.value }))} style={inputStyle} />
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
                          customerDiscountPercent: String(p.customerDiscountPercent || ''), 
                          promoterPayoutPercent: String(p.promoterPayoutPercent || ''), 
                          maxUsesPerEmail: String(p.maxUsesPerEmail ?? ''),
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
              <p style={{ fontSize: 11, color: '#888', marginTop: 4, marginBottom: 12 }}>
                Tracks admin actions like cancelling entries, updating shipping, and archiving products. Only shows actions performed from this admin portal.
              </p>
              <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 10, fontSize: 11, color: '#888' }}>
                {audit.length === 0 && <p>No audit entries yet. Actions like cancelling entries, updating shipping, or archiving products will appear here.</p>}
                {audit.map((a, i) => <div key={i} style={{ marginBottom: 6 }}>{a.at} — {a.action} {a.detail || ''}</div>)}
              </div>
            </div>
          </div>
        )}

        {/* ============ SETTINGS ============ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Site Settings</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Edit site appearance and content. Changes are stored in Redis and applied at build time — you'll need to redeploy for changes to take effect.
              </p>
              {settingsLoading && <p style={{ color: '#888', fontSize: 11 }}>Loading settings…</p>}
              
              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Theme Colors</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(themeSettings).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="color" 
                      value={value} 
                      onChange={(e) => setThemeSettings({ ...themeSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 4, height: 40 }} />
                  </label>
                ))}
              </div>

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Hero Content</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(heroSettings).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="text" 
                      value={value} 
                      onChange={(e) => setHeroSettings({ ...heroSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                ))}
              </div>

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Registration Form</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(formSettings).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="text" 
                      value={value} 
                      onChange={(e) => setFormSettings({ ...formSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                ))}
              </div>

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Footer</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(footerSettings).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="text" 
                      value={value} 
                      onChange={(e) => setFooterSettings({ ...footerSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                ))}
              </div>

              <button onClick={saveSettings} style={{ ...buttonPrimary, marginTop: 12 }} disabled={settingsLoading}>
                {settingsLoading ? 'Saving…' : 'Save All Settings'}
              </button>
              {settingsMsg && <p style={{ fontSize: 12, color: settingsMsg.includes('Failed') ? '#f87171' : '#34d399', marginTop: 10 }}>{settingsMsg}</p>}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}