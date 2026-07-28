import { NextResponse } from 'next/server';
import { runDropDraw } from '@/lib/draw';

export async function POST(request: Request) {
  const adminToken = request.headers.get('x-admin-secret');
  if (!adminToken || adminToken !== process.env.ADMIN_DRAW_TRIGGER_SECRET) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  if (process.env.ALLOW_DROP_TRIGGER !== 'true') {
    return NextResponse.json({ error: 'Manual drop trigger is disabled.' }, { status: 403 });
  }

  const result = await runDropDraw(request);
  return NextResponse.json(result);
}
