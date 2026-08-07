import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, loadProducts } from '@/lib/server-config';
import { sendReleaseAnnouncementEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

const WAITLIST_KEY = 'alerts:waitlist';

function authorized(password: string) {
  const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
  return Boolean(master) && password === master;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = String(url.searchParams.get('password') || '');
  if (!authorized(password)) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ subscribers: [], activeCount: 0 });

  const hash = (await redis.hgetall(WAITLIST_KEY)) as Record<string, string> | null;
  const subscribers = Object.values(hash || {})
    .map((value) => safeParseRedisItem<any>(value))
    .filter(Boolean)
    .sort((a: any, b: any) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return NextResponse.json({
    subscribers,
    activeCount: subscribers.filter((item: any) => item.status !== 'unsubscribed').length,
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!authorized(password)) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const action = String(body?.action || '');
  if (action === 'remove') {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 });
    await redis.hdel(WAITLIST_KEY, email);
    return NextResponse.json({ success: true });
  }

  if (action === 'notifyProduct') {
    const productId = String(body?.productId || '').trim();
    if (!productId) return NextResponse.json({ error: 'productId required' }, { status: 400 });

    const products = Object.values(await loadProducts(redis));
    const product = (products as any[]).find((item) => String(item.id) === productId);
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const slug = String(product.slug || product.id);
    const hash = (await redis.hgetall(WAITLIST_KEY)) as Record<string, string> | null;
    const subscribers = Object.values(hash || {}).map((value) => safeParseRedisItem<any>(value)).filter(Boolean);
    let sent = 0;
    let skipped = 0;

    for (const subscriber of subscribers as any[]) {
      if (subscriber.status === 'unsubscribed') {
        skipped++;
        continue;
      }
      const notifications = subscriber.notifications || {};
      if (notifications[slug]) {
        skipped++;
        continue;
      }
      const result = await sendReleaseAnnouncementEmail({
        to: subscriber.email,
        productName: String(product.name || 'New release'),
        slug,
        tagline: String(product.tagline || ''),
      });
      if (result.ok || result.skipped) {
        subscriber.notifications = { ...notifications, [slug]: new Date().toISOString() };
        subscriber.updatedAt = new Date().toISOString();
        await redis.hset(WAITLIST_KEY, { [subscriber.email]: JSON.stringify(subscriber) });
        if (result.ok) sent++;
      } else {
        skipped++;
      }
    }

    return NextResponse.json({ success: true, sent, skipped });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}