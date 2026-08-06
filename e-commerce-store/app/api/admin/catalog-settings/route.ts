import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const CATALOG_CONFIG_KEY = 'store:catalog_config';

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ upcomingDrops: [], archiveScents: [] });

  const raw = await redis.get(CATALOG_CONFIG_KEY);
  const config = safeParseRedisItem<any>(raw) || {};
  return NextResponse.json({
    upcomingDrops: config.upcomingDrops || [],
    archiveScents: config.archiveScents || [],
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (password !== process.env.ADMIN_BASIC_AUTH_PASSWORD) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const upcomingDrops = Array.isArray(body?.upcomingDrops) ? body.upcomingDrops : [];
  const archiveScents = Array.isArray(body?.archiveScents) ? body.archiveScents : [];

  await redis.set(CATALOG_CONFIG_KEY, JSON.stringify({ upcomingDrops, archiveScents }));
  return NextResponse.json({ success: true });
}