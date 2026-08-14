import { NextResponse } from 'next/server';
import { createRedisClient, getAdminPassword } from '@/lib/server-config';
import { runSeedDefaults } from '@/app/api/admin/seed/route';
import { appendAudit } from '@/app/api/admin/audit/route';

export const dynamic = 'force-dynamic';

/**
 * ADMIN-DRIVEN "Wipe & Rebuild Redis".
 *
 * Two-step safety gate:
 *   1. The caller must provide the admin password (same gate every admin
 *      destructive action uses).
 *   2. The caller must ALSO type the confirmation phrase `WIPE` (case
 *      insensitive) — a deliberate second factor so a fat-fingered click on a
 *      livestreamed admin can never nuke the store by accident.
 *
 * Behaviour:
 *   - Deletes EVERY key in Redis (all tidy namespaces from lib/redis-keys.ts
 *     plus any legacy prefixes from older template versions). This is a full
 *     clean slate — entries, ledger, promos, sessions, config, everything.
 *   - When `rebuild` is true it then runs the same seed the Developer →
 *     "Seed Defaults" button runs, so a wiped store is immediately usable.
 *
 * This route is protected by the admin Basic-Auth proxy (proxy.ts) AND the
 * password/confirmation checks below — never weaken either.
 */
const CONFIRM_PHRASE = 'WIPE';

async function deleteAllKeys(redis: any): Promise<{ deleted: number; keys: string[] }> {
  let keys: string[] = [];
  try {
    const found = (await redis.keys('*')) as string[] | null;
    keys = Array.isArray(found) ? found : [];
  } catch (err) {
    console.error('[wipe] keys() scan failed:', err);
  }

  let deleted = 0;
  // Chunked DEL so very large key spaces don't blow REST request size limits.
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    try {
      const result = await redis.del(...chunk);
      deleted += Number(result) || 0;
    } catch (err) {
      console.error('[wipe] del failed for chunk:', err);
    }
  }
  return { deleted, keys };
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    const confirm = String(body?.confirm || '').trim();
    const rebuild = body?.rebuild === true || body?.rebuild === 'true';
    const master = getAdminPassword() || '';

    // Gate 1 — admin password.
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }
    // Gate 2 — confirmation phrase.
    if (confirm.toUpperCase() !== CONFIRM_PHRASE) {
      return NextResponse.json(
        { error: `Type "${CONFIRM_PHRASE}" to confirm you want to erase everything in Redis.` },
        { status: 400 }
      );
    }

    const { deleted, keys } = await deleteAllKeys(redis);

    // Persist a record of the wipe for the NEW audit log (the old one was erased).
    try {
      await appendAudit(redis, {
        action: 'REDIS_WIPED',
        detail: `Deleted ${deleted} keys${rebuild ? ' · then re-seeded defaults' : ''}`,
        actor: 'admin',
      });
    } catch {}

    let seeded = 0;
    let liveSeeded = 0;
    let verifyCount = 0;
    if (rebuild) {
      const result = await runSeedDefaults(redis);
      seeded = result.seeded;
      liveSeeded = result.liveSeeded;
      verifyCount = result.verifyCount;
    }

    return NextResponse.json({
      success: true,
      message: rebuild
        ? `Redis wiped (${deleted} keys deleted) and rebuilt with ${seeded} seeded products (${verifyCount} verified, ${liveSeeded} live states).`
        : `Redis wiped — ${deleted} keys deleted. The store now shows 0 items until you add/seed products.`,
      deleted,
      keys: keys.length,
      seeded,
      liveStatesSeeded: liveSeeded,
      verified: verifyCount,
    });
  } catch (err: unknown) {
    console.error('[wipe] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Server error' },
      { status: 500 }
    );
  }
}
