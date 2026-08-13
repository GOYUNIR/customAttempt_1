import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem , getAdminPassword} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ upcomingDrops: [], archiveScents: [] });

  // Catalog groupings are stored inside store:config.catalogPreview (single
  // source of truth) — shared with the admin Settings tab.
  const raw = await redis.get('store:config');
  const config = safeParseRedisItem<any>(raw) || {};
  const preview = config.catalogPreview || {};
  return NextResponse.json({
    upcomingDrops: Array.isArray(preview.upcomingDrops) ? preview.upcomingDrops : [],
    archiveScents: Array.isArray(preview.archiveScents) ? preview.archiveScents : [],
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (password !== getAdminPassword()) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const upcomingDrops = Array.isArray(body?.upcomingDrops) ? body.upcomingDrops : [];
  const archiveScents = Array.isArray(body?.archiveScents) ? body.archiveScents : [];

  // Read-modify-write store:config so non-catalog settings are preserved.
  const raw = await redis.get('store:config');
  const current = safeParseRedisItem<any>(raw) || {};
  await redis.set(
    'store:config',
    JSON.stringify({
      ...current,
      catalogPreview: { upcomingDrops, archiveScents },
      updatedAt: new Date().toISOString(),
    }),
  );
  return NextResponse.json({ success: true });
}