import { NextResponse } from 'next/server';
import { createRedisClient, ARCHIVE_LEDGER_KEY, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
  if (!master || password !== master) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const rows = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
  const winners = rows
    .map((r) => safeParseRedisItem<any>(r))
    .filter((e) => e && e.type === 'WINNER_CHARGED');

  const header = ['email', 'variant', 'size', 'shippingAddress', 'shippingStatus', 'registeredAt', 'id'];
  const lines = [header.join(',')];
  for (const w of winners) {
    const cols = [
      w.email,
      w.variant,
      w.size,
      w.shippingAddress,
      w.shippingStatus || 'PENDING_FULFILLMENT',
      w.registeredAt,
      w.id,
    ].map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`);
    lines.push(cols.join(','));
  }

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="goyunir-winners-${Date.now()}.csv"`,
    },
  });
}