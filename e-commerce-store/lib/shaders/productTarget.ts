// Dynamic product targeting for the hero shader engine.
//
// The admin "AI Hero" panel lets an operator pick a LIVE catalog item as the
// hero's 3D subject. This module maps that product onto a bounded, generic
// SILHOUETTE key (bottle / jar / box / card / tube) so the procedural point
// cloud, the deterministic prompt compiler and the AI prompt payload all agree
// on one shape descriptor — WITHOUT ever leaking a brand or product name into
// the GPU. No brand/product strings are hardcoded anywhere in this module.
//
// PURE module (no React / no `@/` value imports / no DOM) so `node --test`
// can load it directly.

export type SilhouetteKey = 'bottle' | 'jar' | 'box' | 'card' | 'tube' | 'generic';

export const SILHOUETTE_KEYS: ReadonlyArray<SilhouetteKey> = ['bottle', 'jar', 'box', 'card', 'tube', 'generic'];

// Generic container descriptors → canonical silhouette key. These are shape
// words, never product or brand names.
const SILHOUETTE_MAP: Record<string, SilhouetteKey> = {
  // Liquid / atomizer containers resolve to the bottle silhouette.
  bottle: 'bottle',
  bottles: 'bottle',
  flacon: 'bottle',
  atomizer: 'bottle',
  atomiser: 'bottle',
  perfume: 'bottle',
  fragrance: 'bottle',
  spray: 'bottle',
  vial: 'bottle',
  ampoule: 'bottle',
  // Wide, squat containers resolve to a jar.
  jar: 'jar',
  candle: 'jar',
  pot: 'jar',
  tin: 'jar',
  tub: 'jar',
  // Rigid rectilinear packaging resolves to a box.
  box: 'box',
  crate: 'box',
  pack: 'box',
  case: 'box',
  kit: 'box',
  bundle: 'box',
  // Flat media / print resolves to a card.
  card: 'card',
  print: 'card',
  poster: 'card',
  frame: 'card',
  plate: 'card',
  // Slim cylindrical goods resolve to a tube.
  tube: 'tube',
  stick: 'tube',
  pen: 'tube',
  cable: 'tube',
  lipstick: 'tube',
  wand: 'tube',
};

export function normalizeSilhouette(silhouette: string | undefined | null): SilhouetteKey {
  const raw = String(silhouette || '').trim().toLowerCase();
  if (!raw) return 'generic';
  // A WORD-boundary match keeps "glass bottle" → bottle while never matching a
  // brand name that merely CONTAINS a container word (e.g. a product called
  // "Boxwood" stays 'generic' because there is no standalone `box`). Splitting
  // on non-alpha also handles hyphenated descriptors ("bottle-shaped").
  const words = raw.split(/[^a-z]+/);
  for (const [word, key] of Object.entries(SILHOUETTE_MAP)) {
    if (words.includes(word)) return key;
  }
  return 'generic';
}

export interface ProductTarget {
  id: string;
  name: string;
  slug: string;
  /** First human-readable category tag ('' when untagged). */
  category: string;
  /** Canonical generic silhouette key derived from the product's own metadata. */
  silhouette: SilhouetteKey;
}

const pickString = (...vals: unknown[]): string => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/**
 * Derive a canonical silhouette key from a live catalog item's OWN metadata
 * (name + slug + categories). Returns 'generic' (the neutral container) when
 * nothing matches — never a brand or product name.
 */
export function resolveProductSilhouette(product: Record<string, any> | undefined | null): SilhouetteKey {
  if (!product || typeof product !== 'object') return 'generic';
  const name = pickString(product.name, product.title);
  const slug = pickString(product.slug, product.id);
  const categories = Array.isArray(product.categories) ? product.categories : [];
  const category = categories.map((c) => String(c || '')).join(' ');
  const description = pickString(product.description, product.tagline);
  // Name first (the strongest signal), then category/slug/description.
  const byName = normalizeSilhouette(name);
  if (byName !== 'generic') return byName;
  const byCategory = normalizeSilhouette(category);
  if (byCategory !== 'generic') return byCategory;
  const bySlug = normalizeSilhouette(slug);
  if (bySlug !== 'generic') return bySlug;
  const byDesc = normalizeSilhouette(description);
  if (byDesc !== 'generic') return byDesc;
  return 'generic';
}

/** Build the normalized product payload handed to the prompt compiler + AI. */
export function buildProductTarget(product: Record<string, any> | undefined | null): ProductTarget | null {
  if (!product || typeof product !== 'object') return null;
  const id = pickString(product.id, product.slug);
  const name = pickString(product.name, product.title);
  const slug = pickString(product.slug, product.id);
  if (!id && !name && !slug) return null;
  const category = Array.isArray(product.categories)
    ? product.categories.map((c) => String(c || '').trim()).find((c) => c) || ''
    : '';
  return {
    id,
    name,
    slug,
    category,
    silhouette: resolveProductSilhouette(product),
  };
}

/** Human label for a silhouette key (admin dropdown + readout). */
export function silhouetteLabel(key: SilhouetteKey | string | undefined | null): string {
  switch (normalizeSilhouette(key)) {
    case 'bottle':
      return 'Bottle';
    case 'jar':
      return 'Jar';
    case 'box':
      return 'Box';
    case 'card':
      return 'Card';
    case 'tube':
      return 'Tube';
    default:
      return 'Generic container';
  }
}
