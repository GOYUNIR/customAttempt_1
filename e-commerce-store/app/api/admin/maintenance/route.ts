import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { maintenanceModeEnabled } from '@/lib/maintenance';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/**
 * GET /api/admin/maintenance — whether MAINTENANCE_MODE is on. The flag itself
 * is environment-only (an ops action), so this endpoint is read-only.
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    enabled: maintenanceModeEnabled(),
    setWith: 'npx wrangler secret put MAINTENANCE_MODE   # set to "true"',
  });
}
