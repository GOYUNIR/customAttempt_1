/**
 * PROOF READ-BACK of emails production "sent" (verification scripts only,
 * never business code). Proofs NEVER send real email: their addresses are on
 * a sink domain (EMAIL_SINK_DOMAINS, or a reserved .invalid name), which the
 * governed email driver (services/email/governor.ts) records in the
 * `email_sink` table instead of sending. This reads that table, so a proof can
 * check sender, reply-to, subject and body of what a real customer would
 * have received, without spending the provider's daily allowance.
 *
 * (It used to read Resend's sent log for @resend.dev test inboxes. Those are
 * real sends: on 2026-10-01 proof runs used Resend's whole 100/day quota.)
 */
const sinkDomain = () => String(process.env.EMAIL_SINK_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean)[0] || 'proof.invalid';

export const testInbox = (label: string) => label.replace(/[^a-z0-9]/gi, '').toLowerCase() + '@' + sinkDomain();

/** Messages recorded for `to`, newest first, in the shape the proofs read. */
export async function sentTo(getDb: any, to: string, opts: { waitMs?: number } = {}): Promise<any[]> {
  const { eq } = await import('../lib/db/query');
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  for (;;) {
    const rows = ((await getDb().select('email_sink', {
      where: { to_address: eq(to.toLowerCase()) },
      select: ['id', 'to_address', 'from_address', 'reply_to', 'subject', 'html', 'text_body', 'category', 'tenant_id', 'created_at'],
      order: { column: 'created_at', ascending: false },
      limit: 100,
    }).catch(() => [])) as any[]);
    if (rows.length > 0 || Date.now() > deadline) {
      return rows.map((r) => ({ id: r.id, to: [r.to_address], from: r.from_address, reply_to: r.reply_to, subject: r.subject, html: r.html, text: r.text_body, category: r.category, tenant_id: r.tenant_id, created_at: r.created_at }));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * REAL sends only: Resend's own sent log. Used by exactly one proof, the
 * stranger journey, which is the one run allowed to send real email (to an
 * address the owner controls, at most 3 sends). Nothing else may use this.
 */
export async function resendSentTo(getDb: any, to: string, opts: { waitMs?: number } = {}): Promise<any[]> {
  const settings = ((await getDb().select('global_platform_settings', { select: ['mail_provider', 'mail_api_key'], limit: 1 }).catch(() => [])) as any[])[0];
  const key = settings?.mail_provider === 'resend' && settings?.mail_api_key ? settings.mail_api_key : process.env.RESEND_API_KEY;
  const rs = (path: string) => fetch('https://api.resend.com' + path, { headers: { authorization: 'Bearer ' + key } }).then((r) => r.json() as Promise<any>);
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Resend allows ~2 requests/second: an error (e.g. 429) is "ask again",
  // never "nothing was sent". Reads are sequential for the same reason.
  const read = async (path: string) => {
    for (let i = 0; i < 5; i++) {
      const r = await rs(path).catch(() => null);
      if (r && !r.statusCode && !r.name?.includes?.('error')) return r;
      await pause(1200);
    }
    throw new Error('Resend read-back failed for ' + path);
  };
  for (;;) {
    const listed = await read('/emails?limit=100');
    const hits = (listed?.data || []).filter((m: any) => (Array.isArray(m.to) ? m.to : [m.to]).map((x: string) => String(x).toLowerCase()).includes(to.toLowerCase()));
    if (hits.length > 0 || Date.now() > deadline) {
      const full: any[] = [];
      for (const h of hits) { full.push(await read('/emails/' + h.id)); await pause(600); }
      return full;
    }
    await pause(2000);
  }
}
