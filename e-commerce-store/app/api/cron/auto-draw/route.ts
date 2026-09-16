import { NextResponse } from 'next/server';
import { flushWinnerNotifications } from '@/lib/notifications';
import { getAdminPassword } from '@/lib/server-config';
import { isCronAuthorized, isPlatformScheduledInvocation } from '@/lib/cron-auth';
import { runAutoDraws } from '@/lib/auto-draw';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled auto-draw trigger (Vercel cron / Netlify scheduled function /
 * Cloudflare cron worker / any external scheduler).
 *
 * Every product's draw timing now comes from its OWN Redis record
 * (`store:products`: releaseEndsAt / goLiveAt / isArchived) plus the global
 * schedule — the old code only ever looked at the STATIC productCatalog, so
 * admin-created products never drew. All scheduling + charging is delegated to
 * the shared runner in lib/auto-draw.ts.
 *
 * Auth is delegated to lib/cron-auth.ts (cross-platform): Vercel's
 * `x-vercel-cron` header is trusted directly; every other scheduler must send
 * `Authorization: Bearer $CRON_SECRET` (or the legacy `?key=` /
 * `x-cron-secret` forms).
 */

async function runAutoDraw(request: Request) {
  const url = new URL(request.url);

  // Allow ping requests to check status without auth.
  if (url.searchParams.get('ping') === '1') {
    return NextResponse.json({
      ok: true,
      message: 'Draw engine ready. Runs are delegated to lib/auto-draw (Redis-driven).',
    });
  }

  // Rate-limit failed/guessing attempts against CRON_SECRET — skipped only
  // for a trusted platform-signed invocation (Vercel cron), which never
  // carries a guessable secret to begin with.
  if (!isPlatformScheduledInvocation(request)) {
    const limited = await rateLimitedResponse('cron_auto_draw_auth', request, 20, 60);
    if (limited) return limited;
  }

  if (!isCronAuthorized(request, process.env.CRON_SECRET || getAdminPassword(), { openWhenNoSecret: false })) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const force = url.searchParams.get('force') === '1';
  const result = await runAutoDraws({
    request,
    force,
    ignoreCooldown: force,
    onlyProductId: url.searchParams.get('productId') || undefined,
    onlyProductName: url.searchParams.get('productName') || undefined,
  });

  // Retry any transactional notification that failed earlier. A winner who
  // was charged but whose email bounced is recovered here, or dead-lettered
  // for the health check once attempts are exhausted (ARCHITECTURE.md SEV-3).
  // Never allowed to fail the cron run: the draw is the important part.
  let notifications = null;
  try {
    notifications = await flushWinnerNotifications();
  } catch (err) {
    console.error('[cron/auto-draw] notification flush failed', (err as Error)?.message || err);
  }

  return NextResponse.json({ ...result, notifications });
}

export async function GET(request: Request) {
  return runAutoDraw(request);
}

export async function POST(request: Request) {
  return runAutoDraw(request);
}
