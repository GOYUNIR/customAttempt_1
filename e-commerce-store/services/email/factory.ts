/**
 * SERVICES / EMAIL — runtime factory.
 *
 * `EmailFactory.getDriver()` is the ONLY way functional features obtain an
 * email sender. It returns the GOVERNED driver (governor.ts), which wraps:
 *
 *   1. Cloudflare Email Service (Workers `send_email` binding `EMAIL`), when
 *      its plan row is active in `email_provider_plans` and the binding exists;
 *   2. the configured provider: `global_platform_settings.mail_provider` +
 *      `.mail_api_key` (Setup Wizard), else the legacy env keys
 *      (RESEND_API_KEY → Resend, POSTMARK_API_KEY, SENDGRID_API_KEY);
 *   3. the sink, for reserved test domains (and everything when
 *      EMAIL_DRIVER=record, which only simulations set).
 *
 * Order, limits and the signup share are DATA (email_provider_plans,
 * platform_policies); counts are reserved atomically in Postgres
 * (email_reserve, 00042). Returns null when no real provider is configured
 * (callers skip), unless recording.
 *
 * The `from` address resolves `EMAIL_FROM` → `RESEND_FROM` → driver default.
 */

import { getBrandName } from '@/lib/env';
import { eq, inList, lt } from '@/lib/db/query';
import { getPlatformSettings } from '@/services/config/platform-settings';
import type { MailProvider } from '@/services/config/types';
import { createEmailDriver, type EmailDriverResolutionOptions } from './registry';
import type { EmailDriver, EmailCategory, EmailMessage } from './types';
import { GovernedEmailDriver, type CapacityStore, type ProviderPlan, type ProviderLink } from './governor';
import { SinkDriver } from './sink.driver';
import { CloudflareEmailDriver, type SendEmailBinding } from './cloudflare.driver';

function resolveFromEnv(): string {
  return process.env.EMAIL_FROM || process.env.RESEND_FROM || '';
}

/** Used only when the plans table cannot be read: the most conservative known plan. */
const FALLBACK_PLANS: Record<string, ProviderPlan> = {
  resend: { provider: 'resend', plan: 'free', dailyLimit: 100, monthlyLimit: 3000, priority: 20 },
  sink: { provider: 'sink', plan: 'test', dailyLimit: 100, monthlyLimit: null, priority: 0 },
};
const PLAN_CACHE_MS = 60_000;
let planCache: { at: number; plans: Record<string, ProviderPlan>; sharePercent: number } | null = null;

async function readPlans(): Promise<{ plans: Record<string, ProviderPlan>; sharePercent: number }> {
  if (planCache && Date.now() - planCache.at < PLAN_CACHE_MS) return planCache;
  const { getDb } = await import('@/lib/db/client');
  let plans: Record<string, ProviderPlan> = { ...FALLBACK_PLANS };
  let sharePercent = 40;
  try {
    const rows = (await getDb().select<any>('email_provider_plans', { where: { active: eq(true) }, select: ['provider', 'plan', 'daily_limit', 'monthly_limit', 'priority'], limit: 50 })) as any[];
    if (Array.isArray(rows) && rows.length) {
      plans = {};
      for (const r of rows) plans[r.provider] = { provider: r.provider, plan: r.plan, dailyLimit: r.daily_limit ?? null, monthlyLimit: r.monthly_limit ?? null, priority: Number(r.priority ?? 100) };
      if (!plans.sink) plans.sink = FALLBACK_PLANS.sink;
    }
    const pol = (await getDb().select<any>('platform_policies', { where: { key: eq('email.signup_daily_share_percent') }, select: ['value'], limit: 1 })) as any[];
    if (pol?.[0] && Number.isFinite(Number(pol[0].value))) sharePercent = Number(pol[0].value);
  } catch (err) {
    console.error('[email] provider plans unreadable, using the most conservative known limits', (err as Error)?.message || err);
  }
  planCache = { at: Date.now(), plans, sharePercent };
  return planCache;
}

/** Drop the memo (tests, and the proofs after editing a plan). */
export function clearEmailPlanCache(): void { planCache = null; }

async function rpc(name: string, body: Record<string, unknown>): Promise<any> {
  const { readSupabaseEnv, supabaseRestFetch } = await import('@/services/config/supabase-client');
  return supabaseRestFetch('/rpc/' + name, { key: readSupabaseEnv().serviceRoleKey, method: 'POST', body });
}

/**
 * Counts in Postgres. If the counter itself is unreachable, a sign-in code or
 * order email still goes (locking people out over our bookkeeping is worse),
 * but signup mail does not (it is the abusable kind).
 */
const capacity: CapacityStore = {
  async reserve(p) {
    try {
      const r = await rpc('email_reserve', { p_provider: p.provider, p_day: p.day, p_month: p.month, p_daily: p.dailyLimit, p_monthly: p.monthlyLimit, p_category: p.category, p_category_daily: p.categoryDailyLimit });
      const v = String(Array.isArray(r) ? r[0] : r).replace(/"/g, '');
      if (v === 'ok' || v === 'daily' || v === 'monthly' || v === 'category') return v;
      throw new Error('unexpected reserve result ' + v);
    } catch (err) {
      console.error('[email] capacity counter unreachable (' + p.provider + '/' + p.category + ')', (err as Error)?.message || err);
      return p.category === 'signup' ? 'category' : 'ok';
    }
  },
  async release(p) { await rpc('email_release', { p_provider: p.provider, p_day: p.day, p_month: p.month, p_category: p.category }); },
  async markFull(p) { await rpc('email_mark_full', { p_provider: p.provider, p_day: p.day }); },
  async usage(p) {
    const { getDb } = await import('@/lib/db/client');
    try {
      const rows = (await getDb().select<any>('email_send_counts', { where: { provider: eq(p.provider), period_key: inList([p.day, p.month]) }, select: ['period', 'period_key', 'category', 'sent'], limit: 20 })) as any[];
      const get = (period: string, key: string, cat: string) => Number(rows.find((r) => r.period === period && r.period_key === key && r.category === cat)?.sent ?? 0);
      return { day: get('day', p.day, 'all'), month: get('month', p.month, 'all'), category: get('day', p.day, p.category), full: get('day', p.day, '_full') > 0 };
    } catch {
      return { day: 0, month: 0, category: p.category === 'signup' ? Number.MAX_SAFE_INTEGER : 0, full: false };
    }
  },
};

async function storeInSink(m: EmailMessage): Promise<string | void> {
  const { getDb } = await import('@/lib/db/client');
  const rows = (await getDb().insert<any>('email_sink', {
    to_address: String(m.to || '').trim().toLowerCase(), from_address: m.from || null, reply_to: m.replyTo || null, subject: m.subject, html: m.html, text_body: m.text || null,
    category: m.meta?.category || 'standard', tenant_id: m.meta?.tenantId || null,
  }, { returning: 'representation' })) as any;
  // Keep a week: proofs read back minutes later, nothing needs more.
  if (Math.random() < 0.02) await getDb().remove('email_sink', { where: { created_at: lt(new Date(Date.now() - 7 * 86400_000).toISOString()) } }).catch(() => null);
  return Array.isArray(rows) ? rows[0]?.id : rows?.id;
}

async function recordSent(info: { provider: string; message: EmailMessage }): Promise<void> {
  try {
    const { recordUsage } = await import('@/lib/growth/ledger');
    const { DEFAULT_TENANT_ID } = await import('@/lib/tenant-context');
    const meta = info.message.meta || {};
    await recordUsage({
      tenantId: meta.tenantId || DEFAULT_TENANT_ID,
      moduleId: meta.moduleId || 'platform',
      unit: 'email',
      quantity: 1,
      provider: info.provider,
      reference: meta.reference || 'contact:' + String(info.message.to || '').trim().toLowerCase(),
    });
  } catch (err) {
    console.error('[email] send not recorded in the cost ledger', (err as Error)?.message || err);
  }
}

async function emailBinding(): Promise<SendEmailBinding | null> {
  try {
    const mod = (await import('@opennextjs/cloudflare')) as unknown as { getCloudflareContext?: () => { env?: Record<string, unknown> } | undefined };
    const b = mod.getCloudflareContext?.()?.env?.EMAIL as SendEmailBinding | undefined;
    return b && typeof b.send === 'function' ? b : null;
  } catch {
    return null;
  }
}

/** The configured (wizard or env) provider, ungoverned. */
async function configuredDriver(options: EmailDriverResolutionOptions, opts?: { force?: boolean }): Promise<EmailDriver | null> {
  const settings = await getPlatformSettings(opts);
  if (settings?.mail_provider && settings.mail_api_key) return createEmailDriver(settings.mail_provider, settings.mail_api_key, options);
  const envDrivers: Array<[MailProvider, string | undefined]> = [
    ['resend', process.env.RESEND_API_KEY],
    ['postmark', process.env.POSTMARK_API_KEY],
    ['sendgrid', process.env.SENDGRID_API_KEY],
  ];
  for (const [provider, key] of envDrivers) {
    if (key && String(key).trim()) return createEmailDriver(provider, String(key).trim(), options);
  }
  return null;
}

export class EmailFactory {
  /** The governed driver (cached settings and plans), or null when nothing can send. */
  static async getDriver(opts?: { force?: boolean }): Promise<GovernedEmailDriver | null> {
    const options: EmailDriverResolutionOptions = { brandName: getBrandName() || 'Store', from: resolveFromEnv() };
    const recordOnly = process.env.EMAIL_DRIVER === 'record';
    const { plans, sharePercent } = await readPlans();
    const chain: ProviderLink[] = [];
    if (!recordOnly) {
      if (plans.cloudflare) {
        const cf = new CloudflareEmailDriver(await emailBinding(), options.from, options.brandName);
        if (cf.configured) chain.push({ driver: cf, plan: plans.cloudflare });
      }
      const configured = await configuredDriver(options, opts);
      // A provider with no plan row has no limits we know of (postmark,
      // sendgrid): it is still tried, after the ones we do know.
      if (configured) chain.push({ driver: configured, plan: plans[configured.provider] || { provider: configured.provider, plan: 'unknown', dailyLimit: null, monthlyLimit: null, priority: 50 } });
      if (chain.length === 0) return null;
    }
    return new GovernedEmailDriver({
      chain,
      sink: new SinkDriver(storeInSink, options.from, options.brandName),
      sinkPlan: plans.sink || FALLBACK_PLANS.sink,
      capacity,
      signupSharePercent: sharePercent,
      recordOnly,
      sinkDomains: String(process.env.EMAIL_SINK_DOMAINS || '').split(','),
      onSent: recordSent,
      defaultFrom: options.from,
      brandName: options.brandName,
    });
  }
}

/** Is there room today for one more `category` email to `to` (takes nothing)? */
export async function emailRoomFor(category: EmailCategory, to: string): Promise<boolean> {
  const driver = await EmailFactory.getDriver().catch(() => null);
  return driver ? driver.hasRoom(category, to) : false;
}

/** The provider tried first for real mail right now (its monthly allowance is the one to watch). */
export async function primaryEmailProvider(): Promise<string | null> {
  const driver = await EmailFactory.getDriver().catch(() => null);
  return driver && driver.provider !== 'sink' ? driver.provider : null;
}
