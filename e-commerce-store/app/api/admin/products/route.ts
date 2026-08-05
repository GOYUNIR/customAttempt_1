import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'config:admin_products';

export type AdminProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline?: string;
  desc?: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml?: string;
  stripeId100ml?: string;
  catalogImage?: string;
  isActive: boolean;
  totalInventory: number;
  winnerTiers?: number[];
  notes?: { label: string; name: string; text: string }[];
  createdAt: string;
};

const SAFE_PRICE = 999999.99;

async function load(redis: any): Promise<AdminProduct[]> {
  const raw = await redis.get(PRODUCTS_KEY);
  const parsed = safeParseRedisItem<AdminProduct[]>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function save(redis: any, list: AdminProduct[]) {
  await redis.set(PRODUCTS_KEY, JSON.stringify(list));
}

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ products: [] });
  const products = await load(redis);
  return NextResponse.json({ products });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (password !== process.env.ADMIN_BASIC_AUTH_PASSWORD) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const action = String(body?.action || 'upsert');
  let list = await load(redis);

  if (action === 'delete') {
    const id = String(body?.id || '');
    list = list.filter((p) => p.id !== id);
    await save(redis, list);
    return NextResponse.json({ success: true, products: list });
  }

  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });

  const slug =
    String(body?.slug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '') || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const prefix = String(body?.prefix || slug).trim() || slug;
  const id = String(body?.id || `ap_${Date.now().toString(36)}`);

  const existingIdx = list.findIndex((p) => p.id === id || p.slug === slug);
  const product: AdminProduct = {
    id,
    name,
    slug,
    prefix,
    tagline: String(body?.tagline || 'LIMITED DROP'),
    desc: String(body?.desc || ''),
    price50ml:
      typeof body?.price50ml === 'number' && body.price50ml > 0
        ? body.price50ml
        : SAFE_PRICE,
    price100ml:
      typeof body?.price100ml === 'number' && body.price100ml > 0
        ? body.price100ml
        : SAFE_PRICE,
    stripeId50ml: String(body?.stripeId50ml || ''),
    stripeId100ml: String(body?.stripeId100ml || ''),
    catalogImage: String(body?.catalogImage || `/images/${prefix}/1.jpeg`),
    isActive: body?.isActive !== false,
    totalInventory: Math.max(0, Number(body?.totalInventory) || 0),
    winnerTiers: Array.isArray(body?.winnerTiers) ? body.winnerTiers : [0],
    notes: Array.isArray(body?.notes) ? body.notes : [],
    createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : new Date().toISOString(),
  };

  if (existingIdx >= 0) list[existingIdx] = product;
  else list.push(product);

  await save(redis, list);
  return NextResponse.json({ success: true, product, products: list });
}