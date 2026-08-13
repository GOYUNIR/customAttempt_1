import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';
import { scryptSync, randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const hash = scryptSync(password, salt, 64).toString('hex');
    return hash === expectedHash;
  } catch {
    return false;
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Login required.' }, { status: 401 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'System offline.' }, { status: 500 });

    const body = await request.json();
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');

    if (currentPassword.length < 1) {
      return NextResponse.json({ error: 'Enter your current password.' }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'New password must be at least 6 characters.' }, { status: 400 });
    }
    if (currentPassword === newPassword) {
      return NextResponse.json({ error: 'New password must be different from the current one.' }, { status: 400 });
    }

    // Find the user record
    const raw = await redis.hgetall('store:users');
    let user: any = null;
    let userId = sessionUser.userId;
    if (raw) {
      for (const [k, v] of Object.entries(raw)) {
        const u = safeParseRedisItem<any>(v);
        if (u && String(u.email || '').toLowerCase() === sessionUser.email) {
          user = u;
          userId = k;
          break;
        }
      }
    }
    if (!user) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    const stored = String(user.password || '');
    const [salt, expectedHash] = stored.split(':');
    if (!salt || !expectedHash || !verifyPassword(currentPassword, salt, expectedHash)) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
    }

    const newSalt = randomBytes(16).toString('hex');
    user.password = `${newSalt}:${hashPassword(newPassword, newSalt)}`;
    await redis.hset('store:users', { [userId]: JSON.stringify(user) });

    // Invalidate other sessions for this user so a leaked session dies on reset.
    try {
      const keys = await redis.keys('session:*');
      for (const key of keys) {
        const sessionRaw = await redis.get(key);
        const session = safeParseRedisItem<any>(sessionRaw);
        if (session && String(session.userId || '') === userId) {
          await redis.del(key);
        }
      }
    } catch {}

    return NextResponse.json({ success: true, message: 'Password updated. Please log in again with your new password.' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Unable to change password.' }, { status: 500 });
  }
}
