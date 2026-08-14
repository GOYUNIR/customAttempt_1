import { NextResponse } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { createRedisClient, safeParseRedisItem, USERS_KEY, passwordResetKey } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  try {
    const { token, password } = await request.json();
    if (!token || !password) {
      return NextResponse.json({ error: 'Token and password required' }, { status: 400 });
    }

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
    return NextResponse.json({ error: error.message || 'Unable to reset password' }, { status: 500 });
  }
}