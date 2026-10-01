/**
 * MERCHANT PRODUCT INPUT — what a merchant may send to create or edit a
 * product (/api/merchant/products), checked before anything is written.
 * Pure (its one import is pure too), so every rule is unit-tested.
 *
 * The store is NEVER part of the input: the route takes it from the session.
 * The product id is never chosen by a merchant for a new product (the server
 * makes one), and an edit must name a product already in THEIR catalog — the
 * route checks that. A slug is a URL path on the store's own address, so it
 * may not be one of the app's own routes.
 */
import { MEDIA_KEY_PREFIX, toMediaRef } from './media-key.ts';

export type MerchantSizeInput = { size: string; price: number; mode: 'FCFS' | 'RAFFLE'; stock?: number; winners?: number };

export type MerchantProductInput = {
  id?: string;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  isActive: boolean;
  isUpcoming: boolean;
  releaseEndsAt: string;
  maxPerEmail: number;
  sizes: MerchantSizeInput[];
  /** Photo URLs on the platform's own media host; undefined = leave as is. */
  images?: string[];
};

/** Paths the storefront already uses; a product slug may not shadow them. */
const RESERVED_SLUGS = new Set([
  'account', 'admin', 'api', 'app', 'auth', 'catalog', 'maintenance', 'media', 'og',
  'platform', 'privacy', 'sales', 'shipping', 'story', 'terms', 'icon', '_next', 'favicon.ico',
]);

export function slugifyProductName(name: string): string {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Where a store's own uploaded photos live (app/api/merchant/media). */
export function merchantPhotoPrefix(tenantId: string): string {
  return 'tenants/' + tenantId + '/products/';
}

export function validateMerchantProduct(
  raw: any,
  opts: { mediaBase?: string; tenantId?: string; currentImages?: string[] } = {},
): { ok: true; value: MerchantProductInput } | { ok: false; error: string } {
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max + 1);
  const name = str(raw?.name, 120);
  if (!name || name.length > 120) return { ok: false, error: 'A product name (up to 120 characters) is required.' };
  const slug = str(raw?.slug, 60) || slugifyProductName(name);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) return { ok: false, error: 'The web address may use lowercase letters, numbers and dashes (up to 60).' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'That web address is reserved. Choose another.' };
  const tagline = str(raw?.tagline, 200);
  const description = str(raw?.description, 2000);
  if (tagline.length > 200) return { ok: false, error: 'The tagline is limited to 200 characters.' };
  if (description.length > 2000) return { ok: false, error: 'The description is limited to 2000 characters.' };
  const maxPerEmail = raw?.maxPerEmail === undefined ? 1 : Number(raw.maxPerEmail);
  if (!Number.isInteger(maxPerEmail) || maxPerEmail < 1 || maxPerEmail > 100) return { ok: false, error: 'Limit per customer must be a whole number from 1 to 100.' };
  const releaseEndsAt = str(raw?.releaseEndsAt, 40);
  if (releaseEndsAt && Number.isNaN(Date.parse(releaseEndsAt))) return { ok: false, error: 'The draw date is not a valid date.' };

  const sizesRaw = Array.isArray(raw?.sizes) ? raw.sizes : [];
  if (sizesRaw.length < 1 || sizesRaw.length > 10) return { ok: false, error: 'Add between 1 and 10 sizes.' };
  const sizes: MerchantSizeInput[] = [];
  const seen = new Set<string>();
  for (const s of sizesRaw) {
    const size = str(s?.size, 40);
    if (!size || size.length > 40) return { ok: false, error: 'Each size needs a name (up to 40 characters).' };
    if (seen.has(size.toLowerCase())) return { ok: false, error: 'Two sizes have the same name: ' + size + '.' };
    seen.add(size.toLowerCase());
    const price = Number(s?.price);
    if (!Number.isFinite(price) || price < 0.5 || price > 100000 || Math.round(price * 100) / 100 !== price) {
      return { ok: false, error: 'Price for ' + size + ' must be between 0.50 and 100000, in cents at most.' };
    }
    const mode = String(s?.mode || 'FCFS').toUpperCase();
    if (mode !== 'FCFS' && mode !== 'RAFFLE') return { ok: false, error: 'Sale type for ' + size + ' must be instant buy or raffle.' };
    const stock = s?.stock === undefined || s?.stock === '' ? undefined : Number(s.stock);
    if (stock !== undefined && (!Number.isInteger(stock) || stock < 0 || stock > 100000)) return { ok: false, error: 'Stock for ' + size + ' must be a whole number from 0 to 100000.' };
    const winners = s?.winners === undefined || s?.winners === '' ? undefined : Number(s.winners);
    if (winners !== undefined && (!Number.isInteger(winners) || winners < 1 || winners > 100000)) return { ok: false, error: 'Winners per draw for ' + size + ' must be a whole number of at least 1.' };
    sizes.push({ size, price, mode: mode as 'FCFS' | 'RAFFLE', ...(stock !== undefined ? { stock } : {}), ...(winners !== undefined ? { winners } : {}) });
  }
  const isActive = raw?.isActive === true;
  const isUpcoming = raw?.isUpcoming === true;
  if (isActive && sizes.some((s) => s.mode === 'RAFFLE') && !releaseEndsAt) return { ok: false, error: 'A live raffle needs a draw date.' };

  const id = raw?.id === undefined || raw?.id === null || raw?.id === '' ? undefined : str(raw.id, 80);
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { ok: false, error: 'Unknown product.' };
  // Photos: only files already on the platform's own media host (no hotlinks
  // to arbitrary sites), at most 8. Absent = keep the product's current ones.
  let images: string[] | undefined;
  if (raw?.images !== undefined) {
    const base = String(opts.mediaBase || '').replace(/\/+$/, '');
    if (!Array.isArray(raw.images) || raw.images.length > 8) return { ok: false, error: 'Up to 8 photos per product.' };
    const urls: string[] = (raw.images as unknown[]).map((u) => String(u || '').trim()).filter(Boolean);
    // A NEW photo must be one of THIS store's uploads; a photo the product
    // already has may stay. So no store can put another store's photo on its
    // own products by pasting the address.
    // Our own photos are judged by their KEY (lib/media-key: no "..", no
    // empty segments), so `…/tenants/<me>/products/../../<other>/…` is not
    // "mine". Photos may arrive as URLs or as `media:` keys.
    const own = opts.tenantId ? MEDIA_KEY_PREFIX + merchantPhotoPrefix(opts.tenantId) : '';
    const kept = new Set(opts.currentImages || []);
    const mine = (u: string) => { const ref = toMediaRef(u, base); return Boolean(own && ref && ref.startsWith(own)); };
    if (!base || urls.some((u) => u.length > 500 || !(kept.has(u) || mine(u)))) return { ok: false, error: 'Photos must be uploaded to your store first.' };
    images = urls;
  }
  return { ok: true, value: { ...(id ? { id } : {}), name, slug, tagline, description, isActive, isUpcoming, releaseEndsAt, maxPerEmail, sizes, ...(images ? { images } : {}) } };
}
