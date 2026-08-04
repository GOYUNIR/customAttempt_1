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
  /** Max times one email can use this code (default 1). 0 = unlimited */
  maxUsesPerEmail: number;
  active: boolean;
  uses: number;
  clicks: number;
  revenueAttributed: number;
  payoutOwedCents: number;
  payoutPaidCents: number;
  createdAt: string;
};

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

async function loadPromos(redis: any): Promise<Record<string, PromoRecord>> {
  const raw = await redis.hgetall(PROMOS_KEY);
  if (!raw) return {};
  const out: Record<string, PromoRecord> = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = safeParseRedisItem<PromoRecord>(v);
    if (p) {
      out[k] = {
        ...p,
        maxUsesPerEmail: typeof p.maxUsesPerEmail === 'number' ? p.maxUsesPerEmail : 1,
      };
    }
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
  const code = String(body?.code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });

  if (action === 'delete') {
    await redis.hdel(PROMOS_KEY, code);
    await redis.del(usedEmailsKey(code));
    return NextResponse.json({ success: true });
  }

  const existingMap = await loadPromos(redis);
  const existing = existingMap[code];

  if (action === 'toggle') {
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    existing.active = !existing.active;
    await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(existing) });
    return NextResponse.json({ success: true, promo: existing });
  }

  if (action === 'markPaid') {
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    existing.payoutPaidCents = existing.payoutOwedCents || 0;
    existing.payoutOwedCents = 0;
    await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(existing) });
    return NextResponse.json({ success: true, promo: existing });
  }

  // Clear one email's usage of this code so they can use it again
  if (action === 'resetEmail') {
    const email = String(body?.email || '')
      .trim()
      .toLowerCase();
    if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });
    await redis.srem(usedEmailsKey(code), email);
    return NextResponse.json({ success: true, reset: email, code });
  }

  // Clear ALL per-email usage for this code
  if (action === 'resetAllEmails') {
    await redis.del(usedEmailsKey(code));
    return NextResponse.json({ success: true, code });
  }

  // upsert = create or edit in place
  if (code.length < 3) {
    return NextResponse.json({ error: 'Code must be 3+ letters/numbers' }, { status: 400 });
  }

  const maxUsesPerEmail = Math.max(
    0,
    Number(body?.maxUsesPerEmail ?? existing?.maxUsesPerEmail ?? 1),
  );

  const record: PromoRecord = {
    code,
    promoterName: String(body?.promoterName ?? existing?.promoterName ?? code),
    promoterEmail: String(body?.promoterEmail ?? existing?.promoterEmail ?? '')
      .trim()
      .toLowerCase(),
    customerDiscountPercent: Math.min(
      50,
      Math.max(0, Number(body?.customerDiscountPercent ?? existing?.customerDiscountPercent ?? 0)),
    ),
    promoterPayoutPercent: Math.min(
      50,
      Math.max(0, Number(body?.promoterPayoutPercent ?? existing?.promoterPayoutPercent ?? 10)),
    ),
    maxUsesPerEmail,
    active: body?.active ?? existing?.active ?? true,
    uses: existing?.uses ?? 0,
    clicks: existing?.clicks ?? 0,
    revenueAttributed: existing?.revenueAttributed ?? 0,
    payoutOwedCents: existing?.payoutOwedCents ?? 0,
    payoutPaidCents: existing?.payoutPaidCents ?? 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(record) });
  return NextResponse.json({ success: true, promo: record });
}