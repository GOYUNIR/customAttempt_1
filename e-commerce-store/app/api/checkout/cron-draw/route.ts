import { NextResponse } from 'next/server';
import { runDropDraw } from '@/lib/draw';

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized automated execution.' }, { status: 401 });
  }

  const result = await runDropDraw(request);
  return NextResponse.json(result);
}
