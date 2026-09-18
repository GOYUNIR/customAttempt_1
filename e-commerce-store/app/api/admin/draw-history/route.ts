import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem, LAST_DRAW_KEY, DRAW_HISTORY_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { listDrawRuns } from '@/lib/draw-runs';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { getDb } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // DEFERRED-7: runs come from drop_draw_runs (00025). The KV list is capped at
  // 100 entries and is erased by `wipe`, so it was never an adequate record of
  // the moment this store takes money from people.
  //
  // It falls back to KV only when Postgres is unconfigured — NOT when Postgres
  // merely returns nothing. An empty result there means "no draws have run",
  // which is a real answer; quietly reaching for a second store on a legitimate
  // empty is how two sources of truth start disagreeing.
  let degraded: string | null = null;
  if (getDb().configured) {
    try {
      const tenantId = await ensureDefaultTenant();
      const runs = await listDrawRuns(tenantId, 50);
      return NextResponse.json({
        draws: runs.map((run, i) => ({
          drawNumber: runs.length - i,
          executionTime: run.executedAt,
          timezone: run.timezone,
          triggerSource: run.triggerSource,
          processedWinners: run.winners,
          totalSuccessfulCharges: run.totalCharges,
          totalRevenueCents: run.totalRevenueCents,
          timestamp: run.executedAt,
        })),
        source: 'postgres',
      });
    } catch (err) {
      // A genuine read FAILURE (not an empty result) falls back to the KV
      // mirror, and says so in the payload. The alternative — returning an
      // empty history — would tell an operator that no draw has ever run.
      console.error('[draw-history] Postgres read failed, falling back to the KV mirror', (err as Error)?.message || err);
      degraded = String((err as Error)?.message || err);
    }
  }

  const redis = createKvClient();
  if (!redis) return NextResponse.json({ draws: [], source: 'none', degraded });

  // Get the most recent draw summary
  const lastDrawRaw = await redis.get(LAST_DRAW_KEY);
  const lastDraw = safeParseKvItem<any>(lastDrawRaw);

  // Get historical draws
  const historyRaw = await redis.lrange(DRAW_HISTORY_KEY, -50, -1);
  const historicalDraws = historyRaw
    .map((r) => safeParseKvItem<any>(r))
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
  const redis = createKvClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!(await adminAuthorized(request, password))) {
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