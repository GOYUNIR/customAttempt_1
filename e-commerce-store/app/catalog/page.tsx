'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import ReleaseWaitlist from '@/components/ReleaseWaitlist';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { notifyDropDue } from '@/lib/client-auto-draw';
import { useLiveTheme } from '@/components/ThemeProvider';
import { surfaceBackground, themeRadius, themeRadiusNumber, cardSheen, cardShadowStyle } from '@/lib/storefront-config';
import { dropTimestampToMsOrNaN } from '@/lib/drop-timestamps';
import { isVideoMedia } from '@/lib/media';

interface CatalogItem {
  name: string;
  status: string;
  eta?: string;
  goLiveAt?: string;
  image?: string;
  description?: string;
  availableFrom?: string;
  availableUntil?: string;
  slug?: string;
  checkoutMode?: string;
  isRaffle?: boolean;
  soldOutAt?: string;
  isActive?: boolean;
  inventoryRemaining?: number;
  totalInventory?: number;
  categories?: string[];
}
interface ActiveDrop {
  id: string;
  name: string;
  tagline: string;
  desc: string;
  slug?: string;
  soldOut?: boolean;
  checkoutMode?: string;
  isRaffle?: boolean;
  goLiveAt?: string;
  releaseEndsAt?: string;
  categories?: string[];
}

/** Valid /catalog section ids + sanitizer (module-scope so hooks deps stay stable).
 * The append-order doubles as the fallback default: Upcoming → Past Archives →
 * Currently Available (live at the BOTTOM). */
const VALID_SECTIONS = ['upcoming', 'archive', 'live'] as const;
function sanitizeSectionOrder(arr: unknown): string[] {
  const list = Array.isArray(arr) ? arr.map(String) : [];
  const valid = list.filter((s) => (VALID_SECTIONS as readonly string[]).includes(s));
  for (const s of VALID_SECTIONS) if (!valid.includes(s)) valid.push(s);
  return valid;
}

export default function CatalogPage() {
  // Live theme palette — initialized from the server-baked /admin → Settings
  // theme (no flash) and upgraded to whatever /api/store serves so design
  // presets (e.g. a white Luxury background) apply to the catalog too.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [activeDrops, setActiveDrops] = useState<ActiveDrop[]>([]);
  const [upcomingDrops, setUpcomingDrops] = useState<CatalogItem[]>([]);
  const [archiveScents, setArchiveScents] = useState<CatalogItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [clock, setClock] = useState<number>(() => (typeof window !== 'undefined' ? Date.now() : 0));
  // Store drop timezone — naive product timestamps are interpreted in this zone
  // (never the viewer's local zone) so countdowns + draw triggers agree with the
  // server. Populated from /api/catalog/status; defaults to the static config.
  const [storeTimezone, setStoreTimezone] = useState<string>(
    String(liveCtx?.dropSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles'),
  );
  const [searchQuery, setSearchQuery] = useState('');
  // Product categories (admin-managed list from Settings → Catalog). Loaded from
  // the live theme + /api/store + /api/catalog/status; drives the filter chips.
  const [categories, setCategories] = useState<string[]>(() =>
    // An EMPTY array is a real state: the operator deleted every category.
    // Only fall back to the static defaults when the live theme carries NO
    // catalog config at all (e.g. a pre-seed store).
    Array.isArray(liveCtx?.catalog?.categories)
      ? liveCtx.catalog.categories
      : (GOYUNIR_STORE_SUITE.catalog as any)?.categories || [],
  );
  const [selectedCategory, setSelectedCategory] = useState('');
  // Perf: skip rendering + painting of catalog sections until they're near the
  // viewport (content-visibility: auto), and reserve layout height so scroll
  // never jumps. Cast as any — React's CSSProperties doesn't type these yet.
  const SECTION_CV = { contentVisibility: 'auto', containIntrinsicSize: 'auto 280px' } as any;
  // Live /api/store product payload (lifecycle-enriched) so upcoming/archive
  // cards can show real entry state, drop type, and sold-out dates.
  const [liveProducts, setLiveProducts] = useState<any[]>([]);
  const router = useRouter();
  // Catalog section order — admin-configurable from /admin → Settings → Catalog.
  // Default: live ("Currently Available") at the BOTTOM.
  const [catalogOrder, setCatalogOrder] = useState<string[]>(() =>
    sanitizeSectionOrder(liveCtx?.catalog?.sectionOrder),
  );
  // Navigation feedback: the catalog stays mounted while Next fetches the
  // product page's RSC payload, so on a slow connection a tile tap could
  // otherwise look unhandled. This overlay announces the tap instantly.
  const [navigating, setNavigating] = useState<string | null>(null);
  const [statusError, setStatusError] = useState('');

  // Only tick the clock while any tile shows a live countdown (a future
  // goLive/available date) — avoids re-rendering the whole catalog every second.
  const needsClock = [...activeDrops, ...upcomingDrops, ...archiveScents].some((item) => {
    const target = String((item as CatalogItem).goLiveAt || (item as CatalogItem).availableFrom || (item as ActiveDrop).releaseEndsAt || '');
    if (!target) return false;
    const ms = dropTimestampToMsOrNaN(target, storeTimezone);
    return Number.isFinite(ms) && ms > clock;
  });

  useEffect(() => {
    if (!needsClock) return;
    const tick = () => setClock(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [needsClock]);

  // When any tile's countdown reaches zero, tell the server to run the drop
  // NOW (go-live activation for upcoming items, draw for ended raffles). Fires
  // once per tile per page session — the server dedupes across visitors.
  const loadCatalog = useCallback(async () => {
    setIsLoading(true);
    setStatusError('');
    try {
      // Route through fetchStoreJson: dedupes with the rest of the site and
      // retries timeouts once, so a flaky connection still renders the
      // catalog instead of an empty page.
      const data = await fetchStoreJson('/api/catalog/status');
      if (Array.isArray(data.activeDrops)) {
        setActiveDrops(data.activeDrops);
      }
      if (Array.isArray(data.upcomingDrops)) {
        setUpcomingDrops(data.upcomingDrops);
      }
      if (Array.isArray(data.archiveScents)) {
        setArchiveScents(data.archiveScents);
      }
      if (Array.isArray(data.sectionOrder)) {
        setCatalogOrder(sanitizeSectionOrder(data.sectionOrder));
      }
      if (Array.isArray(data.categories)) {
        setCategories(data.categories);
      }
      if (data.storeTimezone) setStoreTimezone(String(data.storeTimezone));
    } catch {
      setActiveDrops([]);
      setUpcomingDrops([]);
      setArchiveScents([]);
      setStatusError('Could not load the catalog — check your connection and tap retry.');
    } finally {
      setIsLoading(false);
    }
  }, []);
  const dropNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!clock) return;
    const consider = (item: CatalogItem | ActiveDrop) => {
      const slug = String(item.slug || item.name || '');
      if (dropNotifiedRef.current.has(slug)) return;
      const target = String((item as CatalogItem).goLiveAt || (item as CatalogItem).availableFrom || (item as ActiveDrop).releaseEndsAt || '');
      const ms = target ? dropTimestampToMsOrNaN(target, storeTimezone) : NaN;
      if (Number.isFinite(ms) && ms <= clock) {
        dropNotifiedRef.current.add(slug);
        notifyDropDue({ productId: String((item as ActiveDrop).id || ''), productName: String(item.name || ''), slug });
        // Refresh so the item moves sections immediately (e.g. an upcoming
        // product whose go-live passed becomes a live drop on screen).
        loadCatalog();
      }
    };
    [...activeDrops, ...upcomingDrops, ...archiveScents].forEach(consider);
  }, [clock, activeDrops, upcomingDrops, archiveScents, loadCatalog, storeTimezone]);

  const formatCountdown = (value?: string) => {
    const target = value ? dropTimestampToMsOrNaN(value, storeTimezone) : NaN;
    if (!Number.isFinite(target)) return null;
    const diff = target - clock;
    if (diff <= 0) return 'Live now';
    const total = Math.floor(diff / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  };

  useEffect(() => {
    loadCatalog();
    // Pull the live theme (deduped/cached by client-store-cache) so preset
    // background/text colors apply to this statically-built page shell.
    fetchStoreJson('/api/store').then((data) => {
      if (data?.config?.themeColors) {
        setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      }
      if (data?.config?.catalog?.sectionOrder) {
        setCatalogOrder(sanitizeSectionOrder(data.config.catalog.sectionOrder));
      }
      if (Array.isArray(data?.config?.catalog?.categories)) {
        setCategories(data.config.catalog.categories);
      }
      if (Array.isArray(data?.allProducts)) {
        setLiveProducts(data.allProducts);
      }
    }).catch(() => {});
  }, [loadCatalog]);

  const handleTileClick = (item: CatalogItem) => {
    let slug = item.slug;
    if (!slug) {
      const match = GOYUNIR_STORE_SUITE.productCatalog.find(
        (p) => p.name.toLowerCase() === item.name.toLowerCase(),
      );
      slug = match?.slug;
    }
    if (slug) {
      // Client-side nav keeps the page responsive; the "Opening…" overlay
      // tells the user the tap registered while the product page loads.
      setNavigating(item.name);
      router.push(`/${slug}`);
      return;
    }
    setSelectedItem(item);
  };

  // Safety net: if a navigation is interrupted (offline, slow), clear the
  // overlay after a few seconds so the catalog never stays dimmed.
  useEffect(() => {
    if (!navigating) return;
    const timer = window.setTimeout(() => setNavigating(null), 4000);
    return () => window.clearTimeout(timer);
  }, [navigating]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  // Category filter: a product matches when ANY of its tags equals the selected
  // category (items without tags only show under "All categories").
  const matchesCategory = (cats: string[] | undefined) => {
    if (!selectedCategory) return true;
    return (Array.isArray(cats) ? cats : []).some((c) => String(c).toLowerCase() === selectedCategory.toLowerCase());
  };
  const filteredActiveDrops = activeDrops.filter((drop) => {
    if (!normalizedQuery) return matchesCategory(drop.categories);
    const haystack = `${drop.name} ${drop.tagline} ${drop.desc}`.toLowerCase();
    return haystack.includes(normalizedQuery) && matchesCategory(drop.categories);
  });

  // ── Catalog consistency ────────────────────────────────────────────────────
  // The status endpoint (15s TTL) and the store endpoint (10s TTL) can briefly
  // disagree about a product's lifecycle (e.g. goLiveAt just passed). Reconcile
  // client-side so a product NEVER shows in both "Currently Available" and
  // "Upcoming Releases", and an item that went live (or was archived) is never
  // still advertised as upcoming. Products derived from the live payload always
  // win — the same classification the home page and product page use.
  const liveBySlug = new Map(
    (liveProducts || []).map((p: any) => [String(p.slug || '').toLowerCase(), p]),
  );
  const allActiveSlugs = new Set(activeDrops.map((d) => String(d.slug || '').toLowerCase()));

  const consistentUpcoming = upcomingDrops.filter((item) => {
    const key = String(item.slug || '').toLowerCase();
    const live = key ? liveBySlug.get(key) : null;
    if (live) {
      const isLiveNow = live.isActive === true && live.isUpcoming !== true && live.isArchived !== true;
      const isArchived = live.isArchived === true;
      if (isLiveNow || isArchived) return false;
    }
    // Belt and braces: never list an item that the same payload already shows
    // as a live drop.
    return !allActiveSlugs.has(key);
  });

  const filteredUpcomingDrops = consistentUpcoming.filter((item) => {
    if (!normalizedQuery) return matchesCategory(item.categories);
    const haystack = `${item.name} ${item.description || ''} ${item.status} ${item.eta || ''}`.toLowerCase();
    return haystack.includes(normalizedQuery) && matchesCategory(item.categories);
  });
  const filteredArchiveScents = archiveScents.filter((item) => {
    if (!normalizedQuery) return matchesCategory(item.categories);
    const haystack = `${item.name} ${item.description || ''} ${item.status} ${item.eta || ''}`.toLowerCase();
    return haystack.includes(normalizedQuery) && matchesCategory(item.categories);
  });

  const renderGrid = (items: CatalogItem[], emptyText: string, section: 'upcoming' | 'archive') => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
      {items.length === 0 && (
        <p style={{ gridColumn: '1 / -1', fontSize: '12px', color: '#777', textAlign: 'center', padding: '30px 0' }}>
          {emptyText}
        </p>
      )}
      {items.map((item) => {
        // Enrich with the live /api/store payload (theme + lifecycle) when
        // available, so upcoming/archive cards show real entry state, drop
        // type, and sold-out dates instead of relying on static catalog rows.
        const liveProduct = liveProducts.find(
          (p: any) =>
            String(p.slug || '').toLowerCase() === String(item.slug || '').toLowerCase() ||
            String(p.name || '').toLowerCase() === String(item.name || '').toLowerCase(),
        );
        const inventoryRemaining = Number(liveProduct?.inventoryRemaining ?? item.inventoryRemaining ?? 0);
        const isEnterable = (liveProduct?.isActive ?? item.isActive) === true && inventoryRemaining > 0;
        const checkoutMode = String(liveProduct?.checkoutMode || item.checkoutMode || '').toUpperCase();
        const isRaffle = checkoutMode === 'RAFFLE' || liveProduct?.isRaffle === true || item.isRaffle === true;
        // Mixed-format release: some sizes run a raffle, others sell instantly.
        const sizeModes = Array.isArray(liveProduct?.priceCategories)
          ? (liveProduct.priceCategories as any[]).map((c: any) => String(c?.checkoutMode || '').toUpperCase()).filter((m: string) => m === 'RAFFLE' || m === 'FCFS')
          : [];
        const mixedFormats = sizeModes.includes('RAFFLE') && sizeModes.includes('FCFS');
        const soldOutAt = String(liveProduct?.soldOutAt || item.soldOutAt || '').trim();
        const soldOutDate = soldOutAt
          ? (() => {
              const d = new Date(soldOutAt);
              return Number.isNaN(d.getTime()) ? '' : `Sold out ${d.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`;
            })()
          : '';
        const upcomingBadge = item.goLiveAt
          ? (() => {
              const countdown = formatCountdown(item.goLiveAt);
              if (countdown) return `ENTRIES OPEN — ${countdown}`;
              const d = new Date(item.goLiveAt);
              return Number.isNaN(d.getTime())
                ? 'ENTER BEFORE DROP'
                : `ENTRIES OPEN — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            })()
          : 'ENTER BEFORE DROP';
        // Archived releases get the same attention chip as upcoming ones, with
        // wording that matches their real state (seeded archives carry a
        // goLiveAt/soldOut story; manually archived items fall back gracefully).
        const archiveBadge =
          section === 'archive'
            ? isEnterable
              ? { text: 'STILL OPEN — ENTER NOW', green: true }
              : isRaffle
                ? { text: 'DRAW COMPLETE — SOLD OUT', green: false }
                : soldOutDate
                  ? { text: 'SOLD OUT — DROP COMPLETE', green: false }
                  : { text: 'PREVIOUSLY RELEASED', green: false }
            : null;
        return (
          <button
            key={item.name}
            onClick={() => handleTileClick(item)}
            className="goyunir-catalog-tile"
            style={{
              textAlign: 'left',
              background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))'),
              backgroundImage: cardSheen,
              border: `1px solid ${configPalette.cardBorder}`,
              borderRadius: themeRadius(configPalette, 16),
              overflow: 'hidden',
              cursor: 'pointer',
              padding: 0,
              boxShadow: cardShadowStyle(configPalette, 14),
            }}
          >
            <div
              style={{
                width: '100%',
                aspectRatio: '1/1',
                background: item.image && !isVideoMedia(item.image) ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.34)), url(${item.image}) center/cover` : '#1a1a1a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#777',
                fontSize: '10px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {item.image && isVideoMedia(item.image) ? (
                <video src={item.image} muted loop autoPlay playsInline preload="metadata" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
              ) : null}
              {!item.image && 'NO IMAGE'}
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: '12px', fontWeight: 'bold', color: configPalette.cardTextMain }}>{item.name}</div>
              <div style={{ fontSize: '10px', color: configPalette.cardTextMuted || '#a1a1aa', marginTop: '2px' }}>
                {item.status}
                {item.goLiveAt ? ` · ${formatCountdown(item.goLiveAt) || item.eta || ''}` : item.eta ? ` · ${item.eta}` : ''}
            </div>
            {item.description && (
              <div style={{ fontSize: '10px', color: configPalette.cardTextMuted || '#a1a1aa', marginTop: '4px', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
                {item.description}
              </div>
            )}
            {section === 'upcoming' && (
              <div style={{ marginTop: 8, display: 'inline-block', padding: '4px 8px', borderRadius: 999, fontSize: 9, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', background: 'rgba(250,204,21,0.12)', color: '#facc15', border: '1px solid rgba(250,204,21,0.35)' }}>
                {upcomingBadge}
              </div>
            )}
            {section === 'archive' && archiveBadge && (
              <div style={{ marginTop: 8, display: 'inline-block', padding: '4px 8px', borderRadius: 999, fontSize: 9, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', background: archiveBadge.green ? 'rgba(52,211,153,0.12)' : 'rgba(250,204,21,0.12)', color: archiveBadge.green ? '#34d399' : '#facc15', border: `1px solid ${archiveBadge.green ? 'rgba(52,211,153,0.35)' : 'rgba(250,204,21,0.35)'}` }}>
                {archiveBadge.text}
              </div>
            )}
            {(section === 'upcoming' || section === 'archive') && (isRaffle || checkoutMode === 'FCFS' || mixedFormats || (section === 'archive' && soldOutDate)) && (
              <div style={{ marginTop: 6, fontSize: 9, color: configPalette.cardTextMuted || '#a1a1aa', letterSpacing: '0.5px' }}>
                {mixedFormats ? 'Raffle + FCFS' : (isRaffle || checkoutMode === 'FCFS') ? (isRaffle ? 'Raffle' : 'FCFS') : ''}
                {section === 'archive' && soldOutDate && ((isRaffle || checkoutMode === 'FCFS' || mixedFormats) ? ` · ${soldOutDate}` : soldOutDate)}
              </div>
            )}
          </div>
        </button>
        );
      })}
    </div>
  );

  return (
    <main
      style={{
        minHeight: 'calc(100vh - 56px)',
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        padding: '24px 20px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: '480px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: '22px', fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 4px 0', letterSpacing: '1px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              CATALOG
            </h1>
            <p style={{ fontSize: '12px', color: configPalette.textMuted, margin: 0 }}>
              Built for attention-scarce traffic: live now, what is next, and what already moved.
            </p>
          </div>
          <Link href="/" prefetch={false} style={{ padding: '10px 14px', borderRadius: 999, background: '#f3efe6', color: '#09090b', textDecoration: 'none', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
            View what&apos;s active
          </Link>
        </div>
        <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: themeRadius(configPalette, 16), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, 'rgba(255,255,255,0.02)'), fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.6 }}>
          Live releases are open for entry right now. Upcoming and archived drops stay on the record so collectors can see the full story and get ahead of the next opening.
        </div>

        <div
          className="goyunir-anim-fade-up"
          style={{ marginBottom: 20, padding: '10px 12px', borderRadius: themeRadius(configPalette, 16), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, 'rgba(255,255,255,0.03)'), display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: configPalette.accentBlue }}>
            <circle cx="11" cy="11" r="6" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search releases"
            className="goyunir-ph"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: configPalette.cardTextMain, fontSize: 12 }}
          />
          {searchQuery ? (
            <button onClick={() => setSearchQuery('')} style={{ border: 'none', background: 'transparent', color: configPalette.cardTextMuted, cursor: 'pointer', fontSize: 12 }}>
              Clear
            </button>
          ) : null}
        </div>

        {/* Category filter — the admin-managed product tag list. Tap a chip to
            show only releases in that category. */}
        {categories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {['', ...categories].map((cat) => {
              const active = selectedCategory === cat;
              const key = cat || '__all__';
              return (
                <button
                  key={key}
                  onClick={() => setSelectedCategory(active ? '' : cat)}
                  style={{
                    padding: '6px 13px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: active ? `1px solid ${configPalette.checkoutCtaButton || '#60a5fa'}` : `1px solid ${configPalette.cardBorder}`,
                    background: active ? (configPalette.checkoutCtaButton ? `color-mix(in srgb, ${configPalette.checkoutCtaButton} 18%, transparent)` : 'rgba(96,165,250,0.18)') : 'transparent',
                    color: active ? (configPalette.checkoutCtaButton || '#93c5fd') : configPalette.cardTextMuted,
                  }}
                >
                  {cat || 'All categories'}
                </button>
              );
            })}
          </div>
        )}

        {statusError && (
          <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: themeRadius(configPalette, 12), border: '1px solid rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.08)', fontSize: 12, color: '#fca5a5', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
            <span>{statusError}</span>
            <button onClick={loadCatalog} style={{ border: 'none', background: 'rgba(248,113,113,0.18)', color: '#fecaca', borderRadius: 999, padding: '6px 12px', fontWeight: 700, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>Retry</button>
          </div>
        )}

        {isLoading && filteredActiveDrops.length === 0 && filteredUpcomingDrops.length === 0 && filteredArchiveScents.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '40px 0', color: configPalette.textMuted }}>
            <div style={{ width: 30, height: 30, borderRadius: 999, background: 'radial-gradient(circle, #3b82f6 0%, #a855f7 55%, transparent 72%)', animation: 'goyunirSpin 1.1s linear infinite, goyunirPulse 1.6s ease-in-out infinite' }} />
            <div style={{ fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase' }}>Loading the catalog</div>
          </div>
        )}

        {catalogOrder.map((section, sectionIndex) => {
          const topMargin = sectionIndex === 0 ? '0 0 12px 0' : '32px 0 12px 0';
          if (section === 'live') {
            if (filteredActiveDrops.length === 0) return null;
            return (
              <div key="live" style={{ ...SECTION_CV }}>
                <h2
                  style={{
                    fontSize: '13px',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    color: configPalette.textMain,
                    margin: topMargin,
                  }}
                >
                  Currently Available
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {filteredActiveDrops.map((drop) => (
                    <Link
                      key={drop.id}
                      href={drop.slug ? `/${drop.slug}` : '/'}
                      prefetch={false}
                      style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: themeRadius(configPalette, 14) }}
                    >
                      <div
                        style={{
                          background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, configPalette.cardBackground),
                          backgroundImage: cardSheen,
                          border: `1px solid ${configPalette.cardBorder}`,
                          borderRadius: themeRadius(configPalette, 14),
                          padding: '14px 16px',
                        }}
                      >
                        <div style={{ fontSize: '13px', fontWeight: 'bold', color: configPalette.cardTextMain }}>{drop.name}</div>
                        <div style={{ fontSize: '10px', color: configPalette.cardTextMuted, marginTop: '2px' }}>{drop.tagline}</div>
                        <div style={{ fontSize: '10px', color: drop.soldOut ? '#eab308' : configPalette.cardTextMuted, marginTop: 6 }}>{drop.soldOut ? 'Sold out — fully spoken for. Stays visible as proof of demand.' : `Limited handmade supply. Open while allocation remains.${drop.isRaffle !== undefined ? ` · ${drop.isRaffle ? 'Raffle' : 'FCFS'}` : ''}`}</div>
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', fontWeight: 700, color: configPalette.accentBlue }}>
                          {drop.soldOut ? 'View release story' : 'Enter allocation'} <span>→</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          }
          if (section === 'upcoming') {
            return (
              <div key="upcoming" style={{ ...SECTION_CV }}>
                <h2
                  style={{
                    fontSize: '13px',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                    color: configPalette.accentBlue,
                    margin: topMargin,
                  }}
                >
                  Upcoming Releases
                </h2>
                {renderGrid(filteredUpcomingDrops, isLoading ? 'Loading…' : (normalizedQuery ? 'No releases matched your search.' : 'No upcoming releases announced yet.'), 'upcoming')}
              </div>
            );
          }
          return (
            <div key="archive" style={{ ...SECTION_CV }}>
              <h2
                style={{
                  fontSize: '13px',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  color: configPalette.accentPurple,
                  margin: topMargin,
                }}
              >
                Past Archives
              </h2>
              {renderGrid(filteredArchiveScents, isLoading ? 'Loading…' : (normalizedQuery ? 'No archives matched your search.' : 'No archived items yet.'), 'archive')}
            </div>
          );
        })}

        {filteredActiveDrops.length === 0 && filteredUpcomingDrops.length === 0 && filteredArchiveScents.length === 0 && !isLoading && !statusError && (
          <div style={{ marginTop: 24 }}>
            <ReleaseWaitlist
              source="catalog"
              headline="Nothing public yet? Get the next release before everyone else does."
              body="This list is for quiet launch notices, not noise. Brands can notify the list directly from the admin portal when a new raffle or FCFS product goes live."
              palette={configPalette}
            />
          </div>
        )}
      </div>

      {selectedItem && (
        <div
          className="goyunir-anim-fade-in"
          onClick={() => setSelectedItem(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.82)',
            zIndex: 300,
            display: 'flex',
            alignItems: 'flex-end',
          }}
        >
          <div
            className="goyunir-anim-sheet-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '480px',
              margin: '0 auto',
              background: configPalette.cardBackground,
              borderRadius: `${themeRadiusNumber(configPalette, 24)}px ${themeRadiusNumber(configPalette, 24)}px 0 0`,
              padding: '24px 20px 40px',
              boxSizing: 'border-box',
            }}
          >
              <div
                style={{
                  width: '100%',
                  aspectRatio: '4/3',
                  borderRadius: themeRadius(configPalette, 16),
                  background: selectedItem.image && !isVideoMedia(selectedItem.image) ? `url(${selectedItem.image}) center/cover` : '#1a1a1a',
                  marginBottom: '16px',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                {selectedItem.image && isVideoMedia(selectedItem.image) ? (
                  <video src={selectedItem.image} controls playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : null}
              </div>
              <h3 style={{ fontSize: '18px', fontFamily: 'serif', margin: '0 0 4px 0', color: configPalette.cardTextMain }}>{selectedItem.name}</h3>
              <div style={{ fontSize: '11px', color: configPalette.cardTextMuted, marginBottom: '12px' }}>
                {selectedItem.status}
              </div>
              {selectedItem.description && (
                <p style={{ fontSize: '13px', lineHeight: '1.6', color: configPalette.cardTextMuted, margin: '0 0 20px 0', whiteSpace: 'pre-line' }}>
                  {selectedItem.description}
                </p>
              )}
              <button
                onClick={() => setSelectedItem(null)}
                style={{
                  width: '100%',
                  padding: '14px',
                  borderRadius: 999,
                  background: configPalette.textMain,
                  color: configPalette.primaryBackground,
                  border: 'none',
                  fontWeight: 'bold',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        )
      }

      {navigating && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.72)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: '#fff' }}>
          <div style={{ width: 34, height: 34, borderRadius: 999, background: 'radial-gradient(circle, #3b82f6 0%, #a855f7 55%, transparent 72%)', animation: 'goyunirSpin 1.1s linear infinite, goyunirPulse 1.6s ease-in-out infinite' }} />
          <div style={{ fontSize: 12, letterSpacing: '2px', textTransform: 'uppercase' }}>Opening {navigating}…</div>
        </div>
      )}
    </main>
  );
}