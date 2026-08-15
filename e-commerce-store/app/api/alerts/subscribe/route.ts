import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, WAITLIST_KEY } from '@/lib/server-config';
import { sendWaitlistConfirmationEmail } from '@/lib/email';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    if (String(body?.company || '').trim()) {
      return NextResponse.json({ success: true, message: 'You are on the release list.' });
    }

    const email = String(body?.email || '').trim().toLowerCase();
    const source = String(body?.source || 'site').trim().toLowerCase();
    const interests = Array.isArray(body?.interests) ? body.interests.map(String).filter(Boolean).slice(0, 20) : [];
    if (!isValidEmail(email)) return NextResponse.json({ error: 'Valid email required.' }, { status: 400 });

    const limited = await rateLimitedResponse('alerts_subscribe', request, 10, 60);
    if (limited) return limited;

    const raw = await redis.hget(WAITLIST_KEY, email);
    const existing = safeParseRedisItem<any>(raw) || {};
    const sources = Array.from(new Set([...(Array.isArray(existing.sources) ? existing.sources : []), source]));
    const mergedInterests = Array.from(new Set([...(Array.isArray(existing.interests) ? existing.interests : []), ...interests]));
    const now = new Date().toISOString();
    const record = {
      email,
      status: 'active',
      sources,
      interests: mergedInterests,
      createdAt: existing.createdAt || now,
      updatedAt: now,
      notifications: existing.notifications || {},
    };

    await redis.hset(WAITLIST_KEY, { [email]: JSON.stringify(record) });
    if (!existing.createdAt) {
      await sendWaitlistConfirmationEmail({ to: email });
    }

    return NextResponse.json({ success: true, message: 'You are on the release list.' });
  } catch (err: any) {
    console.error('[alerts/subscribe] failed', err?.message || err);
    return NextResponse.json({ error: 'Subscription failed. Please try again.' }, { status: 500 });
  }
}