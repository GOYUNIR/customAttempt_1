import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY, sessionKey } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';

const SESSION_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  const { email, password } = await request.json();
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ error: 'System error' }, { status: 500 });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // Get all users from Redis
  const raw = await redis.hgetall(USERS_KEY);
  if (!raw) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  let user: any = null;
  for (const [, value] of Object.entries(raw)) {
    const u = safeParseRedisItem<any>(value);
    if (u && String(u.email || '').toLowerCase() === normalizedEmail) {
      user = u;
      break;
    }
  }

  if (!user) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const [salt, storedHash] = user.password.split(':');
  const computedHash = hashPassword(password, salt);
  if (computedHash !== storedHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  // Create session
  const token = randomBytes(32).toString('hex');
  const sessionKeyName = sessionKey(token);
  const expiresAt = Date.now() + SESSION_DURATION * 1000;
  await redis.setex(sessionKeyName, SESSION_DURATION, JSON.stringify({
    userId: user.id,
    email: user.email,
    role: user.role,
    rewards: user.rewards || 0,
    expiresAt,
  }));

  // Set cookie
  const response = NextResponse.json({ success: true, user: { id: user.id, email: user.email, role: user.role, rewards: user.rewards || 0 } });
  response.cookies.set('goyunir_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
    path: '/',
  });

  return response;
}