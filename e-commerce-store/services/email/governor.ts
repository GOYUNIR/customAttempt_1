/**
 * SERVICES / EMAIL — the governed driver: the ONE place every email passes.
 *
 * `EmailFactory.getDriver()` returns this, wrapping the real providers, so
 * every send (sign-in codes, order and winner emails, signup links, alerts,
 * Growth modules) gets the same four things, once:
 *
 *   ROUTING     a recipient on a reserved test domain (.invalid, .test,
 *               example.com, …) is never sent anywhere: it goes to the sink,
 *               a recording driver the proofs read back. Nothing a proof or a
 *               simulation does can spend real email or hit a real inbox.
 *   CAPACITY    each provider's daily AND monthly limits (data:
 *               email_provider_plans) are reserved atomically before a send
 *               (Postgres, not KV: KV increments are not atomic here).
 *   SHARES      signup mail may use only part of a provider's daily limit
 *               (policy `email.signup_daily_share_percent`, ~40%); the rest is
 *               kept for sign-in codes, orders, winners and alerts.
 *   FAILOVER    providers are tried in priority order (Cloudflare primary,
 *               Resend fallback). Defined failure modes:
 *                 - provider full (our count, or the provider says its daily
 *                   limit is reached): the provider is marked full for the
 *                   day and the next one is tried;
 *                 - provider error (5xx, network, rate limit, not configured):
 *                   the slot is released and the next one is tried. A timeout
 *                   AFTER the provider accepted can mean a duplicate; a
 *                   duplicate sign-in code is better than a missing one;
 *                 - message rejected (bad recipient, bad sender, too large):
 *                   NOT retried elsewhere (it would fail the same way, and a
 *                   second provider must not double-send); returned as failed.
 *               When every provider is full, the send fails with
 *               `limited: 'capacity'` (or 'signup_share' for signup mail).
 *   ACCOUNTING  each delivered send is recorded once in the cost ledger,
 *               against its store, module and provider.
 *
 * Zero `@/` imports: the dependencies are injected, so node --test exercises
 * all of it without a network or a database.
 */
import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult, EmailCategory, EmailProviderId } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';

export type ProviderPlan = {
  provider: string;
  plan: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  priority: number;
};

export type ReserveOutcome = 'ok' | 'daily' | 'monthly' | 'category';

export interface CapacityStore {
  /** Atomically take one slot (and one of `category`'s share when given). */
  reserve(p: { provider: string; day: string; month: string; dailyLimit: number | null; monthlyLimit: number | null; category: string; categoryDailyLimit: number | null }): Promise<ReserveOutcome>;
  /** Give back a slot taken for a send that did not happen. */
  release(p: { provider: string; day: string; month: string; category: string }): Promise<void>;
  /** The provider itself said it is full today: stop asking it until tomorrow. */
  markFull(p: { provider: string; day: string }): Promise<void>;
  /** How much is used, without taking anything (for "is there room?"). */
  usage(p: { provider: string; day: string; month: string; category: string }): Promise<{ day: number; month: number; category: number; full: boolean }>;
}

export type ProviderLink = { driver: EmailDriver; plan: ProviderPlan };

/** How a provider failure should be treated (each driver reports its own). */
export type FailureKind = 'full' | 'transient' | 'rejected';

export type SendFailure = { ok: false; error?: unknown; provider: EmailProviderId; skipped?: boolean; failure?: FailureKind; limited?: 'capacity' | 'signup_share' };

/** RFC 2606 / 6761 reserved names, plus anything configured: never real mail. */
const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
export function isSinkRecipient(to: string, extraDomains: string[] = []): boolean {
  const domain = String(to || '').trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  if (!domain || !String(to).includes('@')) return false;
  const tld = domain.split('.').pop() || '';
  const under = (d: string) => domain === d || domain.endsWith('.' + d);
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some(under) || extraDomains.map((d) => d.trim().toLowerCase()).filter(Boolean).some(under);
}

export const dayKey = (now: Date) => now.toISOString().slice(0, 10);
export const monthKey = (now: Date) => now.toISOString().slice(0, 7);

export interface GovernorOptions {
  chain: ProviderLink[];
  sink: EmailDriver;
  sinkPlan: ProviderPlan;
  capacity: CapacityStore;
  /** Signup mail's share of each provider's daily limit, in percent. */
  signupSharePercent: number;
  /** Everything goes to the sink (simulations: EMAIL_DRIVER=record). */
  recordOnly?: boolean;
  /** Extra sink domains from config. */
  sinkDomains?: string[];
  /** Called once per delivered send (the cost ledger). Never throws into a send. */
  onSent?: (info: { provider: string; message: EmailMessage }) => Promise<void>;
  defaultFrom?: string;
  brandName?: string;
  now?: () => Date;
}

export class GovernedEmailDriver implements EmailDriver {
  readonly provider: EmailProviderId;
  readonly configured: boolean;
  private readonly o: GovernorOptions;
  constructor(o: GovernorOptions) {
    this.o = o;
    const first = [...o.chain].filter((l) => l.driver.configured).sort((a, b) => a.plan.priority - b.plan.priority)[0];
    this.provider = o.recordOnly ? o.sink.provider : (first?.driver.provider ?? o.sink.provider);
    this.configured = Boolean(o.recordOnly) || o.chain.some((l) => l.driver.configured);
  }

  /** The links a message to `to` would use, in order. */
  private linksFor(to: string): ProviderLink[] {
    if (this.o.recordOnly || isSinkRecipient(to, this.o.sinkDomains)) return [{ driver: this.o.sink, plan: this.o.sinkPlan }];
    return [...this.o.chain].filter((l) => l.driver.configured).sort((a, b) => a.plan.priority - b.plan.priority);
  }

  private categoryLimit(plan: ProviderPlan, category: EmailCategory): number | null {
    if (category !== 'signup' || plan.dailyLimit == null) return null;
    return Math.floor((plan.dailyLimit * Math.max(0, Math.min(100, this.o.signupSharePercent))) / 100);
  }

  /** Is there room for one more `category` email to `to` today (takes nothing)? */
  async hasRoom(category: EmailCategory, to: string): Promise<boolean> {
    const now = (this.o.now || (() => new Date()))();
    for (const link of this.linksFor(to)) {
      const u = await this.o.capacity.usage({ provider: link.plan.provider, day: dayKey(now), month: monthKey(now), category });
      const catLimit = this.categoryLimit(link.plan, category);
      if (u.full) continue;
      if (link.plan.dailyLimit != null && u.day >= link.plan.dailyLimit) continue;
      if (link.plan.monthlyLimit != null && u.month >= link.plan.monthlyLimit) continue;
      if (catLimit != null && u.category >= catLimit) continue;
      return true;
    }
    return false;
  }

  async send2FA(to: string, code: string, options?: CodeEmailOptions): Promise<EmailSendResult> {
    return this.sendTransactional({
      to,
      from: '',
      subject: options?.subject || `Your verification code: ${code}`,
      html: buildCodeEmailHtml({
        code, headline: options?.headline, body: options?.body, ctaLabel: options?.ctaLabel, ctaUrl: options?.ctaUrl,
        brandName: options?.brandName || this.o.brandName || DEFAULT_EMAIL_BRAND, logoUrl: options?.logoUrl,
      }),
      meta: options?.meta,
    });
  }

  async sendTransactional(message: EmailMessage): Promise<EmailSendResult> {
    const now = (this.o.now || (() => new Date()))();
    const day = dayKey(now), month = monthKey(now);
    const category: EmailCategory = message.meta?.category || 'standard';
    const msg: EmailMessage = { ...message, from: message.from || this.o.defaultFrom || '' };
    const links = this.linksFor(msg.to);
    if (links.length === 0) return { ok: false, skipped: true, error: 'No email provider configured.', provider: this.provider };
    let last: SendFailure | null = null;
    let shareOnly = true;
    for (const link of links) {
      const p = link.plan.provider;
      const got = await this.o.capacity.reserve({ provider: p, day, month, dailyLimit: link.plan.dailyLimit, monthlyLimit: link.plan.monthlyLimit, category, categoryDailyLimit: this.categoryLimit(link.plan, category) });
      if (got !== 'ok') {
        if (got !== 'category') shareOnly = false;
        last = { ok: false, provider: link.driver.provider, error: p + ' ' + got + ' limit reached', limited: got === 'category' ? 'signup_share' : 'capacity' };
        continue;
      }
      shareOnly = false;
      let result: EmailSendResult;
      try { result = await link.driver.sendTransactional(msg); }
      catch (error) { result = { ok: false, error, provider: link.driver.provider, failure: 'transient' } as SendFailure; }
      if (result.ok) {
        if (this.o.onSent) await this.o.onSent({ provider: p, message: msg }).catch(() => undefined);
        return result;
      }
      const failure = (result as SendFailure).failure || 'transient';
      await this.o.capacity.release({ provider: p, day, month, category }).catch(() => undefined);
      if (failure === 'full') await this.o.capacity.markFull({ provider: p, day }).catch(() => undefined);
      last = { ...(result as SendFailure), failure };
      if (failure === 'rejected') return last;
    }
    if (last && last.limited && !shareOnly) last = { ...last, limited: 'capacity' };
    return last || { ok: false, provider: this.provider, error: 'not sent' };
  }
}
