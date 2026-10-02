/**
 * SPEED TO LEAD for our own sales team (STRATEGY §7): people who ask to talk
 * to us, who owns each, and how long they waited for a human reply. Leads are
 * the PLATFORM's (platform_leads, 00028: no tenant, staff only), never a
 * merchant's. Off by default: PLATFORM_LEADS_ENABLED=true turns on the public
 * form and the cold-lead nudge; the Sales Hub queue always reads.
 *
 *   capture   POST /api/leads (marketing host; Turnstile, per-IP limit,
 *             honeypot, disposable emails refused, one reply for everything)
 *   queue     /api/admin/sales/leads (sales and super-admin only)
 *   claim     a rep takes a lead (one owner; atomic)
 *   replied   first_response_at set ONCE, the metric's end
 *   nudge     /api/cron/lead-nudge: one internal email per cold lead, once
 */
import { getDb } from '@/lib/db/client';
import { eq, inList, isNull, lt, gte } from '@/lib/db/query';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { COLD_AFTER_MINUTES, coldLeads, formatWait, waitedMinutes, type LeadInput, type LeadStatus, LEAD_STATUSES } from '@/lib/leads-rules';

export const leadsEnabled = () => String(process.env.PLATFORM_LEADS_ENABLED || '').trim().toLowerCase() === 'true';

const COLUMNS = ['id', 'email', 'name', 'company', 'message', 'source', 'status', 'claimed_by', 'claimed_at', 'first_response_at', 'nudged_at', 'created_at', 'updated_at'];
export type Lead = { id: string; email: string; name: string | null; company: string | null; message: string | null; source: string; status: LeadStatus; claimed_by: string | null; claimed_at: string | null; first_response_at: string | null; nudged_at: string | null; created_at: string; updated_at: string };

/**
 * Store a lead. The same person writing again within a day adds to their
 * open lead instead of starting a second one (one conversation, one clock).
 * Returns whether it is new (only new leads notify the sales inbox).
 */
export async function captureLead(lead: LeadInput, meta: { ip?: string } = {}): Promise<{ id: string; isNew: boolean }> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const open = ((await db.select<Lead>('platform_leads', { where: { email: eq(lead.email), status: inList(['new', 'working']), created_at: gte(since) }, select: ['id', 'message'], order: { column: 'created_at', ascending: false }, limit: 1 })) as Lead[])[0];
  if (open) {
    const message = ((open.message || '') + '\n\n--- (again, ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC)\n' + lead.message).slice(-4000);
    await db.update('platform_leads', { where: { id: eq(open.id) } }, { message }, { returning: 'minimal' } as any);
    return { id: open.id, isNew: false };
  }
  const rows = (await db.insert<Lead>('platform_leads', { email: lead.email, name: lead.name || null, company: lead.company || null, message: lead.message, source: lead.source }, { returning: 'representation' } as any)) as any;
  const id = String((Array.isArray(rows) ? rows[0] : rows)?.id || '');
  await recordPlatformAudit({ action: 'lead.captured', actor: 'public:' + lead.email, detail: { leadId: id, source: lead.source }, ipAddress: meta.ip ?? null });
  return { id, isNew: true };
}

/** The queue: unanswered first (oldest at the top), then being worked, then closed. */
export async function listLeads(opts: { limit?: number } = {}): Promise<Lead[]> {
  const rows = (await getDb().select<Lead>('platform_leads', { select: COLUMNS, order: { column: 'created_at', ascending: false }, limit: opts.limit ?? 300 })) as Lead[];
  const rank = (l: Lead) => (l.status === 'new' && !l.first_response_at ? 0 : l.status === 'new' || l.status === 'working' ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
}

export type LeadActionResult = { ok: true; lead: Lead } | { ok: false; status: number; error: string };

/** A rep takes the lead. One owner: the claim only lands if nobody holds it. */
export async function claimLead(id: string, actorEmail: string): Promise<LeadActionResult> {
  const now = new Date().toISOString();
  const rows = (await getDb().update<Lead>('platform_leads', { where: { id: eq(id), claimed_by: isNull() } }, { claimed_by: actorEmail, claimed_at: now }, { returning: 'representation' } as any)) as Lead[];
  if (rows?.length) { await recordPlatformAudit({ action: 'lead.claimed', actor: actorEmail, detail: { leadId: id } }); return { ok: true, lead: rows[0] }; }
  const cur = ((await getDb().select<Lead>('platform_leads', { where: { id: eq(id) }, select: COLUMNS, limit: 1 })) as Lead[])[0];
  if (!cur) return { ok: false, status: 404, error: 'No such lead.' };
  return cur.claimed_by === actorEmail ? { ok: true, lead: cur } : { ok: false, status: 409, error: 'Already claimed by ' + cur.claimed_by + '.' };
}

/**
 * The first human reply went out: the metric's end. Set exactly once (a later
 * call changes nothing), and the lead moves to "working" with this rep as
 * owner if nobody had claimed it.
 */
export async function markResponded(id: string, actorEmail: string): Promise<LeadActionResult> {
  const now = new Date().toISOString();
  const rows = (await getDb().update<Lead>('platform_leads', { where: { id: eq(id), first_response_at: isNull() } }, { first_response_at: now }, { returning: 'representation' } as any)) as Lead[];
  const cur = ((await getDb().select<Lead>('platform_leads', { where: { id: eq(id) }, select: COLUMNS, limit: 1 })) as Lead[])[0];
  if (!cur) return { ok: false, status: 404, error: 'No such lead.' };
  const patch: Record<string, unknown> = {};
  if (cur.status === 'new') patch.status = 'working';
  if (!cur.claimed_by) Object.assign(patch, { claimed_by: actorEmail, claimed_at: now });
  const lead = Object.keys(patch).length ? ((await getDb().update<Lead>('platform_leads', { where: { id: eq(id) } }, patch, { returning: 'representation' } as any)) as Lead[])[0] : cur;
  if (rows?.length) await recordPlatformAudit({ action: 'lead.first_response', actor: actorEmail, detail: { leadId: id, minutes: waitedMinutes(lead, new Date()) } });
  return { ok: true, lead };
}

export async function setLeadStatus(id: string, status: string, actorEmail: string): Promise<LeadActionResult> {
  if (!LEAD_STATUSES.includes(status as LeadStatus)) return { ok: false, status: 400, error: 'Status must be one of ' + LEAD_STATUSES.join(', ') + '.' };
  const rows = (await getDb().update<Lead>('platform_leads', { where: { id: eq(id) } }, { status }, { returning: 'representation' } as any)) as Lead[];
  if (!rows?.length) return { ok: false, status: 404, error: 'No such lead.' };
  await recordPlatformAudit({ action: 'lead.status', actor: actorEmail, detail: { leadId: id, status } });
  return { ok: true, lead: rows[0] };
}

/**
 * Tell the sales inbox about leads going cold, ONCE each: they are marked
 * nudged in the same update that selects them (two runs cannot both send),
 * and unmarked again if the email could not go, so the next run retries.
 */
export async function nudgeColdLeads(now = new Date(), send: (subject: string, lines: string[]) => Promise<{ ok: boolean }>): Promise<{ nudged: number; sent: boolean }> {
  const before = new Date(now.getTime() - COLD_AFTER_MINUTES * 60_000).toISOString();
  const candidates = (await getDb().select<Lead>('platform_leads', { where: { status: eq('new'), first_response_at: isNull(), nudged_at: isNull(), created_at: lt(before) }, select: COLUMNS, limit: 50 })) as Lead[];
  const cold = coldLeads(candidates, now);
  if (!cold.length) return { nudged: 0, sent: false };
  const marked = (await getDb().update<Lead>('platform_leads', { where: { id: inList(cold.map((l) => l.id)), nudged_at: isNull() } }, { nudged_at: now.toISOString() }, { returning: 'representation' } as any)) as Lead[];
  if (!marked?.length) return { nudged: 0, sent: false };
  const lines = marked.map((l) => formatWait(waitedMinutes(l, now)) + ' waiting: ' + (l.name || l.email) + (l.company ? ' (' + l.company + ')' : '') + ' <' + l.email + '>' + (l.claimed_by ? ', claimed by ' + l.claimed_by : ', NOT claimed'));
  const result = await send(marked.length + ' lead' + (marked.length === 1 ? '' : 's') + ' waiting over ' + COLD_AFTER_MINUTES + ' minutes', [...lines, '', 'Open the Sales Hub, Pipeline, to claim and reply.']);
  if (!result.ok) {
    await getDb().update('platform_leads', { where: { id: inList(marked.map((l) => l.id)) } }, { nudged_at: null }, { returning: 'minimal' } as any);
    return { nudged: 0, sent: false };
  }
  return { nudged: marked.length, sent: true };
}
