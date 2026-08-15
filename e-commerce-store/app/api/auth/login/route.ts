import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY, sessionKey } from '@/lib/server-config';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

const SESSION_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/** Constant-time comparison of two hex strings (password hashes). */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }
  if (!isValidEmail(email) || !isValidPassword(password)) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const limited = await rateLimitedResponse('auth_login', request, 20, 60);
  if (limited) return limited;

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ error: 'System error' }, { status: 500 });
  }

  const normalizedEmail = email;

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

  const [salt, storedHash] = String(user.password || '').split(':');
  if (!salt || !storedHash) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  const computedHash = hashPassword(password, salt);
  if (!safeEqualHex(computedHash, storedHash)) {
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
    emailVerified: user.emailVerified === true,
    expiresAt,
  }));

  // Set cookie
  const response = NextResponse.json({ success: true, user: { id: user.id, email: user.email, role: user.role, rewards: user.rewards || 0, emailVerified: user.emailVerified === true } });
  response.cookies.set('goyunir_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
    path: '/',
  });

  return response;
}