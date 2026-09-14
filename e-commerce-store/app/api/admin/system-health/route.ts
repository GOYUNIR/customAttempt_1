import { NextResponse } from 'next/server';
import { adminAuthorized } from '@/lib/admin-verify';
import { runAllHealthChecks, summarizeChecks } from '@/lib/system-diagnostics';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/system-health — the System Health & Security Diagnostic
 * Panel's data source. The actual checks live in lib/system-diagnostics.ts,
 * shared with scripts/production-readiness-check.ts so the admin panel and
 * the CLI pre-flight check can never silently drift apart.
 */
export async function GET(request: Request) {
  const limited = await rateLimitedResponse('admin_system_health', request, 20, 60);
  if (limited) return limited;

  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const checks = await runAllHealthChecks();
  return NextResponse.json({ ok: true, checks, summary: summarizeChecks(checks), checkedAt: new Date().toISOString() });
}
