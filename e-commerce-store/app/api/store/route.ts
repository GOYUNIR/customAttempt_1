import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, getFallbackStoreProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'store:config';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';

type PublicPriceCategory = {
  size: string;
  price: number;
};

type PublicStoreProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  sortOrder: number;
  productType: string;
  checkoutMode: 'RAFFLE' | 'FCFS';
  maxPerEmail: number;
  maxPerCart: number;
  isActive: boolean;
  isArchived: boolean;
  isUpcoming: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  priceCategories: PublicPriceCategory[];
};

function normalizeCheckoutMode(product: any): 'RAFFLE' | 'FCFS' {
  const mode = String(product?.checkoutMode || '').toUpperCase();
  if (mode === 'FCFS') return 'FCFS';
  if (mode === 'RAFFLE') return 'RAFFLE';
  if (product?.isRaffle === false) return 'FCFS';
  return 'RAFFLE';
}

function sanitizeProduct(raw: any): PublicStoreProduct {
  const checkoutMode = normalizeCheckoutMode(raw);
  const categories = Array.isArray(raw?.priceCategories) ? raw.priceCategories : [];
  return {
    id: String(raw?.id || ''),
    name: String(raw?.name || ''),
    slug: String(raw?.slug || ''),
    prefix: String(raw?.prefix || ''),
    tagline: String(raw?.tagline || ''),
    desc: String(raw?.desc || ''),
    sortOrder: Number(raw?.sortOrder || 0),
    productType: checkoutMode === 'FCFS' ? 'fcfs' : 'raffle',
    checkoutMode,
    maxPerEmail: Math.max(1, Number(raw?.maxPerEmail || 1)),
    maxPerCart: Math.max(1, Number(raw?.maxPerCart || raw?.maxPerEmail || 1)),
    isActive: raw?.isActive === true,
    isArchived: raw?.isArchived === true,
    isUpcoming: raw?.isUpcoming === true,
    notes: Array.isArray(raw?.notes) ? raw.notes : [],
    images: Array.isArray(raw?.images) ? raw.images.filter(Boolean) : [],
    priceCategories: categories.map((category: any) => ({
      size: String(category?.size || 'Standard'),
      price: Math.max(0, Number(category?.price || 0)),
    })),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedSlug = String(url.searchParams.get('slug') || '').trim();

    const redis = createRedisClient();
    const fallbackProducts = Object.values(getFallbackStoreProducts()).map((product: any) => sanitizeProduct(product));
    const sortProducts = (items: PublicStoreProduct[]) =>
      [...items].sort(
        (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)),
      );

    const fallbackActiveProducts = sortProducts(
      fallbackProducts.filter((product) => product.isActive && !product.isArchived && !product.isUpcoming),
    );
    const fallbackArchivedProducts = sortProducts(fallbackProducts.filter((product) => product.isArchived));
    const fallbackUpcomingProducts = sortProducts(fallbackProducts.filter((product) => product.isUpcoming));
    const fallbackAllProducts = sortProducts(fallbackProducts);

    if (!redis) {
      const product = requestedSlug ? fallbackAllProducts.find((item) => item.slug === requestedSlug) || null : null;
      return NextResponse.json({
        config: {},
        activeProducts: fallbackActiveProducts,
        archivedProducts: fallbackArchivedProducts,
        upcomingProducts: fallbackUpcomingProducts,
        allProducts: [],
        product,
        scheduleOverride: {},
        socialOverride: {},
        timestamp: Date.now(),
      });
    }

    // Get store config
    const configRaw = await redis.get(CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || {};

    let activeProducts: PublicStoreProduct[] = [];
    let archivedProducts: PublicStoreProduct[] = [];
    let upcomingProducts: PublicStoreProduct[] = [];
    let allProducts: PublicStoreProduct[] = [];

    // Get all active products
    const activeRaw = await redis.hgetall(ACTIVE_PRODUCTS_KEY);
    if (activeRaw) {
      for (const value of Object.values(activeRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) activeProducts.push(sanitizeProduct(p));
      }
    }

    // Get archived products (for catalog page)
    const archivedRaw = await redis.hgetall(ARCHIVED_PRODUCTS_KEY);
    if (archivedRaw) {
      for (const value of Object.values(archivedRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) archivedProducts.push(sanitizeProduct(p));
      }
    }

    const upcomingRaw = await redis.hgetall(UPCOMING_PRODUCTS_KEY);
    if (upcomingRaw) {
      for (const value of Object.values(upcomingRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) upcomingProducts.push(sanitizeProduct(p));
      }
    }

    // Get all products (for admin)
    const allRaw = await redis.hgetall('store:products');
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) allProducts.push(sanitizeProduct(p));
      }
    }

    const hasRedisProducts =
      activeProducts.length > 0 || archivedProducts.length > 0 || upcomingProducts.length > 0 || allProducts.length > 0;
    if (!hasRedisProducts) {
      activeProducts = fallbackActiveProducts;
      archivedProducts = fallbackArchivedProducts;
      upcomingProducts = fallbackUpcomingProducts;
      allProducts = fallbackAllProducts;
    } else {
      activeProducts = sortProducts(activeProducts);
      archivedProducts = sortProducts(archivedProducts);
      upcomingProducts = sortProducts(upcomingProducts);
      allProducts = sortProducts(allProducts);
    }

    const product = requestedSlug
      ? activeProducts.find((item) => item.slug === requestedSlug)
          || archivedProducts.find((item) => item.slug === requestedSlug)
          || upcomingProducts.find((item) => item.slug === requestedSlug)
          || null
      : null;

    // Get global schedule override
    const scheduleRaw = await redis.get('config:drop_schedule');
    const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};

    // Get social proof override
    const socialRaw = await redis.get('config:social_proof');
    const socialOverride = safeParseRedisItem<any>(socialRaw) || {};

    return NextResponse.json({
      config,
      activeProducts,
      archivedProducts,
      upcomingProducts,
      allProducts: [],
      product,
      scheduleOverride,
      socialOverride,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}