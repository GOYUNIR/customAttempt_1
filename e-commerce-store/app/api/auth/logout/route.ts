import { NextResponse } from 'next/server';
import { createRedisClient, sessionKey } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const cookie = request.headers.get('cookie');
  let token: string | null = null;
  
  if (cookie) {
    const cookiePairs = cookie.split(';').map(c => c.trim().split('='));
    const cookieMap: Record<string, string> = {};
    for (const [key, value] of cookiePairs) {
      cookieMap[key] = value;
    }
    token = cookieMap['goyunir_session'] || null;
  }
  
  if (token) {
    const redis = createRedisClient();
    if (redis) {
      await redis.del(sessionKey(token));
    }
  }
  
  const response = NextResponse.json({ success: true });
  response.cookies.delete('goyunir_session');
  return response;
}