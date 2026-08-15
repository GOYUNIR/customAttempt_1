import { NextResponse } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { createRedisClient, safeParseRedisItem, USERS_KEY, passwordResetKey } from '@/lib/server-config';
import { isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { token, password } = body;
    if (!token || !password) {
      return NextResponse.json({ error: 'Token and password required' }, { status: 400 });
    }
    if (!isValidPassword(password)) {
      return NextResponse.json({ error: 'Password must be between 6 and 128 characters.' }, { status: 400 });
    }

    const limited = await rateLimitedResponse('auth_reset_password', request, 10, 60);
    if (limited) return limited;

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

    const resetKeyName = passwordResetKey(token);
    const resetData = safeParseRedisItem<any>(await redis.get(resetKeyName));
    if (!resetData?.email) {
      return NextResponse.json({ error: 'Reset link expired or invalid' }, { status: 400 });
    }

    const raw = await redis.hgetall(USERS_KEY);
    let userId: string | null = null;
    let user: any = null;
    for (const [key, value] of Object.entries(raw || {})) {
      const parsed = safeParseRedisItem<any>(value);
      if (parsed && String(parsed.email || '').toLowerCase() === String(resetData.email).toLowerCase()) {
        userId = key;
        user = parsed;
        break;
      }
    }

    if (!user || !userId) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const salt = randomBytes(16).toString('hex');
    user.password = `${salt}:${hashPassword(password, salt)}`;
    await redis.hset(USERS_KEY, { [userId]: JSON.stringify(user) });
    await redis.del(resetKeyName);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[reset-password] failed', error?.message || error);
    return NextResponse.json({ error: 'Unable to reset password' }, { status: 500 });
  }
}