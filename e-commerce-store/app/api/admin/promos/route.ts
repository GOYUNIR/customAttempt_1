import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

export type PromoRecord = {
  code: string;
  promoterName: string;
  promoterEmail: string;
  customerDiscountPercent: number;
  promoterPayoutPercent: number;
  active: boolean;
  uses: number;
  revenueAttributed: number;
  createdAt: string;
};

async function loadPromos(redis: any): Promise<Record<string, PromoRecord>> {
  const raw = await redis.hgetall(PROMOS_KEY);
  if (!raw) return {};
  const out: Record<string, PromoRecord> = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = safeParseRedisItem<PromoRecord>(v);
    if (p) out[k] = p;
  }
  return out;
}

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ promos: [] });
  const map = await loadPromos(redis);
  return NextResponse.json({ promos: Object.values(map) });
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

  if (action === 'delete') {
    const code = String(body?.code || '')
      .trim()
      .toUpperCase();
    if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });
    await redis.hdel(PROMOS_KEY, code);
    return NextResponse.json({ success: true });
  }

  const code = String(body?.code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  if (!code || code.length < 3) {
    return NextResponse.json({ error: 'Code must be 3+ letters/numbers' }, { status: 400 });
  }

  const existingMap = await loadPromos(redis);
  const existing = existingMap[code];

  const record: PromoRecord = {
    code,
    promoterName: String(body?.promoterName || existing?.promoterName || code),
    promoterEmail: String(body?.promoterEmail || existing?.promoterEmail || '')
      .trim()
      .toLowerCase(),
    customerDiscountPercent: Math.min(50, Math.max(0, Number(body?.customerDiscountPercent ?? existing?.customerDiscountPercent ?? 0))),
    promoterPayoutPercent: Math.min(50, Math.max(0, Number(body?.promoterPayoutPercent ?? existing?.promoterPayoutPercent ?? 10))),
    active: body?.active !== false,
    uses: existing?.uses ?? 0,
    revenueAttributed: existing?.revenueAttributed ?? 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(record) });
  return NextResponse.json({ success: true, promo: record });
}