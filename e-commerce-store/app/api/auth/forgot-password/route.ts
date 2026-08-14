import { NextResponse } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { createRedisClient, safeParseRedisItem, USERS_KEY, passwordResetKey } from '@/lib/server-config';
import { sendPasswordResetEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

function resetKey(token: string) {
  return passwordResetKey(token);
}

export async function POST(request: Request) {
  try {
    const { email } = await request.json();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 });
    }

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

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://example.com';
    await sendPasswordResetEmail({
      to: normalizedEmail,
      resetUrl: `${siteUrl.replace(/\/$/, '')}/auth/reset-password?token=${token}`,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Unable to send reset email' }, { status: 500 });
  }
}