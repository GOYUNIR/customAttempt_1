import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY, AUTH_SESSION_PREFIX } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Constant-time comparison of two hex strings (password hashes). */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const hash = scryptSync(password, salt, 64).toString('hex');
    return safeEqualHex(hash, expectedHash);
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

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');

    if (currentPassword.length < 1) {
      return NextResponse.json({ error: 'Enter your current password.' }, { status: 400 });
    }
    if (!isValidPassword(newPassword)) {
      return NextResponse.json({ error: 'New password must be between 6 and 128 characters.' }, { status: 400 });
    }
    if (currentPassword === newPassword) {
      return NextResponse.json({ error: 'New password must be different from the current one.' }, { status: 400 });
    }

    const limited = await rateLimitedResponse('change_password', request, 10, 60);
    if (limited) return limited;

    // Find the user record
    const raw = await redis.hgetall(USERS_KEY);
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
    await redis.hset(USERS_KEY, { [userId]: JSON.stringify(user) });

    // Invalidate other sessions for this user so a leaked session dies on reset.
    try {
      const keys = await redis.keys(`${AUTH_SESSION_PREFIX}*`);
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
    console.error('[account/change-password] failed', err?.message || err);
    return NextResponse.json({ error: 'Unable to change password.' }, { status: 500 });
  }
}
