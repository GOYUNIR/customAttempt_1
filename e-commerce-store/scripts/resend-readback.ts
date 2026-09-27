/**
 * PROOF READ-BACK of emails production actually sent (verification scripts
 * only, never business code). The email driver can only send; this reads the
 * provider's sent log so a proof can check sender, reply-to, subject and body
 * of what a real customer would have received.
 *
 * Addresses are Resend's test inbox (delivered+<label>@resend.dev): accepted,
 * logged, never delivered anywhere.
 */
export const testInbox = (label: string) => 'delivered+' + label.replace(/[^a-z0-9]/gi, '').toLowerCase() + '@resend.dev';

export async function sentTo(getDb: any, to: string, opts: { waitMs?: number } = {}): Promise<any[]> {
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
