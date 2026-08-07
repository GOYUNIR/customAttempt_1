import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

type SessionUser = {
  userId: string;
  email: string;
  role?: string;
  rewards?: number;
  expiresAt?: number;
};

function readSessionTokenFromCookie(cookieHeader: string | null): string {
  if (!cookieHeader) return '';
  const cookiePairs = cookieHeader.split(';').map((c) => c.trim().split('='));
  for (const [key, value] of cookiePairs) {
    if (key === 'goyunir_session') return value || '';
  }
  return '';
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readSessionTokenFromCookie(request.headers.get('cookie'));
  if (!token) return null;

  const redis = createRedisClient();
  if (!redis) return null;

  const sessionRaw = await redis.get(`session:${token}`);
  const session = safeParseRedisItem<any>(sessionRaw);
  if (!session) return null;

  if (session.expiresAt && Date.now() > Number(session.expiresAt)) {
    await redis.del(`session:${token}`);
    return null;
  }

  const email = String(session.email || '').trim().toLowerCase();
  if (!email) return null;

  return {
    userId: String(session.userId || ''),
    email,
    role: session.role,
    rewards: Number(session.rewards || 0),
    expiresAt: Number(session.expiresAt || 0),
  };
}
