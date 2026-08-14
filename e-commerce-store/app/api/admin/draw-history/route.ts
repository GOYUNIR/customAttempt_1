import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, LAST_DRAW_KEY , getAdminPassword, verifyAdminPassword, DRAW_HISTORY_KEY } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  // Defense-in-depth auth (proxy.ts already enforces Basic Auth + 2FA): accept
  // either the query password or the HTTP Basic Authorization header, compared
  // in constant time so response timing can never leak the password.
  const authHeader = request.headers.get('authorization');
  if (!getAdminPassword()) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 500 });
  }

  let isAuthorized = false;
  if (password && verifyAdminPassword(password)) {
    isAuthorized = true;
  } else if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const encoded = authHeader.slice(6);
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(':');
      if (user === process.env.ADMIN_BASIC_AUTH_USERNAME && verifyAdminPassword(pass)) {
        isAuthorized = true;
      }
    } catch {}
  }

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ draws: [] });

  // Get the most recent draw summary
  const lastDrawRaw = await redis.get(LAST_DRAW_KEY);
  const lastDraw = safeParseRedisItem<any>(lastDrawRaw);

  // Get historical draws
  const historyRaw = await redis.lrange(DRAW_HISTORY_KEY, -50, -1);
  const historicalDraws = historyRaw
    .map((r) => safeParseRedisItem<any>(r))
    .filter(Boolean)
    .reverse();

  // If we have a last draw, include it as the most recent if not already in history
  let draws = historicalDraws;
  if (lastDraw && !historicalDraws.some((d: any) => d.executionTime === lastDraw.executionTime)) {
    draws = [lastDraw, ...historicalDraws];
  }

  // Add draw numbers
  draws = draws.map((d: any, i: number) => ({
    ...d,
    drawNumber: draws.length - i,
  }));

  return NextResponse.json({ draws });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!verifyAdminPassword(password)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const drawData = body?.drawData;
  if (!drawData) return NextResponse.json({ error: 'Missing draw data' }, { status: 400 });

  // Store in history
  await redis.rpush(DRAW_HISTORY_KEY, JSON.stringify({
    ...drawData,
    timestamp: new Date().toISOString(),
  }));

  // Keep last 100
  const len = await redis.llen(DRAW_HISTORY_KEY);
  if (len > 100) await redis.ltrim(DRAW_HISTORY_KEY, len - 100, -1);

  // Also update the last draw key
  await redis.set(LAST_DRAW_KEY, JSON.stringify(drawData));

  return NextResponse.json({ success: true });
}