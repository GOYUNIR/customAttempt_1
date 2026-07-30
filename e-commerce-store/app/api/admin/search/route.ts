import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, ARCHIVE_LEDGER_KEY } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ results: [] });
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!query) return NextResponse.json({ results: [] });

    const allRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    const matches = allRaw
      .map((item) => safeParseRedisItem<any>(item))
      .filter(Boolean)
      .filter((entry) => {
        const email = String(entry.email || '').toLowerCase();
        const address = String(entry.shippingAddress || '').toLowerCase();
        const variant = String(entry.variant || '').toLowerCase();
        return email.includes(query) || address.includes(query) || variant.includes(query);
      })
      .reverse()
      .slice(0, 200);

    return NextResponse.json({ results: matches });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, results: [] }, { status: 500 });
  }
}