import { NextResponse } from 'next/server';
import { createRedisClient, getSocialProofOverride, getAdminPassword } from '@/lib/server-config';
import { isCronAuthorized } from '@/lib/cron-auth';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { maybeAutoIncrementSocialProof } from '@/lib/social-proof';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  // Cross-platform scheduler auth (Vercel cron header trusted; every other
  // scheduler sends the CRON_SECRET bearer token). Kept open when no secret is
  // configured, matching the route's historical behavior.
  return isCronAuthorized(request, process.env.CRON_SECRET || getAdminPassword(), { openWhenNoSecret: true });
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
