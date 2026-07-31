'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

interface CatalogItem {
  name: string;
  status: string;
  eta?: string;
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
  const [upcomingDrops, setUpcomingDrops] = useState<CatalogItem[]>(
    GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
  );
  const [archiveScents, setArchiveScents] = useState<CatalogItem[]>(
    GOYUNIR_STORE_SUITE.catalogPreview.archiveScents,
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/catalog/status')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.activeDrops)) setActiveDrops(data.activeDrops);
        if (Array.isArray(data.upcomingDrops)) setUpcomingDrops(data.upcomingDrops);
        if (Array.isArray(data.archiveScents)) setArchiveScents(data.archiveScents);
      })
      .catch(() => {})
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

  const renderGrid = (items: CatalogItem[], emptyText: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
      {items.length === 0 && (
        <p style={{ gridColumn: '1 / -1', fontSize: '12px', color: '#555', textAlign: 'center', padding: '30px 0' }}>
          {emptyText}
        </p>
      )}
      {items.map((item) => (
        <button
          key={item.name}
          onClick={() => handleTileClick(item)}
          style={{
            textAlign: 'left',
            background: configPalette.cardBackground,
            border: `1px solid ${configPalette.cardBorder}`,
            borderRadius: '16px',
            overflow: 'hidden',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <div
            style={{
              width: '100%',
              aspectRatio: '1/1',
              background: item.image ? `url(${item.image}) center/cover` : '#1a1a1a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#444',
              fontSize: '10px',
            }}
          >
            {!item.image && 'IMAGE PENDING'}
          </div>
          <div style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', color: configPalette.textMain }}>{item.name}</div>
            <div style={{ fontSize: '10px', color: configPalette.textMuted, marginTop: '2px' }}>
              {item.status}
              {item.eta ? ` · ${item.eta}` : ''}
            </div>
          </div>
        </button>
      ))}
    </div>
  );

  return (
    <main
      style={{
        minHeight: '100vh',
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        padding: '80px 20px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: '480px', margin: '0 auto' }}>
        <Link
          href="/"
          style={{
            fontSize: '11px',
            color: configPalette.textMuted,
            textDecoration: 'none',
            display: 'inline-block',
            marginBottom: '24px',
          }}
        >
          ← Back to storefront
        </Link>
        <h1 style={{ fontSize: '20px', fontFamily: 'serif', margin: '0 0 4px 0', letterSpacing: '1px' }}>Catalog</h1>
        <p style={{ fontSize: '12px', color: configPalette.textMuted, margin: '0 0 24px 0' }}>
          Tap an archived scent to open its page and save a spot for the return.
        </p>

        {activeDrops.length > 0 && (
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
              🧴 Currently Allocating
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '32px' }}>
              {activeDrops.map((drop) => (
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
          👔 Clothing Line
        </h2>
        {renderGrid(upcomingDrops, 'Nothing announced yet — check back soon.')}

        <h2
          style={{
            fontSize: '13px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: configPalette.accentPurple,
            margin: '32px 0 12px 0',
          }}
        >
          🧪 Past Scents Archive
        </h2>
        {renderGrid(archiveScents, isLoading ? 'Loading…' : 'No archived scents yet.')}
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