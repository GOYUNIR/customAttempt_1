import { NextResponse } from 'next/server';
import { createRedisClient, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const IMAGES_KEY = 'store:product_images';

async function saveProduct(redis: any, product: any) {
  await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
  await redis.hdel(ACTIVE_PRODUCTS_KEY, product.id);
  await redis.hdel(ARCHIVED_PRODUCTS_KEY, product.id);
  await redis.hdel(UPCOMING_PRODUCTS_KEY, product.id);

  if (product.isActive) {
    await redis.hset(ACTIVE_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
  }
  if (product.isArchived) {
    await redis.hset(ARCHIVED_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
  }
  if (product.isUpcoming) {
    await redis.hset(UPCOMING_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
  }
  if (product.images && product.images.length > 0) {
    await redis.set(`${IMAGES_KEY}:${product.id}`, JSON.stringify(product.images));
  }
}

async function deleteProduct(redis: any, id: string) {
  await redis.hdel(PRODUCTS_KEY, id);
  await redis.hdel(ACTIVE_PRODUCTS_KEY, id);
  await redis.hdel(ARCHIVED_PRODUCTS_KEY, id);
  await redis.hdel(UPCOMING_PRODUCTS_KEY, id);
  await redis.del(`${IMAGES_KEY}:${id}`);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get('includeArchived') === 'true';
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ products: [] });
  const all = await loadProducts(redis);
  let products = Object.values(all);
  if (!includeArchived) {
    products = products.filter((p: any) => !p.isArchived && !p.isUpcoming);
  }
  return NextResponse.json({ products });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = body.password || '';
  const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
  if (!master || password !== master) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const action = body.action || 'upsert';
  const allProducts = await loadProducts(redis);

  if (action === 'delete') {
    await deleteProduct(redis, body.id);
    return NextResponse.json({ success: true });
  }
  if (action === 'archive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isArchived = true;
    // DO NOT change isActive – archiving should not hide the product
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }
  if (action === 'unarchive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isArchived = false;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }
  if (action === 'toggleActive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isActive = typeof body.nextActive === 'boolean' ? body.nextActive : !Boolean(product.isActive);
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }
  if (action === 'addToUpcoming') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isUpcoming = true;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }
  if (action === 'removeFromUpcoming') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isUpcoming = false;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }
  if (action === 'reorder') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.sortOrder = Number(body.sortOrder) || 0;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    return NextResponse.json({ success: true, product });
  }

  // Upsert (create or update)
  const id = body.id || `prod_${Date.now().toString(36)}`;
  const existing = allProducts[id] || null;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const numberOr = (value: any, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const name = body.name?.trim() || existing?.name || '';
  if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });
  const slugSource = has('slug') ? String(body.slug || '').trim() : String(existing?.slug || '');
  const slug = slugSource || name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

  const product = {
    id,
    name,
    slug,
    prefix: has('prefix') ? String(body.prefix || '') : (existing?.prefix || ''),
    tagline: has('tagline') ? String(body.tagline || '') : (existing?.tagline || ''),
    desc: has('desc') ? String(body.desc || '') : (existing?.desc || ''),
    priceCategories: Array.isArray(body.priceCategories) ? body.priceCategories : (existing?.priceCategories || [{ size: 'Standard', price: 0, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }]),
    isActive: body.isActive !== undefined ? body.isActive : (existing?.isActive ?? false),
    isArchived: body.isArchived !== undefined ? body.isArchived : (existing?.isArchived ?? false),
    isUpcoming: body.isUpcoming !== undefined ? body.isUpcoming : (existing?.isUpcoming ?? false),
    isRaffle: body.isRaffle !== undefined ? body.isRaffle : (existing?.isRaffle ?? true),
    checkoutMode: (() => {
      const raw = has('checkoutMode') ? String(body.checkoutMode || '').toUpperCase() : String(existing?.checkoutMode || '').toUpperCase();
      if (raw === 'FCFS') return 'FCFS';
      if (raw === 'RAFFLE') return 'RAFFLE';
      return body.isRaffle === false || existing?.isRaffle === false ? 'FCFS' : 'RAFFLE';
    })(),
    productType: has('productType') ? String(body.productType || '') : (existing?.productType || 'raffle'),
    maxPerEmail: has('maxPerEmail') ? Math.max(1, numberOr(body.maxPerEmail, existing?.maxPerEmail || 1)) : Math.max(1, Number(existing?.maxPerEmail || 1)),
    maxPerCart: has('maxPerCart') ? Math.max(1, numberOr(body.maxPerCart, existing?.maxPerCart || existing?.maxPerEmail || 1)) : Math.max(1, Number(existing?.maxPerCart || existing?.maxPerEmail || 1)),
    sortOrder: has('sortOrder') ? numberOr(body.sortOrder, existing?.sortOrder || 0) : (existing?.sortOrder || 0),
    notes: Array.isArray(body.notes) ? body.notes : (existing?.notes || []),
    images: Array.isArray(body.images) ? body.images : (existing?.images || []),
    maxRaffleAllocationLimit: has('maxRaffleAllocationLimit') ? numberOr(body.maxRaffleAllocationLimit, existing?.maxRaffleAllocationLimit || 0) : (existing?.maxRaffleAllocationLimit || 0),
    totalInventory: has('totalInventory') ? numberOr(body.totalInventory, existing?.totalInventory || 0) : (existing?.totalInventory || 0),
    winnerTiers: Array.isArray(body.winnerTiers) ? body.winnerTiers : (existing?.winnerTiers || [0]),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveProduct(redis, product);
  return NextResponse.json({ success: true, product });
}