/**
 * SPEED TO LEAD (our own sales team), the pure half: what a valid lead looks
 * like, how long one has waited, which are going cold, and the measurement.
 * lib/leads.ts does the database and email; this file has no imports so the
 * rules are tested without either (tests/leads-rules.test.ts).
 */
export type LeadInput = { email: string; name: string; company: string; message: string; source: string };
export type LeadStatus = 'new' | 'working' | 'won' | 'lost';
export const LEAD_STATUSES: LeadStatus[] = ['new', 'working', 'won', 'lost'];

/** A lead not answered in this long is going cold: the sales inbox is told once. */
export const COLD_AFTER_MINUTES = 15;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,40}$/;
const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Normalise and validate what the form sent (pure). */
export function parseLeadInput(raw: Record<string, unknown>): { ok: true; lead: LeadInput } | { ok: false; error: string; field: string } {
  const email = clean(raw.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.', field: 'email' };
  const message = String(raw.message ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000);
  if (message.length < 2) return { ok: false, error: 'Tell us a little about what you need.', field: 'message' };
  const source = clean(raw.source, 40).toLowerCase();
  return { ok: true, lead: { email, name: clean(raw.name, 120), company: clean(raw.company, 160), message, source: SOURCE_RE.test(source) ? source : 'unknown' } };
}

/** Minutes a lead has waited for its first reply (or waited, if answered). */
export function waitedMinutes(lead: { created_at: string; first_response_at?: string | null }, now: Date): number {
  const end = lead.first_response_at ? new Date(lead.first_response_at).getTime() : now.getTime();
  return Math.max(0, Math.round((end - new Date(lead.created_at).getTime()) / 60_000));
}

/** Leads to nudge about now: new, unanswered, older than the threshold, never nudged. */
export function coldLeads<T extends { status: string; first_response_at?: string | null; nudged_at?: string | null; created_at: string }>(leads: T[], now: Date, afterMinutes = COLD_AFTER_MINUTES): T[] {
  return leads.filter((l) => l.status === 'new' && !l.first_response_at && !l.nudged_at && waitedMinutes(l, now) >= afterMinutes);
}

/** Median minutes to first reply over answered leads (the metric). */
export function medianResponseMinutes(leads: Array<{ created_at: string; first_response_at?: string | null }>): number | null {
  const xs = leads.filter((l) => l.first_response_at).map((l) => waitedMinutes(l, new Date(0))).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/** "3 min", "2 h 5 min", "1 d 4 h". */
export function formatWait(minutes: number): string {
  if (minutes < 60) return minutes + ' min';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
  const h = Math.floor((minutes % (24 * 60)) / 60);
  return Math.floor(minutes / (24 * 60)) + ' d' + (h ? ' ' + h + ' h' : '');
}
