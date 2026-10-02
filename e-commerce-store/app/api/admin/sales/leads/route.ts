import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasSalesAccess } from '@/lib/admin-actor';
import { listLeads, claimLead, markResponded, setLeadStatus, leadsEnabled } from '@/lib/leads';
import { waitedMinutes, medianResponseMinutes, formatWait, COLD_AFTER_MINUTES } from '@/lib/leads-rules';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/sales/leads — the Sales Hub's Pipeline (lib/leads.ts). Platform
 * staff with sales access only (a sales role or super-admin); a merchant's
 * session, even an owner's, is refused. Leads are the platform's, not any
 * store's.
 *   GET   the queue (unanswered oldest first) and the speed-to-lead median
 *   POST  { id, action: 'claim' | 'responded' | 'status', status? }
 */
async function staff(request: Request) {
  if (!(await adminAuthorized(request))) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const actor = await resolveAdminActor(request);
  if (!actorHasSalesAccess(actor)) return { error: NextResponse.json({ error: 'Sales Hub access required.' }, { status: 403 }) };
  return { email: String(actor?.email || '').toLowerCase() };
}

export async function GET(request: Request) {
  const s = await staff(request);
  if ('error' in s) return s.error;
  const now = new Date();
  const leads = await listLeads();
  const last30 = leads.filter((l) => now.getTime() - new Date(l.created_at).getTime() < 30 * 86400_000);
  const median = medianResponseMinutes(last30);
  return NextResponse.json({
    enabled: leadsEnabled(),
    me: s.email,
    coldAfterMinutes: COLD_AFTER_MINUTES,
    medianFirstReply: median === null ? null : formatWait(median),
    answered30d: last30.filter((l) => l.first_response_at).length,
    total30d: last30.length,
    leads: leads.map((l) => ({ ...l, waited: formatWait(waitedMinutes(l, now)), waitedMinutes: waitedMinutes(l, now) })),
  }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const s = await staff(request);
  if ('error' in s) return s.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(body.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Which lead?' }, { status: 400 });
  const action = String(body.action || '');
  const r = action === 'claim' ? await claimLead(id, s.email)
    : action === 'responded' ? await markResponded(id, s.email)
    : action === 'status' ? await setLeadStatus(id, String(body.status || ''), s.email)
    : { ok: false as const, status: 400, error: 'Unknown action.' };
  return r.ok ? NextResponse.json({ lead: r.lead }) : NextResponse.json({ error: r.error }, { status: r.status });
}
