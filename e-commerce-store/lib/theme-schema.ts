/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THEME SCHEMA — pure validation/defaults for the modular section-based
 * storefront design system (migration `00017`, `components/admin/ThemeEditor.tsx`,
 * `components/storefront/ThemeSections.tsx`).
 *
 * A fixed palette of section types (not an open plugin system) — the real,
 * working slice of a Shopify Theme Customizer / VTEX Site Editor this
 * template ships with: reorder, configure, add/remove from the palette
 * below. No drag-and-drop library, no arbitrary code/CSS injection.
 *
 * Zero imports (mirrors lib/b2b/pricing.ts / lib/csrf.ts) so this loads
 * under `node --test` with no bundler.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The section palette.
 *
 * The first five were homepage-only, which meant the "theme customizer" could
 * restyle the front page and nothing else — while the product page and the
 * catalog, which is most of what a shopper actually looks at, were hardcoded.
 * The rest exist so a template can cover those pages too.
 *
 * Still a FIXED palette, not an open plugin system: every type here has a
 * renderer, and a theme that references a type nothing can draw is a blank
 * page a merchant cannot debug.
 */
export type SectionType =
  // homepage
  | 'hero' | 'product_grid' | 'banner' | 'countdown' | 'footer'
  // product detail
  | 'product_gallery' | 'product_summary' | 'product_details' | 'product_reviews'
  // catalog
  | 'catalog_header' | 'catalog_filters' | 'catalog_grid'
  // shared
  | 'rich_text' | 'trust_badges' | 'faq';

export const SECTION_TYPES: SectionType[] = [
  'hero', 'product_grid', 'banner', 'countdown', 'footer',
  'product_gallery', 'product_summary', 'product_details', 'product_reviews',
  'catalog_header', 'catalog_filters', 'catalog_grid',
  'rich_text', 'trust_badges', 'faq',
];

/** Which page a section belongs on. A template is a set of pages. */
export type ThemePage = 'home' | 'catalog' | 'product';
export const THEME_PAGES: ThemePage[] = ['home', 'catalog', 'product'];

/**
 * Where each section type is allowed. A product_summary on the homepage has no
 * product to summarise, so placement is part of the schema rather than
 * something the renderer discovers at runtime and silently skips.
 */
export const SECTION_PLACEMENT: Record<SectionType, ThemePage[]> = {
  hero: ['home'],
  product_grid: ['home'],
  banner: ['home', 'catalog', 'product'],
  countdown: ['home', 'product'],
  footer: ['home', 'catalog', 'product'],
  product_gallery: ['product'],
  product_summary: ['product'],
  product_details: ['product'],
  product_reviews: ['product'],
  catalog_header: ['catalog'],
  catalog_filters: ['catalog'],
  catalog_grid: ['catalog'],
  rich_text: ['home', 'catalog', 'product'],
  trust_badges: ['home', 'catalog', 'product'],
  faq: ['home', 'catalog', 'product'],
};

/** Whether a section type may appear on a page. */
export function sectionAllowedOn(type: SectionType, page: ThemePage): boolean {
  return (SECTION_PLACEMENT[type] || []).includes(page);
}

export type HeroConfig = { title: string; subtitle: string; imageUrl: string; ctaLabel: string; ctaHref: string };
export type ProductGridConfig = { columns: 1 | 2 | 3; categoryFilter: string; heading: string };
export type BannerConfig = { text: string; linkHref: string; color: string };
export type CountdownConfig = { heading: string };
export type FooterConfig = { copy: string };

export type SectionConfig = HeroConfig | ProductGridConfig | BannerConfig | CountdownConfig | FooterConfig;

export type ThemeSection = {
  id: string;
  type: SectionType;
  order: number;
  config: Record<string, unknown>;
};

export function defaultConfigFor(type: SectionType): Record<string, unknown> {
  switch (type) {
    case 'hero':
      return { title: 'Welcome', subtitle: '', imageUrl: '', ctaLabel: 'Shop now', ctaHref: '/catalog' } satisfies HeroConfig;
    case 'product_grid':
      return { columns: 2, categoryFilter: '', heading: 'Featured' } satisfies ProductGridConfig;
    case 'banner':
      return { text: '', linkHref: '', color: '#111111' } satisfies BannerConfig;
    case 'countdown':
      return { heading: 'Next drop' } satisfies CountdownConfig;
    case 'footer':
      return { copy: '' } satisfies FooterConfig;
    case 'product_gallery':
      return { layout: 'stacked', showThumbnails: true, zoom: true };
    case 'product_summary':
      // showStock/showUrgency are separate because a drop wants scarcity shown
      // and a B2B catalog very much does not.
      return { showPrice: true, showStock: true, showUrgency: false, ctaLabel: 'Add to cart' };
    case 'product_details':
      return { heading: 'Details', showSpecs: true, showShipping: true };
    case 'product_reviews':
      return { heading: 'Reviews', minToDisplay: 1 };
    case 'catalog_header':
      return { heading: 'All products', showCount: true, blurb: '' };
    case 'catalog_filters':
      return { showCategories: true, showPriceRange: true, showAvailability: true };
    case 'catalog_grid':
      return { columns: 3, showPrice: true, showBadges: true };
    case 'rich_text':
      return { heading: '', body: '' };
    case 'trust_badges':
      return { items: [] as string[] };
    case 'faq':
      return { heading: 'Questions', items: [] as Array<{ q: string; a: string }> };
    default:
      return {};
  }
}

export const DEFAULT_THEME_SECTIONS: ThemeSection[] = [
  { id: 'hero-default', type: 'hero', order: 0, config: defaultConfigFor('hero') },
  { id: 'grid-default', type: 'product_grid', order: 1, config: defaultConfigFor('product_grid') },
  { id: 'footer-default', type: 'footer', order: 2, config: defaultConfigFor('footer') },
];

export type ThemeValidation = { ok: boolean; errors: string[] };

/**
 * Validate a sections array before it's ever persisted or rendered — never
 * throws. Checks: is an array, every entry has a real id/type/order/config,
 * type is in the fixed palette, ids are unique.
 */
export function validateThemeSections(sections: unknown): ThemeValidation {
  const errors: string[] = [];
  if (!Array.isArray(sections)) {
    return { ok: false, errors: ['sections must be an array'] };
  }
  const seenIds = new Set<string>();
  sections.forEach((raw, index) => {
    const section = (raw && typeof raw === 'object' ? raw : {}) as Partial<ThemeSection>;
    const id = String(section.id || '').trim();
    if (!id) {
      errors.push(`section[${index}]: missing id`);
    } else if (seenIds.has(id)) {
      errors.push(`section[${index}]: duplicate id "${id}"`);
    } else {
      seenIds.add(id);
    }
    if (!SECTION_TYPES.includes(section.type as SectionType)) {
      errors.push(`section[${index}]: unknown type "${String(section.type)}" (must be one of ${SECTION_TYPES.join(', ')})`);
    }
    if (typeof section.order !== 'number' || !Number.isFinite(section.order)) {
      errors.push(`section[${index}]: order must be a finite number`);
    }
    if (!section.config || typeof section.config !== 'object' || Array.isArray(section.config)) {
      errors.push(`section[${index}]: config must be an object`);
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Sort sections by `order`, stable for equal values (array index as tiebreak). */
export function sortSections(sections: ThemeSection[]): ThemeSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map((entry) => entry.section);
}
