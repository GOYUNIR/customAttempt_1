import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createRedisClient, safeParseRedisItem, USERS_KEY, passwordResetKey } from '@/lib/server-config';
import { sendPasswordResetEmail } from '@/lib/email';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function resetKey(token: string) {
  return passwordResetKey(token);
}

export async function POST(request: Request) {
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { email } = body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      // Same generic response for unknown AND invalid emails — never reveal
      // whether an address has an account.
      return NextResponse.json({ success: true });
    }

    const limited = await rateLimitedResponse('auth_forgot_password', request, 10, 60);
    if (limited) return limited;

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

    const raw = await redis.hgetall(USERS_KEY);
    let user: any = null;
    for (const value of Object.values(raw || {})) {
      const parsed = safeParseRedisItem<any>(value);
      if (parsed && String(parsed.email || '').toLowerCase() === normalizedEmail) {
        user = parsed;
        break;
      }
    }

    if (!user) {
      return NextResponse.json({ success: true });
    }

    const token = randomBytes(24).toString('hex');
    await redis.setex(resetKey(token), 60 * 30, JSON.stringify({
      email: normalizedEmail,
      createdAt: Date.now(),
    }));

    const siteUrl = getSiteUrl() || fallbackSiteUrl();
    await sendPasswordResetEmail({
      to: normalizedEmail,
      resetUrl: `${siteUrl.replace(/\/$/, '')}/auth/reset-password?token=${token}`,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[forgot-password] failed', error?.message || error);
    return NextResponse.json({ success: true });
  }
}