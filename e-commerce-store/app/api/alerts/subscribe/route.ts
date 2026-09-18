import { NextResponse } from 'next/server';
import { subscribe } from '@/lib/alert-subscribers';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { sendWaitlistConfirmationEmail } from '@/lib/email';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // No KV check here any more. The list moved to Postgres in H8 (00023), but
    // this route kept opening a Redis client it never used and refusing the
    // request when it was absent — so the only way onto the back-in-stock list
    // would have 500'd the moment KV was switched off, for a service it does
    // not touch.
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    if (String(body?.company || '').trim()) {
      return NextResponse.json({ success: true, message: 'You are on the release list.' });
    }

    const email = String(body?.email || '').trim().toLowerCase();
    const source = String(body?.source || 'site').trim().toLowerCase();
    const interests = Array.isArray(body?.interests) ? body.interests.map(String).filter(Boolean).slice(0, 20) : [];
    if (!isValidEmail(email)) return NextResponse.json({ error: 'Valid email required.' }, { status: 400 });

    const limited = await rateLimitedResponse('alerts_subscribe', request, 10, 60);
    if (limited) return limited;

    // H8: the list lives in public.alert_subscribers (migration 00023).
    const tenantId = await ensureDefaultTenant();
    const result = await subscribe(tenantId, email, { source, interests });
    if (!result.ok) {
      return NextResponse.json({ error: 'Subscription failed. Please try again.' }, { status: 500 });
    }

    // Only a BRAND NEW subscriber gets the confirmation email. The KV version
    // decided this by `existing.createdAt` being absent; the insert itself now
    // says so, which is the same rule without a second read that could race.
    if (result.created) {
      await sendWaitlistConfirmationEmail({ to: email });
    }

    return NextResponse.json({ success: true, message: 'You are on the release list.' });
  } catch (err: any) {
    console.error('[alerts/subscribe] failed', err?.message || err);
    return NextResponse.json({ error: 'Subscription failed. Please try again.' }, { status: 500 });
  }
}