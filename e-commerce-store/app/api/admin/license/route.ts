import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import {
  getLicenseStatus,
  clearLicenseCache,
  licenseBanner,
  licenseEnforced,
  resolveLicenseKey,
  maskLicenseKey,
} from '@/lib/license';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/**
 * GET /api/admin/license — current licensing status (masked key only). POST
 * forces a re-check against LICENSE_SERVER_URL (clears the in-memory cache).
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const status = await getLicenseStatus({ force: true });
  return NextResponse.json({
    ok: true,
    enforced: licenseEnforced(),
    keyMasked: maskLicenseKey(resolveLicenseKey()),
    status: status.status,
    graceDaysRemaining: status.graceDaysRemaining,
    reason: status.reason,
    writesAllowed: status.writesAllowed,
    banner: licenseBanner(status.status),
  });
}

export async function POST(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  clearLicenseCache();
  const status = await getLicenseStatus({ force: true });
  return NextResponse.json({
    ok: true,
    status: status.status,
    graceDaysRemaining: status.graceDaysRemaining,
    writesAllowed: status.writesAllowed,
    banner: licenseBanner(status.status),
  });
}
