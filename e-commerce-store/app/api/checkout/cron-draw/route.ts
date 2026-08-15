import { NextResponse } from 'next/server';
import { getAdminPassword } from '@/lib/server-config';
import { runAutoDraws } from '@/lib/auto-draw';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled auto-draw trigger (Vercel cron / QStash / admin ping).
 *
 * Everything is delegated to the shared Redis-driven runner in lib/auto-draw.ts
 * so admin-created products (which live ONLY in store:products — NOT the static
 * config the old cron iterated) get their draws too. The runner decides per
 * pool whether it's due (releaseEndsAt passed / archived / schedule cadence)
 * and only charges when inventory remains.
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
