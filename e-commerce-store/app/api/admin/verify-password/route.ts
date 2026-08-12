import { NextResponse } from 'next/server';
import { getAdminPassword } from '@/lib/server-config';


export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const password = String(body?.password || '');
    const master = getAdminPassword() || '';
    if (!master) {
      return NextResponse.json({ ok: false, error: 'Server password not configured.' }, { status: 500 });
    }
    if (password !== master) {
      return NextResponse.json({ ok: false, error: 'Invalid password.' }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}