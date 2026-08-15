import { NextResponse } from 'next/server';
import { getAdminPassword } from '@/lib/server-config';
import { runAutoDraws } from '@/lib/auto-draw';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled auto-draw trigger (Vercel cron / QStash / admin ping).
 *
 * Every product's draw timing now comes from its OWN Redis record
 * (`store:products`: releaseEndsAt / goLiveAt / isArchived) plus the global
 * schedule — the old code only ever looked at the STATIC productCatalog, so
 * admin-created products never drew. All scheduling + charging is delegated to
 * the shared runner in lib/auto-draw.ts.
 */
function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || getAdminPassword();
  if (!secret) return false;
  const auth = request.headers.get('authorization');
  const key = url.searchParams.get('key') || '';
  if (request.headers.get('x-vercel-cron') === '1') return true;
  if (auth === `Bearer ${secret}`) return true;
  if (key === secret) return true;
  return false;
}

async function runAutoDraw(request: Request) {
  const url = new URL(request.url);

  // Allow ping requests to check status without auth.
  if (url.searchParams.get('ping') === '1') {
    return NextResponse.json({
      ok: true,
      message: 'Draw engine ready. Runs are delegated to lib/auto-draw (Redis-driven).',
    });
  }

  if (!authorized(request)) {
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

  return NextResponse.json(result);
}

export async function GET(request: Request) {
  return runAutoDraw(request);
}

export async function POST(request: Request) {
  return runAutoDraw(request);
}
