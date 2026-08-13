'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { THEME_PRESETS } from '@/lib/theme-presets';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';

type Tab = 'overview' | 'drops' | 'ledger' | 'growth' | 'system' | 'settings' | 'products' | 'users' | 'promotions' | 'catalog';

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

function stableOrderRef(entry: any, index: number) {
  const existing = formatOrderRef(entry?.orderRef || entry?.ref || '');
  if (existing) return existing;
  return buildOrderRef(entry?.email || 'anon', entry?.variant || 'product', entry?.size || 'size');
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

// Default Stripe price ID prefilled in the product form. Mirrors the server-side
// default (lib/server-config.ts): the STRIPE_PRODUCT_ID env var when set,
// otherwise an obvious placeholder that forces the operator to set a real ID
// per size. /api/admin/products GET returns the live value so this stays in
// sync without a redeploy. There is intentionally NO hardcoded Stripe price ID
// anywhere in this template.
const UNCONFIGURED_STRIPE_PRICE_ID = 'price_placeholder_not_configured';

// Sentinel for an unconfigured product price. New products start at this
// obviously-wrong value so nobody can accidentally publish a product priced at
// $0 or charge the sentinel amount — every checkout path rejects it.
const UNCONFIGURED_PRICE_SENTINEL = 9999999;

// Defaults for the glow-orb system (/admin → Settings → Orb Glow). These mirror
// the storefront defaults so a fresh portal has sane values before any save.
const DEFAULT_ORBS: any = {
  enabled: true,
  primary: { enabled: true, color: '#3b82f6', opacity: 16, size: 58 },
  secondary: { enabled: true, color: '#a855f7', opacity: 26, size: 44 },
  tertiary: { enabled: true, color: '#ffd79b', opacity: 12, size: 28 },
  fourth: { enabled: true, color: '#7dd3fc', opacity: 10, size: 36 },
  fifth: { enabled: true, color: '#f472b6', opacity: 8, size: 24 },
  motion: {
    idleEnabled: true,
    pointerEnabled: true,
    scrollEnabled: true,
    intensity: 100,
    speed: 100,
    momentum: 40,
  },
};

function mergeOrbSettings(base: any, incoming: any): any {
  if (!incoming) return base;
  return {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : base.enabled,
    primary: { ...(base.primary || {}), ...(incoming.primary || {}) },
    secondary: { ...(base.secondary || {}), ...(incoming.secondary || {}) },
    tertiary: { ...(base.tertiary || {}), ...(incoming.tertiary || {}) },
    fourth: { ...(base.fourth || {}), ...(incoming.fourth || {}) },
    fifth: { ...(base.fifth || {}), ...(incoming.fifth || {}) },
    motion: { ...(base.motion || {}), ...(incoming.motion || {}) },
  };
}

// ===== Helper: convert file to base64 data URL =====
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImageFile(file: File, maxSize = 1440, quality = 0.82): Promise<File> {
  if (typeof window === 'undefined') return file;
  // Accept files even when the browser reports an empty/odd MIME type (some
  // .jpeg exports do) — the file picker is already restricted to image/*.
  if (file.type && !file.type.startsWith('image/')) return file;
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, width, height);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', quality));
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
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
  const [editingShippingEntry, setEditingShippingEntry] = useState<string | null>(null);
  const [shippingStatusDraft, setShippingStatusDraft] = useState('PENDING_FULFILLMENT');
  const [trackingDraft, setTrackingDraft] = useState('');

  const [recovery, setRecovery] = useState({ enabled: true, earlyDelayHours: 3, preDrawHours: 6, preDrawEnabled: true });
  const [recoveryMsg, setRecoveryMsg] = useState('');

  const [promos, setPromos] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsMsg, setAlertsMsg] = useState('');
  const [selectedAlertProductId, setSelectedAlertProductId] = useState('');
  const [promoForm, setPromoForm] = useState({
    code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '',
    timeLimited: false, startAt: '', endAt: '', maxUsesTotal: '',
  });
  const [promoMsg, setPromoMsg] = useState('');
  const [audit, setAudit] = useState<any[]>([]);

  const [scheduleForm, setScheduleForm] = useState<any>({});
  const [socialForm, setSocialForm] = useState<any>({});
  const [configMsg, setConfigMsg] = useState('');

  const [selftestResults, setSelftestResults] = useState<any>(null);
  const [selftestRunning, setSelftestRunning] = useState(false);
  const [organizeMsg, setOrganizeMsg] = useState('');
  
  const [drawHistory, setDrawHistory] = useState<any[]>([]);
  const [drawHistoryLoading, setDrawHistoryLoading] = useState(false);
  const [expandedDraw, setExpandedDraw] = useState<number | null>(null);

  // ===== Products state (UPDATED) =====
  const [products, setProducts] = useState<any[]>([]);
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<any>({
    name: '', slug: '', prefix: '', tagline: '', desc: '',
    checkoutMode: 'RAFFLE',
    productType: 'raffle',
    maxPerEmail: 1,
    maxPerCart: 1,
    isActive: false,       // default HIDDEN (as requested)
    isArchived: false,
    isUpcoming: false,
    goLiveAt: '',
    releaseEndsAt: '',
    soldOutBehavior: 'stay_visible',
    soldOutArchiveDelayHours: 24,
    deliveryIncentiveEnabled: false,
    deliveryIncentiveCreditCents: 0,
    deliveryIncentiveMinOrderSubtotalCents: 0,
    deliveryIncentiveExpiresDays: 60,
    deliveryIncentiveCodePrefix: '',
    deliveryIncentiveEligibleProductSlugs: [],
    deliveryIncentiveEligibleSizes: [],
    deliveryIncentiveTriggerSizes: [],
    sortOrder: 0,
    notes: [],
    images: [],
    // NEW: dynamic price categories
    priceCategories: [
      { size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: UNCONFIGURED_STRIPE_PRICE_ID, winnerTiers: '1' }
    ]
  });
  const [defaultStripePriceId, setDefaultStripePriceId] = useState(UNCONFIGURED_STRIPE_PRICE_ID);
  const [productMsg, setProductMsg] = useState('');
  const [showProductForm, setShowProductForm] = useState(false);
  const [imageInput, setImageInput] = useState('');
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null);
  const [noteForm, setNoteForm] = useState({ label: '', name: '', text: '' });
  const [productActionLoading, setProductActionLoading] = useState(false);
  // ===== Users state =====
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userForm, setUserForm] = useState({ email: '', password: '', role: 'customer', rewards: 0 });
  const [userMsg, setUserMsg] = useState('');
  const [showUserForm, setShowUserForm] = useState(false);

  // ===== Catalog state =====
  const [catalogUpcoming, setCatalogUpcoming] = useState<any[]>([]);
  const [catalogArchive, setCatalogArchive] = useState<any[]>([]);
  const [catalogMsg, setCatalogMsg] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [themeSettings, setThemeSettings] = useState(GOYUNIR_STORE_SUITE.themeColors);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [heroSettings, setHeroSettings] = useState(GOYUNIR_STORE_SUITE.heroContent);
  const [formSettings, setFormSettings] = useState(GOYUNIR_STORE_SUITE.raffleRegistrationForm);
  const [footerSettings, setFooterSettings] = useState(GOYUNIR_STORE_SUITE.brandFooterData);
  const [brandingSettings, setBrandingSettings] = useState({
    logoUrl: '',
    headerMode: 'both',
    headerActionMode: 'cart',
    shareImageUrl: '',
    shareTitle: 'GOYUNIR',
    shareDescription: 'Handcrafted fragrance allocations — private raffle drops, first-access alerts, and clean checkout for high-intent collectors.',
    shareBackground: '#0B0B0F',
    shareAccent: '#D4AF37',
    shareText: '#F5F2E9',
    iconBackground: '#0B0B0F',
    iconText: '#D4AF37',
  });
  const [productNotes, setProductNotes] = useState<Record<string, any[]>>({});
  const [orbSettings, setOrbSettings] = useState<any>(mergeOrbSettings(DEFAULT_ORBS, (GOYUNIR_STORE_SUITE as any).orbs));
  const [settingsMsg, setSettingsMsg] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2800);
  };

  // ============================================================
  // FETCH FUNCTIONS (unchanged)
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
      fetchUsers(),
      fetchCatalogSettings(),
      fetchAlerts(),
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

  const fetchAlerts = async () => {
    if (!password) {
      setAlerts([]);
      return;
    }
    setAlertsLoading(true);
    try {
      const res = await adminFetch(`/api/admin/alerts?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setAlerts(Array.isArray(data.subscribers) ? data.subscribers : []);
    } catch {
      setAlerts([]);
    }
    setAlertsLoading(false);
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
      setScheduleForm({ ...data.baseSchedule, ...(data.globalScheduleOverride || {}) });
      setSocialForm({ ...data.baseSocialProof, ...(data.socialProofOverride || {}) });
      
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
        if (data.settings.themeColors) setThemeSettings({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.settings.themeColors });
        if (data.settings.heroContent) setHeroSettings(data.settings.heroContent);
        if (data.settings.raffleRegistrationForm) setFormSettings(data.settings.raffleRegistrationForm);
        if (data.settings.brandFooterData) setFooterSettings(data.settings.brandFooterData);
        if (data.settings.branding) setBrandingSettings((prev) => ({ ...prev, ...data.settings.branding }));
        if (data.settings.productNotes) setProductNotes(data.settings.productNotes);
        if (data.settings.orbs) setOrbSettings((prev: any) => mergeOrbSettings(prev || DEFAULT_ORBS, data.settings.orbs));
      }
      setSettingsMsg('');
    } catch (err: any) {
      setSettingsMsg('Could not load settings: ' + err.message);
    }
    setSettingsLoading(false);
  };

  // ===== UPDATED fetchProducts to handle priceCategories =====
  const fetchProducts = async () => {
    setProductsLoading(true);
    try {
      const res = await adminFetch('/api/admin/products?includeArchived=true');
      const data = await res.json();
      if (data.defaultStripePriceId) setDefaultStripePriceId(String(data.defaultStripePriceId));
      if (data.products) {
        const sorted = [...data.products].sort((a, b) => ((a.sortOrder || 0) - (b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));
        setAllProducts(sorted);
        setProducts(sorted.filter((p: any) => !p.isArchived && !p.isUpcoming));
      }
    } catch (err) {
      console.error('[Products] Fetch error:', err);
    }
    setProductsLoading(false);
  };

  const fetchUsers = async () => {
    if (!password) return;
    setUsersLoading(true);
    try {
      const res = await adminFetch(`/api/admin/users?password=${encodeURIComponent(password)}`);
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      console.error('[Users] Fetch error:', err);
    }
    setUsersLoading(false);
  };

  const fetchCatalogSettings = async () => {
    setCatalogLoading(true);
    try {
      const res = await adminFetch('/api/admin/catalog-settings');
      const data = await res.json();
      if (data.upcomingDrops) setCatalogUpcoming(data.upcomingDrops);
      if (data.archiveScents) setCatalogArchive(data.archiveScents);
    } catch (err) {
      console.error('Failed to load catalog settings:', err);
    }
    setCatalogLoading(false);
  };

  // ============================================================
  // PRODUCT FUNCTIONS (UPDATED)
  // ============================================================

  const resetProductForm = () => {
    setProductForm({
      name: '', slug: '', prefix: '', tagline: '', desc: '',
      checkoutMode: 'RAFFLE',
      productType: 'raffle',
      maxPerEmail: 1,
      maxPerCart: 1,
      isActive: false, // default hidden
      isArchived: false,
      isUpcoming: false,
      goLiveAt: '',
      releaseEndsAt: '',
      soldOutBehavior: 'stay_visible',
      soldOutArchiveDelayHours: 24,
      deliveryIncentiveEnabled: false,
      deliveryIncentiveCreditCents: 0,
      deliveryIncentiveMinOrderSubtotalCents: 0,
      deliveryIncentiveExpiresDays: 60,
      deliveryIncentiveCodePrefix: '',
      deliveryIncentiveEligibleProductSlugs: [],
      deliveryIncentiveEligibleSizes: [],
      deliveryIncentiveTriggerSizes: [],
      sortOrder: 0,
      notes: [],
      images: [],
      priceCategories: [
        { size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }
      ]
    });
    setEditingProduct(null);
    setEditingNoteIdx(null);
    setNoteForm({ label: '', name: '', text: '' });
    setImageInput('');
  };

  const editProduct = (product: any) => {
    setEditingProduct(product.id);
    // Ensure priceCategories exists
    const categories = product.priceCategories && Array.isArray(product.priceCategories)
      ? product.priceCategories
      : [{ size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }];
    setProductForm({
      ...product,
      priceCategories: categories,
      notes: product.notes || [],
      images: product.images || [],
      isUpcoming: product.isUpcoming || false,
      checkoutMode: String(product.checkoutMode || '').toUpperCase() === 'FCFS' || product.isRaffle === false ? 'FCFS' : 'RAFFLE',
      productType: product.productType || (product.isRaffle === false ? 'fcfs' : 'raffle'),
      maxPerEmail: Number(product.maxPerEmail || 1),
      maxPerCart: Number(product.maxPerCart || product.maxPerEmail || 1),
      sortOrder: product.sortOrder || 0,
      // Ensure default hidden if new
      isActive: product.isActive !== undefined ? product.isActive : false,
    });
    setShowProductForm(true);
  };

  // ===== Handle dynamic price categories =====
  const addPriceCategory = () => {
    setProductForm((prev: any) => ({
      ...prev,
      priceCategories: [
        ...prev.priceCategories,
        { size: '', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId, winnerTiers: '1' }
      ]
    }));
  };

  const removePriceCategory = (index: number) => {
    setProductForm((prev: any) => ({
      ...prev,
      priceCategories: prev.priceCategories.filter((_: any, i: number) => i !== index)
    }));
  };

  const updatePriceCategory = (index: number, field: string, value: any) => {
    setProductForm((prev: any) => {
      const updated = [...prev.priceCategories];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, priceCategories: updated };
    });
  };

  // ===== Handle image file uploads =====
  const handleImageFiles = async (files: FileList) => {
    if (!password) {
      setProductMsg('❌ Enter admin password first.');
      return;
    }
    if (!editingProduct) {
      setProductMsg('❌ Save the product first, then upload images.');
      return;
    }
    const fileArray = Array.from(files);
    let uploaded = 0;
    let failed = 0;
    for (const file of fileArray) {
      const compressed = await compressImageFile(file);
      const previewUrl = await fileToDataURL(compressed);
      setProductForm((prev: any) => ({
        ...prev,
        images: [...(prev.images || []), previewUrl],
      }));
      const uploadData = new FormData();
      uploadData.append('productId', editingProduct);
      uploadData.append('password', password);
      uploadData.append('file', compressed);
      const res = await adminFetch('/api/admin/upload', { method: 'POST', body: uploadData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        failed += 1;
        setProductMsg(`⚠ Upload to store failed for ${file.name}: ${data.error || 'unknown error'}. The image stays in this form — press Save Product to store it directly.`);
        // NOTE: we intentionally do NOT remove the preview. The data URL stays
        // in productForm.images so clicking "Save Product" persists it to Redis
        // even if the separate upload endpoint was blocked (e.g. size limits).
        continue;
      }
      uploaded += 1;
    }
    await fetchProducts();
    if (failed === 0) {
      setProductMsg(`✅ Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'}.`);
    }
    showToast(`Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'}${failed ? ` · ${failed} kept locally` : ''}`);
  };

  // ===== Save product (UPDATED to send priceCategories) =====
  const saveProduct = async () => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!productForm.name) { alert('Product name is required'); return; }
    
    setProductActionLoading(true);
    try {
      // Build payload with priceCategories
      const payload = {
        password,
        action: 'upsert',
        ...productForm,
        priceCategories: productForm.priceCategories || [],
        notes: productForm.notes || [],
        images: productForm.images || [],
        sortOrder: Number(productForm.sortOrder) || 0,
        checkoutMode: productForm.checkoutMode === 'FCFS' ? 'FCFS' : 'RAFFLE',
        isRaffle: productForm.checkoutMode !== 'FCFS',
        productType: productForm.checkoutMode === 'FCFS' ? 'fcfs' : 'raffle',
        maxPerEmail: Math.max(1, Number(productForm.maxPerEmail) || 1),
        maxPerCart: Math.max(1, Number(productForm.maxPerCart) || Number(productForm.maxPerEmail) || 1),
        // Ensure we send isActive, isArchived, isUpcoming
      };
      // Remove old price50ml/100ml if present (they shouldn't be)
      delete payload.price50ml;
      delete payload.price100ml;
      delete payload.stripeId50ml;
      delete payload.stripeId100ml;

      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text || 'Non-JSON response from server' };
      }
      if (res.ok) {
        setProductMsg(`✅ Product "${data?.product?.name || productForm.name}" saved successfully!`);
        showToast('UPDATED · Product');
        await fetchProducts();
        setShowProductForm(false);
        resetProductForm();
      } else {
        setProductMsg('❌ Error: ' + (data.error || `HTTP ${res.status}`));
      }
    } catch (err: any) {
      setProductMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  // ===== Delete, archive, active toggles (unchanged logic, but now archiving/upcoming does NOT hide) =====
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

  // Archive/Unarchive: now they do NOT affect isActive – they just move the product to the archive list while remaining visible.
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

  // Toggle active: simply toggles visibility without affecting archive/upcoming status
  const toggleActive = async (id: string, currentActive: boolean) => {
    if (!password) { alert('Enter admin password first'); return; }
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'toggleActive', id, nextActive: !currentActive }),
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

  // Upcoming toggle: does not hide, just marks/unmarks as upcoming
  const toggleUpcoming = async (id: string, currentUpcoming: boolean) => {
    if (!password) { alert('Enter admin password first'); return; }
    const action = currentUpcoming ? 'removeFromUpcoming' : 'addToUpcoming';
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action, id }),
      });
      if (res.ok) {
        showToast(`UPDATED · ${currentUpcoming ? 'Removed from Upcoming' : 'Added to Upcoming'}`);
        await fetchProducts();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const reorderProducts = async (productId: string, newOrder: number) => {
    if (!password) { alert('Enter admin password first'); return; }
    setProductActionLoading(true);
    try {
      const res = await adminFetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'reorder', id: productId, sortOrder: newOrder }),
      });
      if (res.ok) {
        showToast('UPDATED · Reordered');
        await fetchProducts();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const addNote = () => {
    if (!noteForm.label || !noteForm.name) return;
    setProductForm((prev: any) => {
      const nextNotes = [...(prev.notes || [])];
      if (editingNoteIdx !== null) nextNotes[editingNoteIdx] = { ...noteForm };
      else nextNotes.push({ ...noteForm });
      return { ...prev, notes: nextNotes };
    });
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

  // For image URL input (still supported)
  const addImageUrl = () => {
    if (!imageInput.trim()) return;
    setProductForm((prev: any) => ({
      ...prev,
      images: [...prev.images, imageInput.trim()]
    }));
    setImageInput('');
  };

  const removeImage = (idx: number) => {
    setProductForm((prev: any) => ({
      ...prev,
      images: prev.images.filter((_: any, i: number) => i !== idx)
    }));
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
  // USER FUNCTIONS (unchanged)
  // ============================================================
  const saveUser = async () => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!userForm.email) { alert('Email is required'); return; }
    setProductActionLoading(true);
    try {
      const body: any = {
        password: password,
        action: editingUser ? 'update' : 'create',
        email: userForm.email,
        role: userForm.role,
        rewards: userForm.rewards,
      };
      if (userForm.password) {
        body.userPassword = userForm.password;
      }
      if (editingUser) {
        body.id = editingUser;
      }

      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setUserMsg('✅ User saved successfully!');
        showToast('UPDATED · User');
        await fetchUsers();
        setShowUserForm(false);
        setUserForm({ email: '', password: '', role: 'customer', rewards: 0 });
        setEditingUser(null);
      } else {
        setUserMsg('❌ Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      setUserMsg('❌ Error: ' + err.message);
    }
    setProductActionLoading(false);
  };

  const deleteUser = async (id: string) => {
    if (!password) { alert('Enter admin password first'); return; }
    if (!confirm('Delete this user?')) return;
    try {
      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'delete', id }),
      });
      if (res.ok) {
        showToast('DELETED · User');
        await fetchUsers();
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  // ============================================================
  // CATALOG FUNCTIONS (unchanged)
  // ============================================================
  const saveCatalogSettings = async () => {
    if (!password) return alert('Enter password');
    setCatalogLoading(true);
    try {
      const res = await adminFetch('/api/admin/catalog-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          upcomingDrops: catalogUpcoming,
          archiveScents: catalogArchive,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCatalogMsg('Catalog settings saved!');
        showToast('UPDATED · Catalog');
      } else {
        setCatalogMsg('Error: ' + (data.error || 'Unknown'));
      }
    } catch (err: any) {
      setCatalogMsg('Error: ' + err.message);
    }
    setCatalogLoading(false);
  };

  // ============================================================
  // PROMO FUNCTIONS (unchanged)
  // ============================================================
  const savePromo = async () => {
    if (!password) return alert('Enter password');
    const customerDiscount = Number(promoForm.customerDiscountPercent);
    const promoterPayout = Number(promoForm.promoterPayoutPercent);
    const maxUses = Number(promoForm.maxUsesPerEmail);
    const maxUsesTotal = Number(promoForm.maxUsesTotal) || 0;
    
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          action: 'upsert',
          code: promoForm.code,
          promoterName: promoForm.promoterName,
          promoterEmail: promoForm.promoterEmail,
          customerDiscountPercent: customerDiscount,
          promoterPayoutPercent: promoterPayout,
          maxUsesPerEmail: maxUses,
          maxUsesTotal: maxUsesTotal,
          timeLimited: promoForm.timeLimited,
          startAt: promoForm.startAt || null,
          endAt: promoForm.endAt || null,
          active: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPromoMsg(`Saved ${data.promo?.code}.`); showToast('UPDATED · Promo');
        setPromoForm({ code: '', promoterName: '', promoterEmail: '', customerDiscountPercent: '', promoterPayoutPercent: '', maxUsesPerEmail: '', timeLimited: false, startAt: '', endAt: '', maxUsesTotal: '' });
        await fetchPromos();
      } else setPromoMsg(data.error || 'Failed');
    } catch {
      setPromoMsg('Failed');
    }
  };

  const deletePromo = async (code: string) => {
    if (!password) return alert('Enter password');
    if (!confirm(`Delete promo code ${code}?`)) return;
    await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'delete', code }) });
    await fetchPromos();
  };

  // ============================================================
  // OTHER FUNCTIONS (unchanged)
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

  // Update shipping status + tracking for a Won & Charged ledger entry. The
  // /api/admin/update-shipping route persists it on the ledger entry AND emails
  // the customer (and issues any configured post-delivery credit on DELIVERED).
  const updateShipping = async (entry: any) => {
    if (!password) return alert('Enter password');
    setShipMsg('Updating shipping…');
    try {
      const res = await adminFetch('/api/admin/update-shipping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          email: entry.email,
          variant: entry.variant,
          size: entry.size,
          shippingStatus: shippingStatusDraft,
          trackingNumber: trackingDraft.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShipMsg(`Shipping updated to ${shippingStatusDraft.replace(/_/g, ' ')} — customer notified.`);
        showToast('UPDATED · Shipping');
        await fetchStatus();
        setEditingShippingEntry(null);
      } else setShipMsg(data.error || 'Failed to update shipping.');
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

  const organizeRedis = async () => {
    if (!password) return alert('Enter password');
    setOrganizeMsg('Cleaning up redundant Redis keys...');
    try {
      const res = await adminFetch('/api/admin/organize-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        const detail = Array.isArray(data.removed) && data.removed.length > 0 ? ` Removed: ${data.removed.join(', ')}` : '';
        setOrganizeMsg((data.message || 'Redis cleanup complete.') + detail);
        showToast('UPDATED · Redis cleaned');
        await fetchProducts();
        await fetchCatalogSettings();
      } else {
        setOrganizeMsg(data.error || 'Failed to clean up Redis.');
      }
    } catch (err: any) {
      setOrganizeMsg(err.message || 'Failed to clean up Redis.');
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
          branding: brandingSettings,
          productNotes,
          orbs: orbSettings,
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

  const applyThemePreset = (presetId: string) => {
    const preset = THEME_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setThemeSettings({ ...GOYUNIR_STORE_SUITE.themeColors, ...preset.themeColors });
    // Match the glow orbs to the new accent so the storefront glow reads on-brand.
    setOrbSettings((prev: any) => mergeOrbSettings(prev || DEFAULT_ORBS, {
      primary: preset.orbs.primary,
      secondary: preset.orbs.secondary,
      tertiary: preset.orbs.tertiary,
      fourth: preset.orbs.fourth,
      fifth: preset.orbs.fifth,
    }));
    setActivePreset(presetId);
    showToast(`PRESET · ${preset.name} applied — press Save to publish`);
  };

  const notifyReleaseList = async () => {
    if (!password) return alert('Enter password');
    if (!selectedAlertProductId) return alert('Choose a product first');
    setAlertsMsg('Sending release emails…');
    try {
      const res = await adminFetch('/api/admin/alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'notifyProduct', productId: selectedAlertProductId }),
      });
      const data = await res.json();
      if (res.ok) {
        setAlertsMsg(`Sent ${data.sent || 0} release alerts${data.skipped ? ` · skipped ${data.skipped}` : ''}.`);
        await fetchAlerts();
      } else {
        setAlertsMsg(data.error || 'Failed to send alerts.');
      }
    } catch (err: any) {
      setAlertsMsg(err.message || 'Failed to send alerts.');
    }
  };

  const removeAlertSubscriber = async (email: string) => {
    if (!password) return alert('Enter password');
    try {
      const res = await adminFetch('/api/admin/alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, action: 'remove', email }),
      });
      if (res.ok) await fetchAlerts();
    } catch {}
  };

  // ============================================================
  // USE EFFECTS (unchanged)
  // ============================================================
  useEffect(() => {
    fetchStatus();
    fetchCatalogStatus();
    fetchRecovery();
    fetchPromos();
    fetchProducts();
    fetchUsers();
    fetchCatalogSettings();
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
    { id: 'users', label: 'Users', badge: users.length || undefined },
    { id: 'promotions', label: 'Promotions' },
    { id: 'growth', label: 'Growth' },
    { id: 'system', label: 'System' },
    { id: 'settings', label: 'Settings' },
  ];

  // ============================================================
  // RENDER (UPDATED product form with dynamic categories, explanations, file upload)
  // ============================================================
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
                if (t.id === 'growth') { fetchPromos(); fetchAudit(); fetchAlerts(); }
                if (t.id === 'system') { if (password) fetchAudit(); fetchDrawHistory(); }
                if (t.id === 'drops') fetchConfig();
                if (t.id === 'drops' && drawsSub === 'run') fetchDrawHistory();
                if (t.id === 'settings') fetchSettings();
                if (t.id === 'products') fetchProducts();
                if (t.id === 'users') fetchUsers();
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

        {/* ============ OVERVIEW (unchanged) ============ */}
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

        {/* ============ DROPS (unchanged) ============ */}
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
                    (p.priceCategories || []).map((cat: any) => (
                      <option key={`${p.name}-${cat.size}`} value={`drop_pool:${p.name}:${cat.size}`}>{p.name} — {cat.size}</option>
                    ))
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
                <p style={{ fontSize: 11, color: '#b8b8c0', marginTop: 0, marginBottom: 12 }}>Global schedule is now just the fallback. Each product can also carry its own go-live time, countdown end, and sold-out handling rules from Product Management.</p>
                
                <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Drop Schedule</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <label style={{ fontSize: 11 }}>Mode
                    <select value={scheduleForm.mode || 'weekly'} onChange={(e) => setScheduleForm((f: any) => ({ ...f, mode: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                      <option value="fixed">Fixed date</option>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Biweekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 11 }}>Timezone
                    <input value={scheduleForm.timezone || ''} onChange={(e) => setScheduleForm((f: any) => ({ ...f, timezone: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                  </label>
                  {(scheduleForm.mode === 'fixed' || scheduleForm.mode === 'biweekly' || scheduleForm.mode === 'yearly') && (
                    <label style={{ fontSize: 11, gridColumn: '1 / -1' }}>{scheduleForm.mode === 'fixed' ? 'Fixed date/time (YYYY-MM-DDTHH:MM:SS)' : 'Anchor date/time (YYYY-MM-DDTHH:MM:SS)'}
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
                  {scheduleForm.mode === 'hourly' && (
                    <label style={{ fontSize: 11 }}>Minute (0-59)
                      <input type="number" min={0} max={59} value={scheduleForm.drawMinute ?? 0}
                        onChange={(e) => setScheduleForm((f: any) => ({ ...f, drawMinute: Number(e.target.value) }))}
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
                  <label style={{ fontSize: 11 }}>Max hours between ticks
                    <input type="number" value={socialForm.autoIncrementMaxHourGap ?? 8} onChange={(e) => setSocialForm((f: any) => ({ ...f, autoIncrementMaxHourGap: Number(e.target.value) }))}
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

        {/* ============ LEDGER (unchanged) ============ */}
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
                const isEditingShipping = editingShippingEntry === entryKey;
                const orderRef = e.orderRef || stableOrderRef(e, i);
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
                      {e.type === 'WINNER_CHARGED' && (
                        <span style={{ marginLeft: 6 }}>
                          · {e.shippingStatus ? e.shippingStatus.replace(/_/g, ' ').toLowerCase() : 'pending fulfillment'}
                          {e.trackingNumber ? ` · 📦 ${e.trackingNumber}` : ''}
                        </span>
                      )}
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
                    {e.type === 'WINNER_CHARGED' && (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1c1c1e' }}>
                        {isEditingShipping ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <select value={shippingStatusDraft} onChange={(ev) => setShippingStatusDraft(ev.target.value)}
                              style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1, minWidth: 130 }}>
                              {SHIP_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                            </select>
                            <input type="text" value={trackingDraft} onChange={(ev) => setTrackingDraft(ev.target.value)}
                              placeholder="Tracking number" style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1, minWidth: 130 }} />
                            <button onClick={() => updateShipping(e)} style={{ ...buttonPrimary, padding: '6px 10px', fontSize: 11 }}>Save & email</button>
                            <button onClick={() => setEditingShippingEntry(null)} style={{ ...buttonGhost, padding: '6px 10px', fontSize: 11 }}>Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => { setEditingShippingEntry(entryKey); setShippingStatusDraft(e.shippingStatus || 'PENDING_FULFILLMENT'); setTrackingDraft(e.trackingNumber || ''); }} style={{ ...buttonGhost, fontSize: 11 }}>
                            Update shipping & tracking
                          </button>
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

        {/* ============ PRODUCTS (UPDATED) ============ */}
        {tab === 'products' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Product Management</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={seedDefaultProducts} disabled={productActionLoading} style={{ ...buttonGhost, border: '1px solid #34d399', color: '#34d399' }}>
                  {productActionLoading ? 'Loading…' : 'Seed Defaults'}
                </button>
                <button onClick={() => { resetProductForm(); setShowProductForm(true); setEditingProduct(null); }} style={buttonPrimary}>
                  + Add Product
                </button>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage all products. <strong>New products default to hidden</strong> – publish them by setting "Active" to true. Archived and Upcoming are now mutually exclusive, each product can carry its own go-live/countdown timing, and sold-out handling can either stay visible as proof of demand or auto-archive later.
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
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Name *</label>
                    <input type="text" placeholder="Product name" value={productForm.name} onChange={(e) => setProductForm((p: any) => ({ ...p, name: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Slug (URL) – auto‑generated from name</label>
                    <input type="text" placeholder="slug (e.g. elysian-white)" value={productForm.slug} onChange={(e) => setProductForm((p: any) => ({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Prefix (image folder) – auto from slug</label>
                    <input type="text" placeholder="prefix" value={productForm.prefix} onChange={(e) => setProductForm((p: any) => ({ ...p, prefix: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Tagline (short subtitle)</label>
                    <input type="text" placeholder="e.g. WHITE ALLOCATION / 01" value={productForm.tagline} onChange={(e) => setProductForm((p: any) => ({ ...p, tagline: e.target.value }))} style={inputStyle} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ fontSize: 10, color: '#888' }}>Description</label>
                    <input type="text" placeholder="Product description" value={productForm.desc} onChange={(e) => setProductForm((p: any) => ({ ...p, desc: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Checkout Mode</label>
                    <select value={productForm.checkoutMode || 'RAFFLE'} onChange={(e) => setProductForm((p: any) => ({ ...p, checkoutMode: e.target.value === 'FCFS' ? 'FCFS' : 'RAFFLE' }))} style={inputStyle}>
                      <option value="RAFFLE">RAFFLE</option>
                      <option value="FCFS">FCFS</option>
                    </select>
                    <div style={{ marginTop: 6, padding: '8px 9px', borderRadius: 8, background: '#0b0b0d', border: '1px solid #1f2937', fontSize: 10, color: '#8b95a7', lineHeight: 1.5 }}>
                      Raffle keeps the release selective. FCFS supports immediate conversion. Upcoming and archived FCFS items can also surface a reserve option so collectors can signal intent without forcing a checkout.
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Sort Order (lower = appears first)</label>
                    <input type="number" placeholder="0" value={productForm.sortOrder} onChange={(e) => setProductForm((p: any) => ({ ...p, sortOrder: Number(e.target.value) }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Max per email (entry or purchase count)</label>
                    <input type="number" min={1} value={productForm.maxPerEmail ?? 1} onChange={(e) => setProductForm((p: any) => ({ ...p, maxPerEmail: Number(e.target.value) }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Max in cart per email</label>
                    <input type="number" min={1} value={productForm.maxPerCart ?? productForm.maxPerEmail ?? 1} onChange={(e) => setProductForm((p: any) => ({ ...p, maxPerCart: Number(e.target.value) }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Go live at (upcoming auto-activates)</label>
                    <input type="datetime-local" value={productForm.goLiveAt || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, goLiveAt: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Countdown ends at</label>
                    <input type="datetime-local" value={productForm.releaseEndsAt || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, releaseEndsAt: e.target.value }))} style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Sold-out behavior</label>
                    <select value={productForm.soldOutBehavior || 'stay_visible'} onChange={(e) => setProductForm((p: any) => ({ ...p, soldOutBehavior: e.target.value }))} style={inputStyle}>
                      <option value="stay_visible">Stay visible as social proof</option>
                      <option value="archive_now">Archive immediately</option>
                      <option value="archive_after_delay">Archive after delay</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#888' }}>Archive delay after sold out (hours)</label>
                    <input type="number" min={0} value={productForm.soldOutArchiveDelayHours ?? 24} onChange={(e) => setProductForm((p: any) => ({ ...p, soldOutArchiveDelayHours: Number(e.target.value) }))} style={inputStyle} />
                  </div>
                </div>
                
                <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isActive} onChange={(e) => setProductForm((p: any) => ({ ...p, isActive: e.target.checked }))} />
                    <span title="If checked, product is visible on the storefront (if not hidden by other flags).">Active (visible)</span>
                  </label>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isArchived} onChange={(e) => setProductForm((p: any) => ({ ...p, isArchived: e.target.checked, isUpcoming: e.target.checked ? false : p.isUpcoming }))} />
                    <span title="Moves to archive section – product remains visible.">Archived</span>
                  </label>
                  <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={productForm.isUpcoming} onChange={(e) => setProductForm((p: any) => ({ ...p, isUpcoming: e.target.checked, isArchived: e.target.checked ? false : p.isArchived }))} />
                    <span title="Shows in upcoming section – product remains visible.">Upcoming</span>
                  </label>
                </div>

                <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: '#060606', border: '1px solid #1f2937', fontSize: 10, color: '#8b95a7', lineHeight: 1.6 }}>
                  RAFFLE is best for scarcity, list building, and selective access. FCFS is best for immediate conversion. Upcoming builds anticipation with an automatic go-live moment. Sold-out hold keeps proof of demand visible before archiving.
                </div>

                <div style={{ marginTop: 12, borderTop: '1px solid #27272a', paddingTop: 12 }}>
                  <h5 style={{ fontSize: 11, color: '#aaa', margin: '0 0 8px' }}>Post-Delivery Credit</h5>
                  <p style={{ fontSize: 10, color: '#666', margin: '0 0 8px' }}>
                    Use this for sampler-to-full-size conversion. When this product is marked delivered, the buyer receives a one-time code bound to their email, restricted to your selected full-size item(s) and optional order minimum. Generated credits remain usable until they are manually removed.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={productForm.deliveryIncentiveEnabled === true} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEnabled: e.target.checked }))} />
                      <span>Enable delivery credit</span>
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>Credit value (cents)
                      <input type="number" min={0} value={productForm.deliveryIncentiveCreditCents ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveCreditCents: Number(e.target.value) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>Minimum next order subtotal (cents)
                      <input type="number" min={0} value={productForm.deliveryIncentiveMinOrderSubtotalCents ?? 0} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveMinOrderSubtotalCents: Number(e.target.value) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>Validity window (days)
                      <input type="number" min={1} value={productForm.deliveryIncentiveExpiresDays ?? 60} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveExpiresDays: Number(e.target.value) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888' }}>Code prefix
                      <input type="text" value={productForm.deliveryIncentiveCodePrefix || ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveCodePrefix: e.target.value.toUpperCase() }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Trigger on size(s) CSV
                      <input type="text" value={Array.isArray(productForm.deliveryIncentiveTriggerSizes) ? productForm.deliveryIncentiveTriggerSizes.join(', ') : ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveTriggerSizes: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible product slugs CSV
                      <input type="text" value={Array.isArray(productForm.deliveryIncentiveEligibleProductSlugs) ? productForm.deliveryIncentiveEligibleProductSlugs.join(', ') : ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEligibleProductSlugs: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} style={inputStyle} />
                    </label>
                    <label style={{ fontSize: 10, color: '#888', gridColumn: '1 / -1' }}>Eligible size(s) CSV
                      <input type="text" value={Array.isArray(productForm.deliveryIncentiveEligibleSizes) ? productForm.deliveryIncentiveEligibleSizes.join(', ') : ''} onChange={(e) => setProductForm((p: any) => ({ ...p, deliveryIncentiveEligibleSizes: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) }))} style={inputStyle} />
                    </label>
                  </div>
                </div>

                {/* ===== PRICE CATEGORIES (DYNAMIC) ===== */}
                <div style={{ marginTop: 12, borderTop: '1px solid #27272a', paddingTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h5 style={{ fontSize: 11, color: '#aaa', margin: 0 }}>Price Categories (sizes / variants)</h5>
                    <button onClick={addPriceCategory} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>+ Add Size</button>
                  </div>
                  <p style={{ fontSize: 10, color: '#666', margin: '4px 0 8px' }}>
                    Define each size/variant. Price and Stripe ID are required. Winners per draw controls raffle quantity.
                  </p>
                  {productForm.priceCategories.map((cat: any, idx: number) => (
                    <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', background: '#060606', padding: 8, borderRadius: 6 }}>
                      <input
                        type="text"
                        placeholder="Size (e.g. Standard)"
                        value={cat.size}
                        onChange={(e) => updatePriceCategory(idx, 'size', e.target.value)}
                        style={{ ...inputStyle, width: 100, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="number"
                        placeholder="Price ($)"
                        value={cat.price}
                        onChange={(e) => updatePriceCategory(idx, 'price', Number(e.target.value))}
                        style={{ ...inputStyle, width: 80, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="text"
                        placeholder="Stripe Price ID"
                        value={cat.stripeId}
                        onChange={(e) => updatePriceCategory(idx, 'stripeId', e.target.value)}
                        style={{ ...inputStyle, flex: 1, minWidth: 120, padding: 6, fontSize: 11 }}
                      />
                      <input
                        type="number"
                        min={1}
                        placeholder="Winners / draw"
                        value={cat.winnerTiers}
                        onChange={(e) => updatePriceCategory(idx, 'winnerTiers', String(Math.max(1, Number(e.target.value) || 1)))}
                        style={{ ...inputStyle, width: 120, padding: 6, fontSize: 11 }}
                      />
                      <button onClick={() => removePriceCategory(idx)} style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>✕</button>
                    </div>
                  ))}
                  <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                    <span>💡 If STRIPE_PRODUCT_ID is set, the Stripe ID prefills with <code>{defaultStripePriceId}</code> — you can always override it per size. New sizes start at price <code>{UNCONFIGURED_PRICE_SENTINEL}</code> (obviously-wrong sentinel) until you set a real price; checkout refuses to charge it.</span>
                  </div>
                </div>

                {/* ===== NOTES ===== */}
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

                {/* ===== IMAGES (FILE UPLOAD + URL) ===== */}
                <h5 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 4px' }}>Images (360° rotation) – upload files or paste URLs</h5>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleImageFiles(e.target.files);
                      }
                    }}
                    style={{ ...inputStyle, padding: 6, fontSize: 11, flex: 1 }}
                  />
                  <input
                    type="text"
                    placeholder="Or paste image URL"
                    value={imageInput}
                    onChange={(e) => setImageInput(e.target.value)}
                    style={{ ...inputStyle, flex: 1, padding: 6, fontSize: 11 }}
                  />
                  <button onClick={addImageUrl} style={{ ...buttonGhost, padding: '6px 12px', fontSize: 11 }}>Add URL</button>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(productForm.images || []).map((img: string, idx: number) => (
                    <div key={idx} style={{ position: 'relative', background: '#060606', padding: 4, borderRadius: 4, maxWidth: 60, maxHeight: 60, overflow: 'hidden' }}>
                      <img src={img} alt={`img-${idx+1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <span style={{ fontSize: 8, color: '#888', position: 'absolute', bottom: 0, left: 2, background: 'rgba(0,0,0,0.7)', padding: '0 4px' }}>#{idx+1}</span>
                      <button onClick={() => removeImage(idx)} style={{ ...buttonGhost, padding: '0 4px', fontSize: 8, color: '#f87171', borderColor: '#f87171', position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.5)' }}>✕</button>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                  <span>💡 Uploaded images are stored as data URLs (base64) – for production, consider using cloud storage. The prefix (folder name) is set from the slug.</span>
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
                const isPublished = product.isActive === true;
                const isActive = isPublished && !product.isArchived && !product.isUpcoming;
                const isArchived = product.isArchived;
                const isUpcoming = product.isUpcoming;
                const isHidden = !isPublished;
                return (
                  <div key={product.id} style={{ background: '#09090b', padding: 12, borderRadius: 8, border: `1px solid ${isActive ? '#1c1c1e' : isArchived ? '#5a3d1a' : isUpcoming ? '#1a3a5a' : '#2a1a1a'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{product.name}</div>
                        <div style={{ fontSize: 10, color: '#666' }}>
                          slug: {product.slug} · images: {product.images?.length || 0}
                          {isPublished && <span style={{ color: '#d4d4d8', marginLeft: 8 }}>● Published</span>}
                          {isActive && <span style={{ color: '#34d399', marginLeft: 8 }}>● Active</span>}
                          {isArchived && <span style={{ color: '#f59e0b', marginLeft: 8 }}>● Archived</span>}
                          {isUpcoming && <span style={{ color: '#3b82f6', marginLeft: 8 }}>● Upcoming</span>}
                          {product.soldOutBehavior === 'archive_after_delay' && <span style={{ color: '#d6c29c', marginLeft: 8 }}>● Delayed archive</span>}
                          {isHidden && <span style={{ color: '#f87171', marginLeft: 8 }}>● Hidden</span>}
                          <span style={{ color: '#888', marginLeft: 8 }}>Order: {product.sortOrder || 0}</span>
                        </div>
                        {product.priceCategories && (
                          <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>
                            Sizes: {product.priceCategories.map((c: any) => `${c.size} ($${c.price})`).join(' · ')}
                          </div>
                        )}
                        {(product.goLiveAt || product.releaseEndsAt) && (
                          <div style={{ fontSize: 9, color: '#7c8596', marginTop: 4 }}>
                            {product.goLiveAt ? `Live at ${product.goLiveAt}` : ''}{product.goLiveAt && product.releaseEndsAt ? ' · ' : ''}{product.releaseEndsAt ? `Ends ${product.releaseEndsAt}` : ''}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button onClick={() => editProduct(product)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Edit</button>
                        <button onClick={() => { const newOrder = prompt('New sort order (lower = first):', String(product.sortOrder || 0)); if (newOrder !== null) reorderProducts(product.id, Number(newOrder)); }} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Reorder</button>
                        <button onClick={() => toggleActive(product.id, isPublished)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isPublished ? '#f87171' : '#34d399', color: isPublished ? '#f87171' : '#34d399' }}>
                          {isPublished ? 'Unpublish' : 'Publish'}
                        </button>
                        <button onClick={() => toggleArchive(product.id, isArchived)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isArchived ? '#34d399' : '#f59e0b', color: isArchived ? '#34d399' : '#f59e0b' }}>
                          {isArchived ? 'Unarchive' : 'Archive'}
                        </button>
                        <button onClick={() => toggleUpcoming(product.id, isUpcoming)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, borderColor: isUpcoming ? '#34d399' : '#3b82f6', color: isUpcoming ? '#34d399' : '#3b82f6' }}>
                          {isUpcoming ? 'Remove Upcoming' : 'Upcoming'}
                        </button>
                        <button onClick={() => deleteProduct(product.id)} disabled={productActionLoading} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============ USERS (unchanged) ============ */}
        {tab === 'users' && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>User Accounts</h2>
              <button onClick={() => { setShowUserForm(true); setEditingUser(null); setUserForm({ email: '', password: '', role: 'customer', rewards: 0 }); }} style={buttonPrimary}>
                + Add User
              </button>
            </div>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage user accounts. Users can log in to track entries, manage payment methods, and earn rewards.
            </p>
            
            {userMsg && (
              <p style={{ fontSize: 12, color: userMsg.includes('Error') ? '#f87171' : '#34d399', marginBottom: 10 }}>{userMsg}</p>
            )}

            {showUserForm && (
              <div style={{ background: '#09090b', padding: 16, borderRadius: 12, marginBottom: 16 }}>
                <h4 style={{ margin: '0 0 8px', fontSize: 12, color: '#aaa' }}>{editingUser ? 'Edit User' : 'New User'}</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input type="email" placeholder="Email *" value={userForm.email} onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} style={inputStyle} />
                  <input type="password" placeholder="Password (leave blank to keep current)" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} style={inputStyle} />
                  <select value={userForm.role} onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))} style={inputStyle}>
                    <option value="customer">Customer</option>
                    <option value="admin">Admin</option>
                  </select>
                  <input type="number" placeholder="Rewards Points" value={userForm.rewards} onChange={(e) => setUserForm((f) => ({ ...f, rewards: Number(e.target.value) }))} style={inputStyle} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={saveUser} disabled={productActionLoading} style={buttonPrimary}>{productActionLoading ? 'Saving…' : 'Save User'}</button>
                  <button onClick={() => { setShowUserForm(false); setEditingUser(null); }} style={buttonGhost}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.length === 0 && !usersLoading && (
                <div style={{ textAlign: 'center', padding: 30, color: '#555', border: '1px dashed #333', borderRadius: 12 }}>
                  No users yet. Create your first user account.
                </div>
              )}
              {users.map((user) => (
                <div key={user.id} style={{ background: '#09090b', padding: 12, borderRadius: 8, border: '1px solid #1c1c1e' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{user.email}</div>
                      <div style={{ fontSize: 10, color: '#666' }}>
                        Role: {user.role} · Rewards: {user.rewards || 0}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => { setEditingUser(user.id); setUserForm({ email: user.email, password: '', role: user.role, rewards: user.rewards || 0 }); setShowUserForm(true); }} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10 }}>Edit</button>
                      <button onClick={() => deleteUser(user.id)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============ PROMOTIONS (unchanged) ============ */}
        {tab === 'promotions' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Promotions & Affiliate Codes</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Create promo codes with time limits, max uses, and special discounts for the first X winners.
            </p>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <input placeholder="Code" value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputStyle} />
              <input placeholder="Promoter Name" value={promoForm.promoterName} onChange={(e) => setPromoForm((f) => ({ ...f, promoterName: e.target.value }))} style={inputStyle} />
              <input placeholder="Promoter Email" value={promoForm.promoterEmail} onChange={(e) => setPromoForm((f) => ({ ...f, promoterEmail: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" max="50" placeholder="Customer Discount %" value={promoForm.customerDiscountPercent} onChange={(e) => setPromoForm((f) => ({ ...f, customerDiscountPercent: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" max="50" placeholder="Promoter Payout %" value={promoForm.promoterPayoutPercent} onChange={(e) => setPromoForm((f) => ({ ...f, promoterPayoutPercent: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" placeholder="Max uses per email (0=unlimited)" value={promoForm.maxUsesPerEmail} onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesPerEmail: e.target.value }))} style={inputStyle} />
              <input type="number" min="0" placeholder="Total max uses (0=unlimited)" value={promoForm.maxUsesTotal} onChange={(e) => setPromoForm((f) => ({ ...f, maxUsesTotal: e.target.value }))} style={inputStyle} />
            </div>
            
            <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={promoForm.timeLimited} onChange={(e) => setPromoForm((f) => ({ ...f, timeLimited: e.target.checked }))} />
                Time Limited
              </label>
              {promoForm.timeLimited && (
                <>
                  <label style={{ fontSize: 11 }}>Start Date
                    <input type="datetime-local" value={promoForm.startAt} onChange={(e) => setPromoForm((f) => ({ ...f, startAt: e.target.value }))} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 11 }}>End Date
                    <input type="datetime-local" value={promoForm.endAt} onChange={(e) => setPromoForm((f) => ({ ...f, endAt: e.target.value }))} style={inputStyle} />
                  </label>
                </>
              )}
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
                        timeLimited: p.timeLimited || false,
                        startAt: p.startAt || '',
                        endAt: p.endAt || '',
                        maxUsesTotal: String(p.maxUsesTotal || ''),
                      })} style={buttonGhost}>Edit</button>
                      <button onClick={() => deletePromo(p.code)} style={{ ...buttonGhost, padding: '4px 10px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}>Delete</button>
                    </div>
                  </div>
                  <div style={{ color: '#888', fontSize: 10 }}>
                    Uses: {p.uses || 0} · Revenue: ${Number(p.revenueAttributed || 0).toFixed(2)}
                    {p.timeLimited && p.startAt && p.endAt && ` · Valid: ${new Date(p.startAt).toLocaleDateString()} - ${new Date(p.endAt).toLocaleDateString()}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============ CATALOG (unchanged) ============ */}
        {tab === 'catalog' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Catalog Management</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Manage the "Upcoming Releases" and "Past Archives" sections shown on the catalog page.
              These appear in addition to products pulled from Redis.
            </p>

            {catalogLoading && <p style={{ color: '#888' }}>Loading…</p>}
            {catalogMsg && <p style={{ fontSize: 12, color: catalogMsg.includes('Error') ? '#f87171' : '#34d399', marginBottom: 10 }}>{catalogMsg}</p>}

            <h4 style={{ fontSize: 11, color: '#aaa', marginTop: 12 }}>📅 Upcoming Drops</h4>
            <p style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
              These appear in the "Upcoming Releases" grid on the catalog page. Fill in name, ETA, and image URL.
            </p>
            <div style={{ marginBottom: 12 }}>
              {catalogUpcoming.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#09090b', padding: 6, borderRadius: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={item.name || ''}
                    placeholder="Name *"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], name: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, flex: 1, minWidth: 100, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.eta || ''}
                    placeholder="ETA (e.g. 'Summer 2026')"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], eta: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, width: 120, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.image || ''}
                    placeholder="Image URL"
                    onChange={(e) => {
                      const newList = [...catalogUpcoming];
                      newList[idx] = { ...newList[idx], image: e.target.value };
                      setCatalogUpcoming(newList);
                    }}
                    style={{ ...inputStyle, width: 150, padding: 4, fontSize: 11 }}
                  />
                  <button
                    onClick={() => setCatalogUpcoming(catalogUpcoming.filter((_, i) => i !== idx))}
                    style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setCatalogUpcoming([...catalogUpcoming, { name: '', status: 'Upcoming', eta: '', image: '' }])}
                style={{ ...buttonGhost, padding: '4px 10px', fontSize: 11 }}
              >
                + Add Upcoming
              </button>
            </div>

            <h4 style={{ fontSize: 11, color: '#aaa', marginTop: 12 }}>📦 Past Archives</h4>
            <p style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
              These appear in the "Past Archives" grid. Provide name, image, and a short description.
            </p>
            <div style={{ marginBottom: 12 }}>
              {catalogArchive.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', background: '#09090b', padding: 6, borderRadius: 6, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={item.name || ''}
                    placeholder="Name *"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], name: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, flex: 1, minWidth: 100, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.image || ''}
                    placeholder="Image URL"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], image: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, width: 120, padding: 4, fontSize: 11 }}
                  />
                  <input
                    type="text"
                    value={item.description || ''}
                    placeholder="Short description"
                    onChange={(e) => {
                      const newList = [...catalogArchive];
                      newList[idx] = { ...newList[idx], description: e.target.value };
                      setCatalogArchive(newList);
                    }}
                    style={{ ...inputStyle, width: 180, padding: 4, fontSize: 11 }}
                  />
                  <button
                    onClick={() => setCatalogArchive(catalogArchive.filter((_, i) => i !== idx))}
                    style={{ ...buttonGhost, padding: '2px 6px', fontSize: 10, color: '#f87171', borderColor: '#f87171' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setCatalogArchive([...catalogArchive, { name: '', status: 'Archived', image: '', description: '' }])}
                style={{ ...buttonGhost, padding: '4px 10px', fontSize: 11 }}
              >
                + Add Archive
              </button>
            </div>

            <button onClick={saveCatalogSettings} disabled={catalogLoading} style={buttonPrimary}>
              {catalogLoading ? 'Saving…' : 'Save Catalog Settings'}
            </button>
          </div>
        )}

        {/* ============ GROWTH (unchanged) ============ */}
        {tab === 'growth' && (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Growth & Analytics</h2>
            <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
              Track affiliate payouts and promoter performance.
            </p>
            {promos.length === 0 && <p style={{ color: '#555', fontSize: 12 }}>No promoter data yet.</p>}
            {promos.map((p) => (
              <div key={p.code} style={{ background: '#09090b', padding: 12, borderRadius: 10, marginBottom: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 700 }}>{p.code} - {p.promoterName}</div>
                <div style={{ color: '#888' }}>
                  Revenue: ${Number(p.revenueAttributed || 0).toFixed(2)} · Owed: ${((p.payoutOwedCents || 0) / 100).toFixed(2)}
                </div>
                {p.payoutOwedCents > 0 && (
                  <button onClick={async () => {
                    if (!password) return alert('Enter password');
                    await adminFetch('/api/admin/promos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, action: 'markPaid', code: p.code }) });
                    await fetchPromos();
                  }} style={{ fontSize: 11, color: '#34d399', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    Mark ${((p.payoutOwedCents || 0) / 100).toFixed(2)} as paid
                  </button>
                )}
              </div>
            ))}

            <div style={{ marginTop: 18, borderTop: '1px solid #27272a', paddingTop: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase' }}>Release Alert List</h3>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Capture private-release emails from the storefront and notify the list from here when a product goes live.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <select value={selectedAlertProductId} onChange={(e) => setSelectedAlertProductId(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 180 }}>
                  <option value="">Choose a product to notify</option>
                  {allProducts.map((product) => (
                    <option key={product.id} value={product.id}>{product.name}</option>
                  ))}
                </select>
                <button onClick={notifyReleaseList} style={buttonPrimary}>Notify Release List</button>
                <button onClick={fetchAlerts} style={buttonGhost}>{alertsLoading ? 'Loading…' : 'Refresh'}</button>
              </div>
              {alertsMsg && <p style={{ fontSize: 12, color: alertsMsg.includes('Failed') ? '#f87171' : '#34d399', marginBottom: 10 }}>{alertsMsg}</p>}
              {alerts.length === 0 && !alertsLoading && <p style={{ color: '#555', fontSize: 12 }}>No subscribers yet.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
                {alerts.map((subscriber) => (
                  <div key={subscriber.email} style={{ background: '#09090b', padding: 12, borderRadius: 10, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{subscriber.email}</div>
                        <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>
                          Sources: {(subscriber.sources || []).join(', ') || 'site'} · joined {subscriber.createdAt ? new Date(subscriber.createdAt).toLocaleDateString() : 'n/a'}
                        </div>
                      </div>
                      <button onClick={() => removeAlertSubscriber(subscriber.email)} style={{ ...buttonGhost, color: '#f87171', borderColor: '#f87171' }}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ============ SYSTEM (unchanged) ============ */}
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
                Checks every environment variable (including the Mapbox token), Redis/Stripe connectivity, store config + theme integrity, every product's price/Stripe ID/images, slug uniqueness, winner tiers, inventory, live states, drop pools, and legacy-key hygiene — run this after any config change or before a big drop.
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

            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 6px', fontSize: 13, textTransform: 'uppercase' }}>Redis Cleanup</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 10 }}>
                Deletes legacy redundant keys (product mirror hashes, standalone image keys, and the old catalog_config copy). Products and settings live in single source-of-truth keys, so nothing here removes real data.
              </p>
              <button onClick={organizeRedis} style={buttonGhost}>Clean Up Redis</button>
              {organizeMsg && <p style={{ fontSize: 11, color: organizeMsg.includes('Failed') ? '#f87171' : '#34d399', marginTop: 10 }}>{organizeMsg}</p>}
            </div>
          </div>
        )}

        {/* ============ SETTINGS (unchanged) ============ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardStyle}>
              <h2 style={{ margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase' }}>Site Settings</h2>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 12 }}>
                Edit site appearance and content. Theme colors, card backgrounds/borders, radius, and text colors apply live to product pages and the cart (cached up to ~10s); static pages (home/catalog/legal) are baked at build time, so a redeploy may be needed for those to pick up color changes.
              </p>
              {settingsLoading && <p style={{ color: '#888', fontSize: 11 }}>Loading settings…</p>}
              
              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Design Presets</h4>
              <p style={{ fontSize: 11, color: '#888', marginTop: 0, marginBottom: 10 }}>
                One-click market skins for client onboarding. Applying a preset fills the theme colors, font, border treatment and glow below — then press <strong style={{ color: '#ccc' }}>Save Settings</strong>.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
                {THEME_PRESETS.map((preset) => {
                  const isActive = activePreset === preset.id;
                  return (
                    <div
                      key={preset.id}
                      onClick={() => applyThemePreset(preset.id)}
                      style={{
                        padding: 14,
                        borderRadius: 12,
                        background: '#111',
                        border: `1px solid ${isActive ? preset.accent : '#27272a'}`,
                        cursor: 'pointer',
                        boxShadow: isActive ? `0 0 0 1px ${preset.accent}, 0 14px 30px rgba(0,0,0,0.25)` : 'none',
                        transition: 'border-color 160ms ease',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.background, border: '1px solid rgba(255,255,255,0.14)' }} />
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.container }} />
                        <div style={{ flex: 1, height: 34, borderRadius: 8, background: preset.accent }} />
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{preset.name}</div>
                      <div style={{ fontSize: 10, color: preset.accent, margin: '2px 0 6px', letterSpacing: 1, textTransform: 'uppercase' }}>
                        {preset.fontLabel} · {preset.radiusLabel}
                      </div>
                      <p style={{ fontSize: 11, color: '#a1a1aa', margin: 0, lineHeight: 1.5 }}>{preset.tagline}</p>
                      <button
                        onClick={(e) => { e.stopPropagation(); applyThemePreset(preset.id); }}
                        style={{
                          ...buttonGhost,
                          marginTop: 10,
                          width: '100%',
                          borderColor: isActive ? preset.accent : '#27272a',
                          color: isActive ? preset.accent : '#ccc',
                          fontWeight: 700,
                        }}
                      >
                        {isActive ? '✓ Applied — save' : 'Apply preset'}
                      </button>
                    </div>
                  );
                })}
              </div>

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Theme Colors</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {Object.entries(themeSettings)
                  .filter(([key]) => key !== 'fontFamily' && key !== 'borderRadius' && key !== 'chromeTransparency' && key !== 'surfaceTransparency')
                  .map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input 
                      type="color" 
                      value={String(value || '#000000')} 
                      onChange={(e) => setThemeSettings({ ...themeSettings, [key]: e.target.value })}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 4, height: 40 }} />
                  </label>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Chrome opacity (header / footer / cart drawer)
                  <input
                    type="range"
                    min={40}
                    max={100}
                    value={Number(themeSettings.chromeTransparency ?? 94)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, chromeTransparency: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.chromeTransparency ?? 94)}%</span>
                </label>
                <label style={{ fontSize: 11 }}>
                  Surface opacity (cards on product / catalog pages)
                  <input
                    type="range"
                    min={40}
                    max={100}
                    value={Number(themeSettings.surfaceTransparency ?? 100)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, surfaceTransparency: Number(e.target.value) })}
                    style={{ display: 'block', width: '100%', marginTop: 8 }} />
                  <span style={{ fontSize: 10, color: '#888' }}>{Number(themeSettings.surfaceTransparency ?? 100)}%</span>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Font Family
                  <input
                    type="text"
                    value={String(themeSettings.fontFamily || '')}
                    onChange={(e) => setThemeSettings({ ...themeSettings, fontFamily: e.target.value })}
                    placeholder="e.g. Georgia, serif"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                </label>
                <label style={{ fontSize: 11 }}>
                  Border Radius
                  <select
                    value={String(themeSettings.borderRadius ?? 12)}
                    onChange={(e) => setThemeSettings({ ...themeSettings, borderRadius: Number(e.target.value) })}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, height: 40 }}
                  >
                    <option value="0">Square (0px)</option>
                    <option value="8">Subtle (8px)</option>
                    <option value="12">Default (12px)</option>
                    <option value="999">Fully rounded</option>
                  </select>
                </label>
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

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '12px 0 8px', textTransform: 'uppercase' }}>Branding & Share</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11 }}>
                  Top-right action label
                  <select value={brandingSettings.headerActionMode || 'cart'} onChange={(e) => setBrandingSettings((prev) => ({ ...prev, headerActionMode: e.target.value }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}>
                    <option value="cart">Cart</option>
                    <option value="bag">Bag</option>
                  </select>
                </label>
                <label style={{ fontSize: 11 }}>
                  Logo Upload or URL
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const dataUrl = await fileToDataURL(file);
                      setBrandingSettings((prev) => ({ ...prev, logoUrl: dataUrl }));
                    }}
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 6, height: 40 }}
                  />
                  <input
                    type="text"
                    value={brandingSettings.logoUrl || ''}
                    onChange={(e) => setBrandingSettings((prev) => ({ ...prev, logoUrl: e.target.value }))}
                    placeholder="Or paste a logo URL"
                    style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }}
                  />
                </label>
                {Object.entries({
                  shareTitle: brandingSettings.shareTitle,
                  shareDescription: brandingSettings.shareDescription,
                  shareImageUrl: brandingSettings.shareImageUrl,
                  shareBackground: brandingSettings.shareBackground,
                  shareAccent: brandingSettings.shareAccent,
                  shareText: brandingSettings.shareText,
                  iconBackground: brandingSettings.iconBackground,
                  iconText: brandingSettings.iconText,
                }).map(([key, value]) => (
                  <label key={key} style={{ fontSize: 11 }}>
                    {key.replace(/([A-Z])/g, ' $1').trim()}
                    <input
                      type={key.includes('Background') || key.includes('Accent') || key.includes('Text') ? 'color' : 'text'}
                      value={String(value || '')}
                      onChange={(e) => setBrandingSettings((prev) => ({ ...prev, [key]: e.target.value }))}
                      style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: key.includes('Background') || key.includes('Accent') || key.includes('Text') ? 4 : 10, height: key.includes('Background') || key.includes('Accent') || key.includes('Text') ? 40 : undefined }}
                    />
                  </label>
                ))}
              </div>

              <div style={{ border: `1px solid ${themeSettings.cardBorder || '#27272a'}`, borderRadius: 14, padding: 14, marginBottom: 10, background: brandingSettings.shareImageUrl ? `linear-gradient(180deg, rgba(0,0,0,0.58), rgba(0,0,0,0.64)), url(${brandingSettings.shareImageUrl}) center/cover, ${brandingSettings.shareBackground || '#050505'}` : (brandingSettings.shareBackground || '#050505'), color: brandingSettings.shareText || '#ffffff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  {brandingSettings.logoUrl ? <img src={brandingSettings.logoUrl} alt="Brand preview" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover' }} /> : <div style={{ width: 40, height: 40, borderRadius: 10, background: brandingSettings.shareAccent || '#3b82f6' }} />}
                  <div>
                    <div style={{ fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: brandingSettings.shareAccent || '#3b82f6' }}>GOYUNIR</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{brandingSettings.shareTitle}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.82)' }}>{brandingSettings.shareDescription}</div>
              </div>

              <h4 style={{ fontSize: 11, color: '#aaa', margin: '16px 0 4px', textTransform: 'uppercase' }}>Orb Glow</h4>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>
                Animated glow orbs behind the storefront and inside the top bar. Saved changes apply on the next storefront load (public config is cached up to ~30s).
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(orbSettings.enabled)} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, enabled: e.target.checked }))} />
                Enable glow orbs
              </label>

              {orbSettings.enabled && (
                <>
                  {(['primary', 'secondary', 'tertiary', 'fourth', 'fifth'] as const).map((key) => {
                    const orb = orbSettings[key] || {};
                    return (
                      <div key={key} style={{ border: `1px solid ${themeSettings.cardBorder || '#27272a'}`, borderRadius: 12, padding: 12, marginBottom: 10, background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>{key} orb</div>
                          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input type="checkbox" checked={Boolean(orb.enabled)} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], enabled: e.target.checked } }))} /> Enabled
                          </label>
                        </div>
                        {orb.enabled && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                            <label style={{ fontSize: 11 }}>
                              Color
                              <input type="color" value={orb.color || '#3b82f6'} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], color: e.target.value } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4, padding: 4, height: 40 }} />
                            </label>
                            <label style={{ fontSize: 11 }}>
                              Opacity
                              <input type="range" min={0} max={100} value={Number(orb.opacity) || 0} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], opacity: Number(e.target.value) } }))} style={{ display: 'block', width: '100%', marginTop: 10 }} />
                              <span style={{ fontSize: 10, color: '#888' }}>{Number(orb.opacity) || 0}%</span>
                            </label>
                            <label style={{ fontSize: 11 }}>
                              Size (vw)
                              <input type="number" min={10} max={120} value={Number(orb.size) || 40} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, [key]: { ...prev[key], size: Number(e.target.value) } }))} style={{ ...inputStyle, display: 'block', width: '100%', marginTop: 4 }} />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ border: `1px solid ${themeSettings.cardBorder || '#27272a'}`, borderRadius: 12, padding: 12, marginBottom: 10, background: 'rgba(255,255,255,0.02)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Motion</div>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
                      {([
                        ['idleEnabled', 'Idle drift'],
                        ['pointerEnabled', 'Follow cursor'],
                        ['scrollEnabled', 'Scroll reaction'],
                      ] as [string, string][]).map(([key, label]) => (
                        <label key={key} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="checkbox" checked={Boolean(orbSettings.motion?.[key])} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, motion: { ...prev.motion, [key]: e.target.checked } }))} />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      {([
                        ['intensity', 'Travel distance', 20, 200],
                        ['speed', 'Response speed', 30, 200],
                        ['momentum', 'Momentum / heaviness', 0, 100],
                      ] as [string, string, number, number][]).map(([key, label, min, max]) => (
                        <label key={key} style={{ fontSize: 11 }}>
                          {label}
                          <input type="range" min={min} max={max} value={Number(orbSettings.motion?.[key]) || 0} onChange={(e) => setOrbSettings((prev: any) => ({ ...prev, motion: { ...prev.motion, [key]: Number(e.target.value) } }))} style={{ display: 'block', width: '100%', marginTop: 8 }} />
                          <span style={{ fontSize: 10, color: '#888' }}>{Number(orbSettings.motion?.[key]) || 0}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}

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