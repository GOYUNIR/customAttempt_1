import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'store:config';
const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const IMAGES_KEY = 'store:product_images';

type StoreProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  isActive: boolean;
  isArchived: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  totalInventory: number;
  winnerTiers: number[];
  createdAt: string;
  updatedAt: string;
};

export async function GET() {
  try {
    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'Redis offline' }, { status: 500 });
    }

    // Get store config
    const configRaw = await redis.get(CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || {};

    // Get all active products
    const activeRaw = await redis.hgetall(ACTIVE_PRODUCTS_KEY);
    const activeProducts: StoreProduct[] = [];
    if (activeRaw) {
      for (const [k, v] of Object.entries(activeRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          // Load images for this product
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || [];
          activeProducts.push({ ...p, images });
        }
      }
    }

    // Get archived products (for catalog page)
    const archivedRaw = await redis.hgetall(ARCHIVED_PRODUCTS_KEY);
    const archivedProducts: StoreProduct[] = [];
    if (archivedRaw) {
      for (const [k, v] of Object.entries(archivedRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || [];
          archivedProducts.push({ ...p, images });
        }
      }
    }

    // Get all products (for admin)
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    const allProducts: StoreProduct[] = [];
    if (allRaw) {
      for (const [k, v] of Object.entries(allRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || [];
          allProducts.push({ ...p, images });
        }
      }
    }

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
      allProducts,
      scheduleOverride,
      socialOverride,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}