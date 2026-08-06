import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';

export const dynamic = 'force-dynamic';

const SESSION_DURATION = 7 * 24 * 60 * 60;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    
    if (!email || !password || password.length < 6) {
      return NextResponse.json({ error: 'Email and password (min 6 chars) required' }, { status: 400 });
    }

    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'System error' }, { status: 500 });
    }

    // Check if user exists
    const raw = await redis.hgetall('store:users');
    if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const u = safeParseRedisItem<any>(value);
        if (u && u.email === email) {
          return NextResponse.json({ error: 'Email already registered' }, { status: 400 });
        }
      }
    }

    const userId = `user_${Date.now().toString(36)}`;
    const salt = randomBytes(16).toString('hex');
    const hashed = hashPassword(password, salt);
    const user = {
      id: userId,
      email,
      password: `${salt}:${hashed}`,
      role: 'customer',
      rewards: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await redis.hset('store:users', { [userId]: JSON.stringify(user) });

    // Auto-login
    const token = randomBytes(32).toString('hex');
    const sessionKey = `session:${token}`;
    await redis.setex(sessionKey, SESSION_DURATION, JSON.stringify({
      userId: user.id,
      email: user.email,
      role: user.role,
      rewards: user.rewards || 0,
      expiresAt: Date.now() + SESSION_DURATION * 1000,
    }));

    const response = NextResponse.json({ 
      success: true, 
      user: { id: user.id, email: user.email, role: user.role, rewards: user.rewards || 0 } 
    });
    response.cookies.set('goyunir_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_DURATION,
      path: '/',
    });

    return response;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}