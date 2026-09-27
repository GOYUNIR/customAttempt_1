/**
 * EMAILS TO A MERCHANT STORE'S CUSTOMERS: order confirmed, entry received,
 * raffle won / waitlist item bought.
 *
 * Every email is the STORE's: its name as the sender, its own support address
 * as reply-to (none when it has not set one -- never the owner's sign-in
 * email), its own address as the link. Nothing of the original store: these go
 * out through sendStoreEmail, which adds no masthead, brand or reply-to of its
 * own. Store- and customer-supplied text is escaped.
 *
 * Every send is AFTER the money step it reports is complete, BEST-EFFORT (it
 * never throws into the order, entry or charge path) and ONCE: a claim per
 * (store, kind, reference) in the same table the charge path uses, so a
 * retried webhook or a re-run draw never sends twice.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { sendStoreEmail, platformSendingAddress } from '@/lib/email';
import { storeFromHeader } from '@/lib/tenant-email-render';
import { claimWebhookKey, completeWebhookKey, releaseWebhookKey } from '@/lib/webhook-dedupe';
import { subrequestCount, SUBREQUEST_LIMIT_FREE } from '@/lib/subrequest-meter';

/** Outbound calls one send can cost (store lookup 2, claim up to 2, send 1,
 *  usage row 1, complete 1): what a caller must budget for. */
export const STORE_EMAIL_CALLS = 7;

/** Whether an invocation that started at `invocationStart` (subrequestCount)
 *  can still afford `need` more calls with a safety margin. No start = unknown
 *  = yes (the caller has no budget to protect). */
export function withinCallBudget(invocationStart: number | undefined, need: number): boolean {
  if (invocationStart === undefined) return true;
  const limit = Math.max(20, Number(process.env.WORKER_SUBREQUEST_LIMIT) || SUBREQUEST_LIMIT_FREE);
  return subrequestCount() - invocationStart + need <= limit - 4;
}

export type { StoreIdentity, StoreEmail } from '@/lib/tenant-email-render';
import { EMAIL_RE, type StoreIdentity, type StoreEmail } from '@/lib/tenant-email-render';
export { esc, money, renderOrderConfirmed, renderEntryReceived, renderEntryCharged } from '@/lib/tenant-email-render';

const cache = new Map<string, { at: number; id: StoreIdentity }>();

/** The store as its customers know it. Cached for a minute per isolate. */
export async function storeIdentity(tenantId: string): Promise<StoreIdentity | null> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const db = getDb();
  const [tenants, configs] = await Promise.all([
    db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['name', 'slug'], limit: 1 }),
    db.select<any>('tenant_store_config', { where: { tenant_id: eq(tenantId) }, select: ['config'], limit: 1 }),
  ]);
  const t = (tenants as any[])[0];
  if (!t) return null;
  const config = ((configs as any[])[0]?.config || {}) as Record<string, any>;
  const support = String(config.legal?.supportEmail || '').trim();
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '');
  const id: StoreIdentity = {
    name: String(config.branding?.brandName || t.name || '').trim() || 'Store',
    supportEmail: EMAIL_RE.test(support) ? support : null,
    storeUrl: root && t.slug ? 'https://' + t.slug + '.' + root : null,
  };
  cache.set(tenantId, { at: Date.now(), id });
  return id;
}

/**
 * Send one store email, once. Never throws. `key` names what it reports
 * (an order ref, an entry id + attempt) so the same event never sends twice.
 */
export async function sendStoreEmailOnce(input: {
  tenantId: string; kind: string; key: string; to: string; build: (store: StoreIdentity) => StoreEmail;
}): Promise<{ status: 'sent' | 'duplicate' | 'skipped' | 'failed'; id?: string; note?: string }> {
  const to = String(input.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { status: 'skipped', note: 'no valid recipient' };
  const address = platformSendingAddress();
  if (!address) return { status: 'skipped', note: 'no platform sending address' };
  const claimKey = input.tenantId + ':' + input.kind + ':' + input.key;
  try {
    if ((await claimWebhookKey('tenant_email', claimKey)) === 'duplicate') return { status: 'duplicate' };
  } catch (err) {
    console.error('[tenant-email] claim failed, not sent', claimKey, (err as Error)?.message || err);
    return { status: 'failed', note: 'claim failed' };
  }
  try {
    const store = await storeIdentity(input.tenantId);
    if (!store) throw new Error('store not found');
    const mail = input.build(store);
    const r = await sendStoreEmail({
      tenantId: input.tenantId, from: storeFromHeader(store.name, address), to,
      replyTo: store.supportEmail, subject: mail.subject, html: mail.html, text: mail.text,
    });
    if (!r.ok) throw new Error(String((r.error as any)?.message || r.error || 'send failed'));
    await completeWebhookKey('tenant_email', claimKey);
    return { status: 'sent', id: r.id };
  } catch (err) {
    await releaseWebhookKey('tenant_email', claimKey).catch(() => {});
    console.error('[tenant-email] ' + input.kind + ' NOT SENT for ' + claimKey + ': ' + ((err as Error)?.message || err));
    return { status: 'failed', note: (err as Error)?.message || String(err) };
  }
}
