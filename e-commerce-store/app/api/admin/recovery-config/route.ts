import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const RECOVERY_CONFIG_KEY = 'config:recovery';

function defaultConfig() {
  return {
    enabled: true,
    earlyDelayHours: 3,
    preDrawHours: 6,  // Changed from 24 to 6
    preDrawEnabled: true,
  };
}

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json(defaultConfig());
  const raw = await redis.get(RECOVERY_CONFIG_KEY);
  const parsed = safeParseRedisItem<any>(raw);
  return NextResponse.json({ ...defaultConfig(), ...(parsed || {}) });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (password !== process.env.ADMIN_BASIC_AUTH_PASSWORD) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const next = {
    enabled: body.enabled !== false,
    earlyDelayHours: Math.max(1, Number(body.earlyDelayHours) || 3),
    preDrawHours: Math.max(1, Number(body.preDrawHours) || 24),
    preDrawEnabled: body.preDrawEnabled !== false,
  };
  await redis.set(RECOVERY_CONFIG_KEY, JSON.stringify(next));
  return NextResponse.json({ success: true, config: next });
}