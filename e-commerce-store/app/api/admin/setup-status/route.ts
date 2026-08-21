import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/setup-status — DEPRECATED. The checklist backend was folded into
 * /api/admin/setup (the unified setup dashboard). Redirect any direct API
 * calls there so stale clients keep working. (middleware.ts mirrors this for
 * the edge-runtime path.)
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  url.pathname = '/api/admin/setup';
  url.search = '';
  return NextResponse.redirect(url, 308);
}
