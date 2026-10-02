import { NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { getAdminPassword } from '@/lib/server-config';
import { leadsEnabled, nudgeColdLeads } from '@/lib/leads';
import { sendSalesLeadEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * /api/cron/lead-nudge — leads unanswered for COLD_AFTER_MINUTES get ONE
 * internal email to the sales inbox (lib/leads.ts nudgeColdLeads). Called by
 * the cron worker every 10 minutes (cron-worker/), with the CRON_SECRET
 * bearer. Does nothing while PLATFORM_LEADS_ENABLED is off.
 */
async function run(request: Request) {
  if (!isCronAuthorized(request, process.env.CRON_SECRET || getAdminPassword(), { openWhenNoSecret: false })) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!leadsEnabled()) return NextResponse.json({ ok: true, skipped: 'leads are off' });
  const result = await nudgeColdLeads(new Date(), (subject, lines) => sendSalesLeadEmail({ subject, lines }));
  return NextResponse.json({ ok: true, ...result });
}

export const GET = run;
export const POST = run;
