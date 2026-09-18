/**
 * ─────────────────────────────────────────────────────────────────────────────
 * STARTER TEMPLATES — a launchable storefront per commerce mode.
 *
 * WHAT WAS THERE BEFORE. `tenant_themes` held a flat array of sections that
 * rendered the HOMEPAGE only, from a palette of five types, and eleven "theme
 * presets" that were colour palettes with no layout or content. Production had
 * zero theme rows, so every storefront fell back to a hardcoded page. A
 * merchant could recolour a homepage; they could not lay out the product page
 * or the catalog, which is most of what a shopper looks at.
 *
 * WHAT A TEMPLATE IS HERE. A named set of PAGES (home, catalog, product), each
 * an ordered list of sections, chosen to suit one commerce mode. A drop store
 * and a B2B catalog are not the same storefront with different colours — they
 * need different pages:
 *
 *   - a DROP needs a countdown, scarcity on the buy box, and no price filter
 *     on a catalog that is mostly sold out
 *   - an INSTANT BUY store needs filters, a dense grid and reviews, and
 *     scarcity messaging would be a lie on an always-in-stock product
 *   - a B2B catalog needs specs and a quote request, and must NOT show
 *     consumer urgency or a retail "Add to cart" as the primary action
 *
 * SHAPE AND BACK-COMPAT. `tenant_themes.sections` is jsonb and currently holds
 * a bare array. A template is `{ version: 2, pages: {...} }`. `normalizeTheme`
 * accepts BOTH, reading a legacy array as a home-only theme — so no migration
 * is needed and no existing theme stops rendering. A version field rather than
 * sniffing the shape, because guessing at a payload's meaning is how the next
 * shape change silently corrupts the last one.
 *
 * Zero imports (mirrors lib/theme-schema.ts) so this loads under `node --test`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  SECTION_PLACEMENT,
  THEME_PAGES,
  defaultConfigFor,
  sectionAllowedOn,
  type SectionType,
  type ThemePage,
  type ThemeSection,
} from './theme-schema.ts';

export type ThemePages = Record<ThemePage, ThemeSection[]>;

export type StoredTheme = {
  version: 2;
  pages: ThemePages;
};

export type StarterTemplate = {
  id: string;
  name: string;
  /** The `CommerceMode` values (lib/commerce-modes.ts) this suits. */
  commerceModes: string[];
  /** One line a merchant reads when choosing. States the fit, not a promise. */
  description: string;
  pages: ThemePages;
};

/** Build a section without repeating the id/order bookkeeping per entry. */
function section(type: SectionType, order: number, config: Record<string, unknown> = {}): ThemeSection {
  return {
    id: type + '-' + order,
    type,
    order,
    config: { ...defaultConfigFor(type), ...config },
  };
}

const EMPTY_PAGES = (): ThemePages => ({ home: [], catalog: [], product: [] });

export const STARTER_TEMPLATES: StarterTemplate[] = [
  // ── Timed drops / allocation draws ────────────────────────────────────────
  {
    id: 'drop-release',
    name: 'Drop & Release',
    commerceModes: ['ALLOCATION_DRAW', 'TIME_SLOT', 'PREORDER'],
    description:
      'For timed releases and draws. Leads with a countdown, shows entry status on the product page, and keeps the catalog readable when most of it is closed.',
    pages: {
      home: [
        section('hero', 0, { title: 'The next release', ctaLabel: 'View the drop', ctaHref: '/catalog' }),
        section('countdown', 1, { heading: 'Entries close in' }),
        section('product_grid', 2, { heading: 'This release', columns: 2 }),
        section('faq', 3, { heading: 'How the draw works' }),
        section('footer', 4),
      ],
      catalog: [
        section('catalog_header', 0, { heading: 'Releases', blurb: 'Open, upcoming and past.' }),
        // No price filter: on a drop catalog most items are closed, and
        // filtering by price implies a purchase you cannot make yet.
        section('catalog_filters', 1, { showPriceRange: false, showAvailability: true }),
        section('catalog_grid', 2, { columns: 3, showBadges: true }),
        section('footer', 3),
      ],
      product: [
        section('product_gallery', 0),
        // Scarcity is TRUE here — a draw genuinely has limited allocation.
        section('product_summary', 1, { showUrgency: true, showStock: true, ctaLabel: 'Enter the draw' }),
        section('countdown', 2, { heading: 'Entries close in' }),
        section('product_details', 3),
        section('footer', 4),
      ],
    },
  },

  // ── Ordinary retail ───────────────────────────────────────────────────────
  {
    id: 'instant-retail',
    name: 'Instant Retail',
    commerceModes: ['INSTANT_BUY', 'SUBSCRIPTION'],
    description:
      'For always-available products. Dense catalog with filters, reviews on the product page, and a buy box that gets out of the way.',
    pages: {
      home: [
        section('hero', 0, { title: 'Shop the collection', ctaLabel: 'Browse', ctaHref: '/catalog' }),
        section('product_grid', 1, { heading: 'Best sellers', columns: 3 }),
        section('trust_badges', 2),
        section('footer', 3),
      ],
      catalog: [
        section('catalog_header', 0, { heading: 'All products', showCount: true }),
        section('catalog_filters', 1, { showPriceRange: true, showCategories: true }),
        section('catalog_grid', 2, { columns: 3 }),
        section('footer', 3),
      ],
      product: [
        section('product_gallery', 0),
        // showUrgency stays FALSE: an always-in-stock product with a scarcity
        // badge is a lie, and one a customer can catch by reloading the page.
        section('product_summary', 1, { showUrgency: false, ctaLabel: 'Add to cart' }),
        section('product_details', 2),
        section('product_reviews', 3),
        section('footer', 4),
      ],
    },
  },

  // ── B2B ───────────────────────────────────────────────────────────────────
  {
    id: 'b2b-quote',
    name: 'B2B & Quotes',
    commerceModes: ['RFQ_QUOTE', 'GATED_ACCESS', 'GROUP_BUY'],
    description:
      'For trade buyers. Specification-led product pages, a quote request instead of a retail cart, and no consumer urgency anywhere.',
    pages: {
      home: [
        section('hero', 0, { title: 'Trade and wholesale', ctaLabel: 'Request a quote', ctaHref: '/catalog' }),
        section('rich_text', 1, { heading: 'Ordering terms', body: 'Net terms, contract pricing and approval workflows are available to approved accounts.' }),
        section('product_grid', 2, { heading: 'Catalog', columns: 3 }),
        section('footer', 3),
      ],
      catalog: [
        section('catalog_header', 0, { heading: 'Product catalog', showCount: true }),
        // Price range is hidden: contract pricing means the list price is not
        // what this buyer pays, so filtering on it would mislead.
        section('catalog_filters', 1, { showPriceRange: false, showCategories: true, showAvailability: true }),
        section('catalog_grid', 2, { columns: 4, showPrice: false }),
        section('footer', 3),
      ],
      product: [
        section('product_gallery', 0, { zoom: true }),
        section('product_summary', 1, { showUrgency: false, showStock: true, showPrice: false, ctaLabel: 'Request a quote' }),
        section('product_details', 2, { heading: 'Specifications', showSpecs: true }),
        section('faq', 3, { heading: 'Ordering and terms' }),
        section('footer', 4),
      ],
    },
  },
];

export function templateById(id: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((t) => t.id === String(id || '')) || null;
}

/** Templates suited to a commerce mode, best fit first. */
export function templatesForCommerceMode(mode: string): StarterTemplate[] {
  const wanted = String(mode || '').toUpperCase();
  const matching = STARTER_TEMPLATES.filter((t) => t.commerceModes.includes(wanted));
  const rest = STARTER_TEMPLATES.filter((t) => !t.commerceModes.includes(wanted));
  return [...matching, ...rest];
}

/**
 * Read whatever is in `tenant_themes.sections` as a multi-page theme.
 *
 * Accepts a legacy bare ARRAY (which was homepage-only) and a v2 object. A
 * legacy theme keeps rendering exactly as it did, on the home page, with empty
 * catalog and product pages — which the renderer treats as "use the built-in
 * layout" rather than "render nothing".
 *
 * Never throws. Anything unrecognisable becomes an empty theme, because a
 * malformed row must not take a storefront down.
 */
export function normalizeTheme(raw: unknown): StoredTheme {
  const pages = EMPTY_PAGES();

  if (Array.isArray(raw)) {
    pages.home = raw.filter(isSectionish);
    return { version: 2, pages };
  }

  if (raw && typeof raw === 'object') {
    const candidate = (raw as { pages?: unknown }).pages;
    if (candidate && typeof candidate === 'object') {
      for (const page of THEME_PAGES) {
        const list = (candidate as Record<string, unknown>)[page];
        if (Array.isArray(list)) pages[page] = list.filter(isSectionish);
      }
    }
  }
  return { version: 2, pages };
}

function isSectionish(value: unknown): value is ThemeSection {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<ThemeSection>;
  return typeof s.id === 'string' && typeof s.type === 'string';
}

export type TemplateValidation = { ok: boolean; errors: string[] };

/**
 * Validate a multi-page theme before it is persisted.
 *
 * Checks placement as well as shape: a `product_summary` on the homepage has no
 * product to summarise. Catching that here means the renderer never has to
 * silently skip a section the merchant placed and then wonder why it vanished.
 */
export function validateTheme(theme: StoredTheme): TemplateValidation {
  const errors: string[] = [];
  for (const page of THEME_PAGES) {
    const sections = theme.pages[page] || [];
    const seen = new Set<string>();
    sections.forEach((s, index) => {
      const where = page + '[' + index + ']';
      if (!s || typeof s !== 'object') { errors.push(where + ': not an object'); return; }
      if (!s.id) errors.push(where + ': missing id');
      if (seen.has(s.id)) errors.push(where + ': duplicate id "' + s.id + '"');
      seen.add(s.id);
      if (!SECTION_PLACEMENT[s.type as SectionType]) {
        errors.push(where + ': unknown section type "' + String(s.type) + '"');
        return;
      }
      if (!sectionAllowedOn(s.type as SectionType, page)) {
        errors.push(where + ': "' + s.type + '" cannot be placed on the ' + page + ' page');
      }
    });
  }
  return { ok: errors.length === 0, errors };
}
