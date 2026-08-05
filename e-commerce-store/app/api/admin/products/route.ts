import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';

export type StoreProduct = {
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

async function loadProducts(redis: any): Promise<Record<string, StoreProduct>> {
  const raw = await redis.hgetall(PRODUCTS_KEY);
  if (!raw) return {};
  const out: Record<string, StoreProduct> = {};
  for (const [k, v] of Object.entries(raw)) {
    const parsed = safeParseRedisItem<StoreProduct>(v);
    if (parsed) out[k] = parsed;
  }
  return out;
}

async function saveProduct(redis: any, product: StoreProduct) {
  await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
  // Update active/archived indexes
  if (product.isActive && !product.isArchived) {
    await redis.hset(ACTIVE_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
    await redis.hdel(ARCHIVED_PRODUCTS_KEY, product.id);
  } else if (product.isArchived) {
    await redis.hset(ARCHIVED_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
    await redis.hdel(ACTIVE_PRODUCTS_KEY, product.id);
  } else {
    await redis.hdel(ACTIVE_PRODUCTS_KEY, product.id);
    await redis.hdel(ARCHIVED_PRODUCTS_KEY, product.id);
  }
}

async function deleteProduct(redis: any, productId: string) {
  await redis.hdel(PRODUCTS_KEY, productId);
  await redis.hdel(ACTIVE_PRODUCTS_KEY, productId);
  await redis.hdel(ARCHIVED_PRODUCTS_KEY, productId);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ products: [] });
    
    let products: StoreProduct[] = [];
    
    if (includeArchived) {
      const all = await loadProducts(redis);
      products = Object.values(all);
    } else {
      const raw = await redis.hgetall(ACTIVE_PRODUCTS_KEY);
      if (raw) {
        const parsed = Object.values(raw).map((v) => safeParseRedisItem<StoreProduct>(v));
        // Filter out null values
        products = parsed.filter((p): p is StoreProduct => p !== null);
      }
    }
    
    return NextResponse.json({ products });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, products: [] }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const action = String(body?.action || 'upsert');

    if (action === 'delete') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing product ID' }, { status: 400 });
      await deleteProduct(redis, id);
      return NextResponse.json({ success: true });
    }

    if (action === 'archive') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing product ID' }, { status: 400 });
      const all = await loadProducts(redis);
      const product = all[id];
      if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
      product.isArchived = true;
      product.isActive = false;
      product.updatedAt = new Date().toISOString();
      await saveProduct(redis, product);
      return NextResponse.json({ success: true, product });
    }

    if (action === 'unarchive') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing product ID' }, { status: 400 });
      const all = await loadProducts(redis);
      const product = all[id];
      if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
      product.isArchived = false;
      product.isActive = true;
      product.updatedAt = new Date().toISOString();
      await saveProduct(redis, product);
      return NextResponse.json({ success: true, product });
    }

    if (action === 'toggleActive') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing product ID' }, { status: 400 });
      const all = await loadProducts(redis);
      const product = all[id];
      if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
      product.isActive = !product.isActive;
      product.updatedAt = new Date().toISOString();
      await saveProduct(redis, product);
      return NextResponse.json({ success: true, product });
    }

    // upsert - create or update
    const id = String(body?.id || `prod_${Date.now().toString(36)}`);
    const allProducts = await loadProducts(redis);
    const existing = allProducts[id] || null;
    
    const product: StoreProduct = {
      id,
      name: String(body?.name || existing?.name || 'New Product'),
      slug: String(body?.slug || existing?.slug || id).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      prefix: String(body?.prefix || existing?.prefix || id),
      tagline: String(body?.tagline || existing?.tagline || 'LIMITED DROP'),
      desc: String(body?.desc || existing?.desc || 'A refined signature profile.'),
      price50ml: Number(body?.price50ml ?? existing?.price50ml ?? 0),
      price100ml: Number(body?.price100ml ?? existing?.price100ml ?? 0),
      stripeId50ml: String(body?.stripeId50ml || existing?.stripeId50ml || ''),
      stripeId100ml: String(body?.stripeId100ml || existing?.stripeId100ml || ''),
      maxRaffleAllocationLimit: Number(body?.maxRaffleAllocationLimit ?? existing?.maxRaffleAllocationLimit ?? 0),
      isActive: body?.isActive !== undefined ? body.isActive : (existing?.isActive ?? true),
      isArchived: body?.isArchived !== undefined ? body.isArchived : (existing?.isArchived ?? false),
      notes: Array.isArray(body?.notes) ? body.notes : (existing?.notes || []),
      images: Array.isArray(body?.images) ? body.images : (existing?.images || []),
      totalInventory: Number(body?.totalInventory ?? existing?.totalInventory ?? 0),
      winnerTiers: Array.isArray(body?.winnerTiers) ? body.winnerTiers : (existing?.winnerTiers || [0]),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}