import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  const { email, password } = await request.json();
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

  // check if user exists
  const raw = await redis.hgetall('store:users');
  let existing = false;
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && u.email === email) { existing = true; break; }
    }
  }
  if (existing) return NextResponse.json({ error: 'User already exists' }, { status: 400 });

  const salt = randomBytes(16).toString('hex');
  const hashed = hashPassword(password, salt);
  const id = `usr_${Date.now().toString(36)}`;
  const user = { id, email, password: `${salt}:${hashed}`, role: 'customer', rewards: 0, createdAt: new Date().toISOString() };
  await redis.hset('store:users', { [id]: JSON.stringify(user) });
  return NextResponse.json({ success: true, user: { id, email, role: 'customer' } });
}