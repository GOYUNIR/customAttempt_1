import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cookie = request.headers.get('cookie');
  if (!cookie) {
    return NextResponse.json({ user: null });
  }
  
  // Parse cookies manually
  const cookiePairs = cookie.split(';').map(c => c.trim().split('='));
  const cookieMap: Record<string, string> = {};
  for (const [key, value] of cookiePairs) {
    cookieMap[key] = value;
  }
  const token = cookieMap['goyunir_session'];
  
  if (!token) {
    return NextResponse.json({ user: null });
  }
  
  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ error: 'System error' }, { status: 500 });
  }
  
  const sessionData = await redis.get(`session:${token}`);
  if (!sessionData) {
    return NextResponse.json({ user: null });
  }
  
  const session = safeParseRedisItem<any>(sessionData);
  if (!session || Date.now() > session.expiresAt) {
    await redis.del(`session:${token}`);
    return NextResponse.json({ user: null });
  }
  
  return NextResponse.json({ 
    user: { 
      id: session.userId, 
      email: session.email, 
      role: session.role, 
      rewards: session.rewards || 0 
    } 
  });
}