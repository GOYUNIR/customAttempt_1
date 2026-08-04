'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

type CatalogItem = {
  name: string;
  status: string;
  eta?: string;
  image?: string;
  description?: string;
  availableFrom?: string;
  slug?: string;
  productId?: string;
  soldOut?: boolean;
};

export default function CatalogPage() {
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const [archiveRecords, setArchiveRecords] = useState<CatalogItem[]>([]);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);

  useEffect(() => {
    fetch('/api/catalog/status')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.archivedProductIds)) setArchivedIds(data.archivedProductIds);
        const fromApi = (data.records || []).map((r: any) => ({
          name: r.name,
          status: r.soldOut ? 'Sold out' : 'Archived',
          image: r.image,
          description: r.notes || r.description,
          availableFrom: r.availableFrom,
          slug: r.slug,
          productId: r.productId,
          soldOut: !!r.soldOut,
        }));
        setArchiveRecords(fromApi);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const activeDrops = getVisibleProducts(GOYUNIR_STORE_SUITE)
    .filter((p) => !archivedIds.includes(p.id))
    .map((p) => ({
      name: p.name,
      status: 'Allocating',
      image: `/images/${p.prefix}/1.jpeg`,
      description: p.desc,
      slug: p.slug,
      productId: p.id,
    }));

  const upcomingDrops = GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops.map((d) => ({
    ...d,
    status: d.status || 'Upcoming',
  }));

  const staticArchive = GOYUNIR_STORE_SUITE.catalogPreview.archiveScents.map((d) => ({
    ...d,
    status: d.status || 'Archived',
  }));

  // Redis archives first, then static config items not already present by name
  const archiveScents = [
    ...archiveRecords,
    ...staticArchive.filter((s) => !archiveRecords.some((r) => r.name === s.name)),
  ];

  const openItem = (item: CatalogItem) => {
    if (item.slug) {
      window.location.href = `/${item.slug}`;
      return;
    }
    setSelectedItem(item);
  };

  const renderGrid = (items: CatalogItem[], empty: string) => {
    if (!items.length) {
      return <p style={{ color: '#555', fontSize: 12 }}>{empty}</p>;
    }
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 12,
          marginBottom: 28,
        }}
      >
        {items.map((item, i) => (
          <button
            key={`${item.name}-${i}`}
            type="button"
            onClick={() => openItem(item)}
            style={{
              textAlign: 'left',
              padding: 0,
              border: `1px solid ${configPalette.cardBorder}`,
              borderRadius: 14,
              background: '#111',
              cursor: 'pointer',
              overflow: 'hidden',
              color: '#fff',
            }}
          >
            <div
              style={{
                width: '100%',
                aspectRatio: '1',
                background: item.image ? `url(${item.image}) center/cover` : '#1a1a1a',
              }}
            />
            <div style={{ padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{item.name}</div>
              <div
                style={{
                  fontSize: 10,
                  marginTop: 4,
                  color: item.soldOut || item.status === 'Sold out' ? '#f59e0b' : '#888',
                }}
              >
                {item.soldOut ? 'Sold out' : item.status}
                {item.availableFrom ? ` · ${item.availableFrom}` : item.eta ? ` · ${item.eta}` : ''}
              </div>
            </div>
          </button>
        ))}
      </div>
    );
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        padding: '24px 16px 60px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 28, fontSize: 12, letterSpacing: 2 }}>
          <span style={{ color: '#fff', fontWeight: 700 }}>CATALOG</span>
          <Link href="/story" style={{ color: '#666', textDecoration: 'none' }}>
            STORY
          </Link>
          <Link
            href="/"
            style={{
              marginLeft: 'auto',
              color: '#ccc',
              textDecoration: 'none',
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            ← Store
          </Link>
        </div>

        <h2
          style={{
            fontSize: 13,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: configPalette.accentPurple,
            margin: '0 0 12px',
          }}
        >
          Currently allocating
        </h2>
        {renderGrid(activeDrops, 'No active allocations right now.')}

        <h2
          style={{
            fontSize: 13,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: configPalette.accentBlue,
            margin: '0 0 12px',
          }}
        >
          Clothing / upcoming
        </h2>
        {renderGrid(upcomingDrops, 'Nothing announced yet.')}

        <h2
          style={{
            fontSize: 13,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: '#f59e0b',
            margin: '0 0 12px',
          }}
        >
          Past scents archive
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
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                maxWidth: 480,
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
                  borderRadius: 16,
                  background: selectedItem.image
                    ? `url(${selectedItem.image}) center/cover`
                    : '#1a1a1a',
                  marginBottom: 16,
                }}
              />
              <h3 style={{ margin: '0 0 8px', fontFamily: 'serif' }}>{selectedItem.name}</h3>
              <p style={{ color: '#f59e0b', fontSize: 12, margin: '0 0 8px' }}>
                {selectedItem.soldOut ? 'Sold out' : selectedItem.status}
              </p>
              <p style={{ color: '#999', fontSize: 13, lineHeight: 1.5 }}>
                {selectedItem.description || selectedItem.availableFrom || 'Past allocation.'}
              </p>
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                style={{
                  marginTop: 16,
                  width: '100%',
                  minHeight: 48,
                  borderRadius: 30,
                  border: '1px solid #333',
                  background: 'transparent',
                  color: '#fff',
                  fontWeight: 600,
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