/**
 * High-volume product query engine — server-side pagination, instant fuzzy
 * search (title/SKU/slug) and faceted filters, as a PURE function over an
 * in-memory product array. The `/api/admin/products` route applies this to the
 * Redis catalog so a 10k+ SKU catalog is paged/filtered on the server, never
 * shipped whole to the admin browser.
 *
 * Dependency-free except `./product-status` (also pure), so `node --test` and
 * the route share the exact same behavior.
 */
import { statusFromLegacy } from './product-status.ts';

export interface ProductQuery {
  /** Free-text fuzzy search across title (name), slug and SKU/size labels. */
  search?: string;
  /** '', 'ALL', or 'DRAFT' | 'ACTIVE' | 'ARCHIVED'. */
  status?: string;
  /** Exact category tag (case-insensitive). */
  category?: string;
  /** '', 'ALL', 'RAFFLE', 'FCFS', or 'MIXED'. */
  checkoutMode?: string;
  /** true = only products with at least one shared-inventory pool. */
  hasInventoryPool?: string | boolean;
  /** 1-based page number. */
  page?: number;
  /** Items per page (1..100, default 25). */
  pageSize?: number;
}

export interface ProductQueryResult {
  items: any[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** Build a searchable lowercase text blob for a product. */
function searchableText(product: any): string {
  const parts: unknown[] = [product?.name, product?.slug, product?.sku];
  for (const c of Array.isArray(product?.priceCategories) ? product.priceCategories : []) {
    parts.push(c?.sku, c?.size);
  }
  return parts
    .filter((x) => x !== undefined && x !== null && String(x).trim() !== '')
    .map((x) => String(x).toLowerCase())
    .join(' ');
}

/** Instant fuzzy match: EVERY search token must appear in the text. */
function fuzzyMatch(search: string, text: string): boolean {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => text.includes(token));
}

/** Effective checkout modes present on a product (RAFFLE and/or FCFS). */
function productCheckoutModes(product: any): string[] {
  const productMode = String(product?.checkoutMode || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE';
  const modes = new Set<string>();
  for (const c of Array.isArray(product?.priceCategories) ? product.priceCategories : []) {
    const m = String(c?.checkoutMode || '').toUpperCase();
    modes.add(m === 'FCFS' || m === 'RAFFLE' ? m : productMode);
  }
  if (modes.size === 0) modes.add(productMode);
  return [...modes];
}

function hasInventoryPool(product: any): boolean {
  return (Array.isArray(product?.priceCategories) ? product.priceCategories : []).some(
    (c: any) => String(c?.inventorySyncSlug || c?.inventoryPoolId || '').trim() !== '',
  );
}

/** Deterministic catalog ordering (sortOrder asc, then name asc). */
function sortProducts(list: any[]): any[] {
  return [...list].sort(
    (a: any, b: any) =>
      (Number(a?.sortOrder) || 0) - (Number(b?.sortOrder) || 0) ||
      String(a?.name || '').localeCompare(String(b?.name || '')),
  );
}

export function queryProducts(products: unknown[], q: ProductQuery = {}): ProductQueryResult {
  const list = Array.isArray(products) ? products : [];
  const search = String(q.search || '').trim();
  const status = String(q.status || '').trim().toUpperCase();
  const category = String(q.category || '').trim().toLowerCase();
  const checkoutMode = String(q.checkoutMode || '').trim().toUpperCase();
  const hasPool = q.hasInventoryPool === true || q.hasInventoryPool === 'true';

  let filtered = list.filter((p: any) => {
    if (search && !fuzzyMatch(search, searchableText(p))) return false;
    if (status && status !== 'ALL' && statusFromLegacy(p) !== status) return false;
    if (category && !asList(p?.categories).some((c) => c.toLowerCase() === category)) return false;
    if (checkoutMode && checkoutMode !== 'ALL') {
      const modes = productCheckoutModes(p);
      if (checkoutMode === 'MIXED') {
        if (new Set(modes).size < 2) return false;
      } else if (!modes.includes(checkoutMode)) {
        return false;
      }
    }
    if (hasPool && !hasInventoryPool(p)) return false;
    return true;
  });

  filtered = sortProducts(filtered);

  const total = filtered.length;
  const pageSize = Math.max(1, Math.min(100, Number(q.pageSize) || 25));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(q.page) || 1));
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return { items, page, pageSize, total, totalPages, hasMore: page < totalPages };
}
