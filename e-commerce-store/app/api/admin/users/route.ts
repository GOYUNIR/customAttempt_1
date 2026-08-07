import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';

export const dynamic = 'force-dynamic';

const USERS_KEY = 'store:users';

type StoreUser = {
  id: string;
  email: string;
  password: string;
  role: string;
  rewards: number;
  createdAt: string;
  updatedAt?: string;
};

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

async function loadUsers(redis: any): Promise<Record<string, StoreUser>> {
  const raw = await redis.hgetall(USERS_KEY);
  if (!raw) return {};
  const out: Record<string, StoreUser> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = safeParseRedisItem<StoreUser>(value);
    if (parsed) out[key] = parsed;
  }
  return out;
}

function serializeUser(user: StoreUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    rewards: user.rewards || 0,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const password = String(url.searchParams.get('password') || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ users: [] });

    const users = Object.values(await loadUsers(redis))
      .sort((a, b) => String(a.email).localeCompare(String(b.email)))
      .map(serializeUser);

    return NextResponse.json({ users });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, users: [] }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const action = String(body?.action || 'create');
    const users = await loadUsers(redis);

    if (action === 'delete') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing user ID' }, { status: 400 });
      await redis.hdel(USERS_KEY, id);
      return NextResponse.json({ success: true });
    }

    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });

    const rewards = Math.max(0, Number(body?.rewards ?? 0) || 0);
    const role = String(body?.role || 'customer').trim() || 'customer';

    if (action === 'create') {
      const alreadyExists = Object.values(users).some((user) => user.email === email);
      if (alreadyExists) return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 400 });

      const rawPassword = String(body?.userPassword || '').trim();
      if (!rawPassword) return NextResponse.json({ error: 'Password is required for new users.' }, { status: 400 });

      const salt = randomBytes(16).toString('hex');
      const hashed = hashPassword(rawPassword, salt);
      const user: StoreUser = {
        id: `usr_${Date.now().toString(36)}`,
        email,
        password: `${salt}:${hashed}`,
        role,
        rewards,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await redis.hset(USERS_KEY, { [user.id]: JSON.stringify(user) });
      return NextResponse.json({ success: true, user: serializeUser(user) });
    }

    if (action === 'update') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing user ID' }, { status: 400 });
      const existing = users[id];
      if (!existing) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

      const emailTaken = Object.values(users).some((user) => user.id !== id && user.email === email);
      if (emailTaken) return NextResponse.json({ error: 'Another user already has this email.' }, { status: 400 });

      let nextPassword = existing.password;
      const rawPassword = String(body?.userPassword || '').trim();
      if (rawPassword) {
        const salt = randomBytes(16).toString('hex');
        nextPassword = `${salt}:${hashPassword(rawPassword, salt)}`;
      }

      const updated: StoreUser = {
        ...existing,
        email,
        role,
        rewards,
        password: nextPassword,
        updatedAt: new Date().toISOString(),
      };
      await redis.hset(USERS_KEY, { [updated.id]: JSON.stringify(updated) });
      return NextResponse.json({ success: true, user: serializeUser(updated) });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}