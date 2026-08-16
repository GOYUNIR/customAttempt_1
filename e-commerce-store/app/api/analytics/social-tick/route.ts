import { NextResponse } from 'next/server';
import { createRedisClient, getSocialProofOverride, getAdminPassword } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { maybeAutoIncrementSocialProof } from '@/lib/social-proof';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || getAdminPassword();
  if (!secret) return true;
  const auth = request.headers.get('authorization');
  const key = url.searchParams.get('key') || '';
  if (request.headers.get('x-vercel-cron') === '1') return true;
  if (auth === `Bearer ${secret}`) return true;
  if (key === secret) return true;
  return false;
}

// Cron-only auto-increment trigger. It shares the exact engine the public
// heartbeat uses (`maybeAutoIncrementSocialProof`), so the daily caps + gap
// windows are identical no matter which trigger fires — a script can never
// inflate the counter past the configured ceiling.
export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ skipped: true, reason: 'no redis' });

  const cfg = {
    ...GOYUNIR_STORE_SUITE.socialProof,
    ...((await getSocialProofOverride(redis)) || {}),
  };

  const result = await maybeAutoIncrementSocialProof(redis, cfg);
  return NextResponse.json(result);
}
