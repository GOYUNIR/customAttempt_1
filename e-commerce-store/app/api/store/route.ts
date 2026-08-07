import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, STORE_CONFIG_KEY } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

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
    const sortProducts = (items: PublicStoreProduct[]) =>
      [...items].sort(
        (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)),
      );

    if (!redis) {
      return NextResponse.json({
        config: {},
        activeProducts: [],
        archivedProducts: [],
        upcomingProducts: [],
        allProducts: [],
        product: null,
        scheduleOverride: {},
        socialOverride: {},
        timestamp: Date.now(),
      });
    }

    // Get store config
    const configRaw = await redis.get(STORE_CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || {};

    let allProducts: PublicStoreProduct[] = [];
    const allRaw = await redis.hgetall('store:products');
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) allProducts.push(sanitizeProduct(p));
      }
    }

    allProducts = sortProducts(allProducts);
    const activeProducts = allProducts.filter((item) => item.isActive && !item.isArchived && !item.isUpcoming);
    const archivedProducts = allProducts.filter((item) => item.isArchived);
    const upcomingProducts = allProducts.filter((item) => item.isUpcoming && !item.isArchived);

    const product = requestedSlug
      ? allProducts.find((item) => item.slug === requestedSlug)
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