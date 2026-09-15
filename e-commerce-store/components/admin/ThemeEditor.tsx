'use client';

import { useState, useEffect, useCallback } from 'react';
import { inputStyle, buttonPrimary, buttonGhost, labelStyle, adminApiFetch } from '@/components/admin/portalStyles';
import { SECTION_TYPES, defaultConfigFor, sortSections, type SectionType, type ThemeSection } from '@/lib/theme-schema';

/**
 * THEME EDITOR — the working slice of the "modular design system" ask
 * (Shopify Theme Customizer / VTEX Site Editor equivalent): add a section
 * from a fixed palette, reorder it (up/down — no drag-and-drop library
 * added), edit its type-specific config, remove it, save. Calls
 * `/api/admin/theme` (`actorHasMerchantAccess`-gated). The storefront
 * (`components/storefront/ThemeSections.tsx`) renders exactly this array —
 * nothing here is a preview divorced from what actually ships.
 */

const SECTION_LABEL: Record<SectionType, string> = {
  hero: 'Hero Banner',
  product_grid: 'Product Grid',
  banner: 'Promo Banner',
  countdown: 'Countdown',
  footer: 'Footer',
};

let idCounter = 0;
function newSectionId(): string {
  idCounter += 1;
  return `section-${Date.now()}-${idCounter}`;
}

export default function ThemeEditor() {
  const [sections, setSections] = useState<ThemeSection[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/theme');
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load theme.');
        return;
      }
      setSections(sortSections(data?.theme?.sections || []));
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!sections) return;
    setSaving(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not save theme.');
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setSaving(false);
    }
  };

  const addSection = (type: SectionType) => {
    if (!sections) return;
    const next: ThemeSection = { id: newSectionId(), type, order: sections.length, config: defaultConfigFor(type) };
    setSections([...sections, next]);
  };

  const removeSection = (id: string) => {
    if (!sections) return;
    setSections(sections.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })));
  };

  const moveSection = (id: string, direction: -1 | 1) => {
    if (!sections) return;
    const index = sections.findIndex((s) => s.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[index], next[target]] = [next[target], next[index]];
    setSections(next.map((s, i) => ({ ...s, order: i })));
  };

  const updateConfig = (id: string, key: string, value: unknown) => {
    if (!sections) return;
    setSections(sections.map((s) => (s.id === id ? { ...s, config: { ...s.config, [key]: value } } : s)));
  };

  if (loading) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Customize your storefront&apos;s homepage layout — add, reorder, and configure sections from the palette
        below. Saving activates this theme immediately for every visitor.
      </p>
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SECTION_TYPES.map((type) => (
          <button key={type} type="button" style={buttonGhost} onClick={() => addSection(type)}>
            + {SECTION_LABEL[type]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(sections || []).map((section, index) => (
          <div key={section.id} style={{ padding: '12px 14px', background: '#0d0d10', borderRadius: 12, border: '1px solid #24242a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                {index + 1}. {SECTION_LABEL[section.type]}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" style={{ ...buttonGhost, padding: '4px 8px' }} onClick={() => moveSection(section.id, -1)} disabled={index === 0}>
                  ↑
                </button>
                <button type="button" style={{ ...buttonGhost, padding: '4px 8px' }} onClick={() => moveSection(section.id, 1)} disabled={index === (sections?.length || 0) - 1}>
                  ↓
                </button>
                <button type="button" style={{ ...buttonGhost, padding: '4px 8px', color: '#fca5a5', borderColor: '#7f1d1d' }} onClick={() => removeSection(section.id)}>
                  Remove
                </button>
              </div>
            </div>
            <SectionConfigFields section={section} onChange={(key, value) => updateConfig(section.id, key, value)} />
          </div>
        ))}
        {sections && sections.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No sections yet — add one from the palette above.</p>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" style={buttonPrimary} onClick={save} disabled={saving || !sections}>
          {saving ? 'Saving…' : 'Save & Activate'}
        </button>
        {savedAt && <span style={{ fontSize: 11, color: '#34d399' }}>Saved {savedAt}</span>}
      </div>
    </div>
  );
}

function SectionConfigFields({ section, onChange }: { section: ThemeSection; onChange: (key: string, value: unknown) => void }) {
  const field = (key: string, label: string, type: 'text' | 'number' = 'text') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160, flex: 1 }}>
      <span style={labelStyle}>{label}</span>
      <input
        style={inputStyle}
        type={type}
        value={String(section.config[key] ?? '')}
        onChange={(e) => onChange(key, type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </div>
  );

  switch (section.type) {
    case 'hero':
      return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {field('title', 'Title')}
          {field('subtitle', 'Subtitle')}
          {field('imageUrl', 'Image URL')}
          {field('ctaLabel', 'Button label')}
          {field('ctaHref', 'Button link')}
        </div>
      );
    case 'product_grid':
      return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {field('heading', 'Heading')}
          {field('columns', 'Columns (1-3)', 'number')}
          {field('categoryFilter', 'Category filter (optional)')}
        </div>
      );
    case 'banner':
      return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {field('text', 'Text')}
          {field('linkHref', 'Link')}
          {field('color', 'Background color')}
        </div>
      );
    case 'countdown':
      return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{field('heading', 'Heading')}</div>;
    case 'footer':
      return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{field('copy', 'Footer copy')}</div>;
    default:
      return null;
  }
}
