import { NextResponse } from 'next/server';
import { getAdminPassword } from '@/lib/server-config';
import { adminLoginAuthorized } from '@/lib/admin-verify';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // This checks the SAME admin password as /api/admin/login — without its
    // own limiter it would be an un-throttled bypass of that route's
    // rate limit (guess the password here instead).
    const limited = await rateLimitedResponse('admin_verify_password', request, 10, 60);
    if (limited) return limited;

    const body = await request.json();
    const password = String(body?.password || '');
    if (!getAdminPassword()) {
      return NextResponse.json({ ok: false, error: 'Server password not configured.' }, { status: 500 });
    }
    if (!(await adminLoginAuthorized(request, password))) {
      return NextResponse.json({ ok: false, error: 'Invalid password.' }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}