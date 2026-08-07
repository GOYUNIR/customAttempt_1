import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

const SESSION_DURATION = 7 * 24 * 60 * 60;

function createSessionCookie(response: NextResponse, token: string) {
  response.cookies.set('goyunir_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
    path: '/',
  });
}

export async function POST(request: Request) {
  const { email, password } = await request.json();
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

  const normalizedEmail = String(email).trim().toLowerCase();

  // check if user exists
  const raw = await redis.hgetall('store:users');
  let existing = false;
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === normalizedEmail) { existing = true; break; }
    }
  }
  if (existing) return NextResponse.json({ error: 'User already exists' }, { status: 400 });

  const salt = randomBytes(16).toString('hex');
  const hashed = hashPassword(password, salt);
  const id = `usr_${Date.now().toString(36)}`;
  const user = { id, email: normalizedEmail, password: `${salt}:${hashed}`, role: 'customer', rewards: 0, createdAt: new Date().toISOString() };
  await redis.hset('store:users', { [id]: JSON.stringify(user) });
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DURATION * 1000;
  await redis.setex(`session:${token}`, SESSION_DURATION, JSON.stringify({
    userId: user.id,
    email: user.email,
    role: user.role,
    rewards: user.rewards || 0,
    expiresAt,
  }));

  const response = NextResponse.json({ success: true, user: { id, email: normalizedEmail, role: 'customer', rewards: 0 } });
  createSessionCookie(response, token);
  return response;
}