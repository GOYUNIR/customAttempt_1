'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import ReleaseWaitlist from '@/components/ReleaseWaitlist';

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
}
interface ActiveDrop {
  id: string;
  name: string;
  tagline: string;
  desc: string;
  slug?: string;
}

export default function CatalogPage() {
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [activeDrops, setActiveDrops] = useState<ActiveDrop[]>([]);
  const [upcomingDrops, setUpcomingDrops] = useState<CatalogItem[]>([]);
  const [archiveScents, setArchiveScents] = useState<CatalogItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const [searchQuery, setSearchQuery] = useState('');

  // Only tick the clock while any tile shows a live countdown (a future
  // goLive/available date) — avoids re-rendering the whole catalog every second.
  const needsClock = [...activeDrops, ...upcomingDrops, ...archiveScents].some((item) => {
    const target = String((item as CatalogItem).goLiveAt || (item as CatalogItem).availableFrom || '');
    if (!target) return false;
    const ms = new Date(target).getTime();
    return Number.isFinite(ms) && ms > Date.now();
  });

  useEffect(() => {
    if (!needsClock) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [needsClock]);

  const formatCountdown = (value?: string) => {
    const target = value ? new Date(value).getTime() : NaN;
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
    fetch('/api/catalog/status')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.activeDrops)) {
          setActiveDrops(data.activeDrops);
        }
        if (Array.isArray(data.upcomingDrops)) {
          setUpcomingDrops(data.upcomingDrops);
        }
        if (Array.isArray(data.archiveScents)) {
          setArchiveScents(data.archiveScents);
        }
      })
      .catch(() => {
        setActiveDrops([]);
        setUpcomingDrops([]);
        setArchiveScents([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleTileClick = (item: CatalogItem) => {
    let slug = item.slug;
    if (!slug) {
      const match = GOYUNIR_STORE_SUITE.productCatalog.find(
        (p) => p.name.toLowerCase() === item.name.toLowerCase(),
      );
      slug = match?.slug;
    }
    if (slug) {
      window.location.href = `/${slug}`;
      return;
    }
    setSelectedItem(item);
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredActiveDrops = activeDrops.filter((drop) => {
    if (!normalizedQuery) return true;
    const haystack = `${drop.name} ${drop.tagline} ${drop.desc}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });
  const filteredUpcomingDrops = upcomingDrops.filter((item) => {
    if (!normalizedQuery) return true;
    const haystack = `${item.name} ${item.description || ''} ${item.status} ${item.eta || ''}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });
  const filteredArchiveScents = archiveScents.filter((item) => {
    if (!normalizedQuery) return true;
    const haystack = `${item.name} ${item.description || ''} ${item.status} ${item.eta || ''}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const renderGrid = (items: CatalogItem[], emptyText: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
      {items.length === 0 && (
        <p style={{ gridColumn: '1 / -1', fontSize: '12px', color: '#777', textAlign: 'center', padding: '30px 0' }}>
          {emptyText}
        </p>
      )}
      {items.map((item) => (
        <motion.button
          key={item.name}
          whileHover={{ y: -3, scale: 1.01 }}
          whileTap={{ scale: 0.985 }}
          onClick={() => handleTileClick(item)}
          style={{
            textAlign: 'left',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
            border: `1px solid ${configPalette.cardBorder}`,
            borderRadius: '16px',
            overflow: 'hidden',
            cursor: 'pointer',
            padding: 0,
            boxShadow: '0 12px 30px rgba(0,0,0,0.16)',
          }}
        >
          <div
            style={{
              width: '100%',
              aspectRatio: '1/1',
              background: item.image ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.34)), url(${item.image}) center/cover` : '#1a1a1a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#777',
              fontSize: '10px',
            }}
          >
            {!item.image && 'NO IMAGE'}
          </div>
          <div style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', color: configPalette.textMain }}>{item.name}</div>
            <div style={{ fontSize: '10px', color: configPalette.textMuted, marginTop: '2px' }}>
              {item.status}
              {item.goLiveAt ? ` · ${formatCountdown(item.goLiveAt) || item.eta || ''}` : item.eta ? ` · ${item.eta}` : ''}
            </div>
          </div>
        </motion.button>
      ))}
    </div>
  );

  return (
    <main
      style={{
        minHeight: 'calc(100vh - 56px)',
        background: 'radial-gradient(circle at top, rgba(59,130,246,0.1), transparent 36%), radial-gradient(circle at 80% 0%, rgba(168,85,247,0.12), transparent 32%), #07070a',
        color: configPalette.textMain,
        padding: '24px 20px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: '480px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: '22px', fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 4px 0', letterSpacing: '1px' }}>Catalog</h1>
            <p style={{ fontSize: '12px', color: configPalette.textMuted, margin: 0 }}>
              Built for attention-scarce traffic: live now, what is next, and what already moved.
            </p>
          </div>
          <Link href="/" style={{ padding: '10px 14px', borderRadius: 999, background: '#f3efe6', color: '#09090b', textDecoration: 'none', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
            View what's active
          </Link>
        </div>
        <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 16, border: `1px solid ${configPalette.cardBorder}`, background: 'rgba(255,255,255,0.02)', fontSize: 12, color: '#d4d4d8', lineHeight: 1.6 }}>
          Upcoming and archived raffle pages can still carry countdown context, collector narrative, and private-entry energy when a brand wants the release story to stay alive.
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          style={{ marginBottom: 20, padding: '10px 12px', borderRadius: 16, border: `1px solid ${configPalette.cardBorder}`, background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: configPalette.accentBlue }}>
            <circle cx="11" cy="11" r="6" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search releases"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: configPalette.textMain, fontSize: 12 }}
          />
          {searchQuery ? (
            <button onClick={() => setSearchQuery('')} style={{ border: 'none', background: 'transparent', color: configPalette.textMuted, cursor: 'pointer', fontSize: 12 }}>
              Clear
            </button>
          ) : null}
        </motion.div>

        {filteredActiveDrops.length > 0 && (
          <>
            <h2
              style={{
                fontSize: '13px',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                color: configPalette.textMain,
                margin: '0 0 12px 0',
              }}
            >
              🧴 Currently Available
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '32px' }}>
              {filteredActiveDrops.map((drop) => (
                <Link
                  key={drop.id}
                  href={drop.slug ? `/${drop.slug}` : '/'}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <div
                    style={{
                      background: configPalette.cardBackground,
                      border: `1px solid ${configPalette.cardBorder}`,
                      borderRadius: '14px',
                      padding: '14px 16px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 'bold' }}>{drop.name}</div>
                    <div style={{ fontSize: '10px', color: configPalette.textMuted, marginTop: '2px' }}>{drop.tagline}</div>
                    <div style={{ fontSize: '10px', color: '#d6c29c', marginTop: 6 }}>Limited handmade supply. Open while allocation remains.</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        <h2
          style={{
            fontSize: '13px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: configPalette.accentBlue,
            margin: '0 0 12px 0',
          }}
        >
          Upcoming Releases
        </h2>
        {renderGrid(filteredUpcomingDrops, isLoading ? 'Loading…' : (normalizedQuery ? 'No releases matched your search.' : 'No upcoming releases announced yet.'))}

        <h2
          style={{
            fontSize: '13px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: configPalette.accentPurple,
            margin: '32px 0 12px 0',
          }}
        >
          Past Archives
        </h2>
        {renderGrid(filteredArchiveScents, isLoading ? 'Loading…' : (normalizedQuery ? 'No archives matched your search.' : 'No archived items yet.'))}

        {filteredActiveDrops.length === 0 && filteredUpcomingDrops.length === 0 && filteredArchiveScents.length === 0 && !isLoading && (
          <div style={{ marginTop: 24 }}>
            <ReleaseWaitlist
              source="catalog"
              headline="Nothing public yet? Get the next release before everyone else does."
              body="This list is for quiet launch notices, not noise. Brands can notify the list directly from the admin portal when a new raffle or FCFS product goes live."
            />
          </div>
        )}
      </div>

      <AnimatePresence>
        {selectedItem && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedItem(null)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.75)',
              backdropFilter: 'blur(10px)',
              zIndex: 300,
              display: 'flex',
              alignItems: 'flex-end',
            }}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                maxWidth: '480px',
                margin: '0 auto',
                background: '#0e0e10',
                borderRadius: '24px 24px 0 0',
                padding: '24px 20px 40px',
                boxSizing: 'border-box',
              }}
            >
              <div
                style={{
                  width: '100%',
                  aspectRatio: '4/3',
                  borderRadius: '16px',
                  background: selectedItem.image ? `url(${selectedItem.image}) center/cover` : '#1a1a1a',
                  marginBottom: '16px',
                }}
              />
              <h3 style={{ fontSize: '18px', fontFamily: 'serif', margin: '0 0 4px 0' }}>{selectedItem.name}</h3>
              <div style={{ fontSize: '11px', color: configPalette.textMuted, marginBottom: '12px' }}>
                {selectedItem.status}
              </div>
              {selectedItem.description && (
                <p style={{ fontSize: '13px', lineHeight: '1.6', color: '#ccc', margin: '0 0 20px 0' }}>
                  {selectedItem.description}
                </p>
              )}
              <button
                onClick={() => setSelectedItem(null)}
                style={{
                  width: '100%',
                  padding: '14px',
                  borderRadius: '30px',
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}