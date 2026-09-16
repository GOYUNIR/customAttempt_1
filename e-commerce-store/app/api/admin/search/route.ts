import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem, ARCHIVE_LEDGER_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Defense-in-depth: the middleware already gates /api/admin with Basic Auth +
  // two-step verification, but this endpoint exposes the full customer ledger,
  // so it also verifies the admin password directly — rate-limited so it
  // can't be used to brute-force that password, and so a compromised
  // low-privilege session can't scrape the entire ledger in a tight loop.
  const limited = await rateLimitedResponse('admin_search', request, 30, 60);
  if (limited) return limited;

  const url = new URL(request.url);
  const password = String(url.searchParams.get('password') || '');
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const redis = createKvClient();
    if (!redis) return NextResponse.json({ results: [] });
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!query) return NextResponse.json({ results: [] });

    const allRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    const matches = allRaw
      .map((item) => safeParseKvItem<any>(item))
      .filter(Boolean)
      .filter((entry) => {
        const email = String(entry.email || '').toLowerCase();
        const address = String(entry.shippingAddress || '').toLowerCase();
        const variant = String(entry.variant || '').toLowerCase();
        return email.includes(query) || address.includes(query) || variant.includes(query);
      })
      .reverse()
      .slice(0, 200);

    return NextResponse.json({ results: matches });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, results: [] }, { status: 500 });
  }
}
