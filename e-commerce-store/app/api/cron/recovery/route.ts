import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, loadProducts , getAdminPassword, RECOVERY_CONFIG_KEY, RECOVERY_SENT_KEY, intentPoolKey } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getNextDrawTimestampForSchedule, resolveProductSchedule } from '@/lib/storefront-config';
import { sendEntryRecoveryEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function getConfig(redis: any) {
  const raw = await redis.get(RECOVERY_CONFIG_KEY);
  const parsed = safeParseRedisItem<any>(raw) || {};
  return {
    enabled: parsed.enabled !== false,
    earlyDelayHours: Number(parsed.earlyDelayHours ?? 3),
    preDrawHours: Number(parsed.preDrawHours ?? 24),
    preDrawEnabled: parsed.preDrawEnabled !== false,
  };
}

function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || getAdminPassword();
  if (!secret) return true;
  const auth = request.headers.get('authorization');
  const key = url.searchParams.get('key') || '';
  if (request.headers.get('x-vercel-cron') === '1') return true;
  if (auth === `Bearer ${secret}`) return true;
  if (key === secret) return true;
  return false;
}

export async function GET(request: Request) {
  try {
    if (!authorized(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const config = await getConfig(redis);
    if (!config.enabled) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'disabled' });
    }

    const host =
      request.headers.get('x-forwarded-host') || request.headers.get('host') || 'localhost:3000';
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const siteUrl = `${proto}://${host}`;

    let sentEarly = 0;
    let sentPre = 0;
    const now = Date.now();

    const allProducts = Object.values(await loadProducts(redis));

    for (const product of allProducts as any[]) {
      const priceCategories = Array.isArray(product.priceCategories) ? product.priceCategories : [];
      for (const category of priceCategories) {
        const size = String(category?.size || 'Standard');
        const intentKey = intentPoolKey(product.name, size);
        let items: string[] = [];
        try {
          items = await redis.lrange(intentKey, 0, -1);
        } catch {
          continue;
        }
        if (!items.length) continue;

      const schedule = resolveProductSchedule({ ...GOYUNIR_STORE_SUITE, productCatalog: allProducts as any[] }, product as any);
        const drawAt = getNextDrawTimestampForSchedule(schedule);
        const hoursToDraw = (drawAt - now) / (1000 * 60 * 60);

        for (let i = 0; i < items.length; i++) {
          const parsed = safeParseRedisItem<any>(items[i]);
          if (!parsed?.email) continue;
          const email = String(parsed.email).toLowerCase();
          const registeredAt = new Date(parsed.registeredAt || 0).getTime();
          if (!registeredAt) continue;
          const ageHours = (now - registeredAt) / (1000 * 60 * 60);

          const earlyField = `${email}|${product.name}|${size}|early`;
          const preField = `${email}|${product.name}|${size}|pre`;

          if (ageHours >= config.earlyDelayHours && !parsed.recoveryEarlySent) {
            const already = await redis.hget(RECOVERY_SENT_KEY, earlyField);
            if (!already) {
              const result = await sendEntryRecoveryEmail({
                to: email,
                product: product.name,
                size,
                siteUrl: `${siteUrl}/${product.slug}`,
                kind: 'early',
              });
              if (result.ok || result.skipped) {
                await redis.hset(RECOVERY_SENT_KEY, { [earlyField]: new Date().toISOString() });
                parsed.recoveryEarlySent = true;
                await redis.lset(intentKey, i, JSON.stringify(parsed));
                if (result.ok) sentEarly++;
              }
            }
          }

          if (
            config.preDrawEnabled &&
            hoursToDraw > 0 &&
            hoursToDraw <= config.preDrawHours &&
            !parsed.recoveryPreDrawSent
          ) {
            const already = await redis.hget(RECOVERY_SENT_KEY, preField);
            if (!already) {
              const result = await sendEntryRecoveryEmail({
                to: email,
                product: product.name,
                size,
                siteUrl: `${siteUrl}/${product.slug}`,
                kind: 'pre_draw',
              });
              if (result.ok || result.skipped) {
                await redis.hset(RECOVERY_SENT_KEY, { [preField]: new Date().toISOString() });
                parsed.recoveryPreDrawSent = true;
                await redis.lset(intentKey, i, JSON.stringify(parsed));
                if (result.ok) sentPre++;
              }
            }
          }
        }
      }
    }

    return NextResponse.json({ ok: true, sentEarly, sentPre, config });
  } catch (err: any) {
    console.error('[cron/recovery] failed', err?.message || err);
    return NextResponse.json({ error: 'Recovery run failed' }, { status: 500 });
  }
}