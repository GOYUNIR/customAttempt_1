/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GROWTH MODULE REGISTRY.
 *
 * A module is a declarative entry plus a handler. Adding #16 through #40 should
 * be an entry here and a queue consumer — not a new subsystem — so the split is
 * deliberate:
 *
 *   IN CODE (this file)  the module's SHAPE: what it costs per unit, how its
 *                        impact is measured, what consent it needs. These are
 *                        properties of the handler, and a handler that changes
 *                        them is a different module.
 *   IN DATA (00027)      what it COSTS US (provider_rates), what we CHARGE
 *                        (plans), and per-tenant tuning (tenant_modules.config).
 *                        Packaging, rates and holdout size change without a
 *                        deploy, because those are the things a pivot touches.
 *
 * ZERO imports so this loads under `node --test` and in any runtime — the
 * registry is read by the send path, the cost ledger, the admin panel and the
 * sales quote calculator, and it must not drag a database client into any of
 * them.
 *
 * BUDGET CONSTRAINT, enforced here rather than remembered: a module whose
 * `channels` include anything other than email is marked `status: 'planned'`
 * and cannot be enabled. SMS costs ~$0.0118–0.0133 per segment plus a recurring
 * $15/month campaign fee, and LLM tokens scale with usage without a ceiling.
 * Neither ships until paying merchants cover them. `assertLaunchable` is what
 * makes that a rule instead of an intention.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type GrowthOutcome = 'earn_more' | 'lose_less' | 'save_time';
export type GrowthChannel = 'email' | 'sms' | 'onsite' | 'none';
export type ConsentChannel = 'email_marketing' | 'email_transactional' | 'sms_marketing';

/**
 * How a module's impact is established.
 *
 * `deterministic` is not a weaker form of `holdout` — it is the correct choice
 * where causation is already certain. A dunning retry either captures a
 * previously-failed charge or it does not; running a holdout there would mean
 * deliberately NOT retrying a percentage of real failed payments, costing the
 * merchant money to prove something already known. Withholding a recovery you
 * know works is not a control group, it is a loss.
 */
export type AttributionMode = 'holdout' | 'deterministic' | 'none';

export interface GrowthModuleCost {
  /** Must match a `provider_rates.unit`. The rate itself lives in data. */
  unit: string;
  /** Roughly how many units one "trigger" consumes, for forecasting only. */
  perTrigger: number;
}

export interface GrowthModule {
  id: string;
  name: string;
  /** In the merchant's words, not ours. */
  problem: string;
  outcome: GrowthOutcome;

  /** 'live' can be enabled; 'planned' cannot — see assertLaunchable. */
  status: 'live' | 'planned';

  channels: GrowthChannel[];

  metric: { id: string; unit: 'cents' | 'count' | 'ratio'; label: string };

  attribution: {
    mode: AttributionMode;
    /** Ignored when mode is not 'holdout'. */
    holdoutPercent: number;
    windowHours: number;
    touchRule: 'last_touch' | 'first_touch' | 'any_touch';
  };

  requires: {
    data: string[];
    consent: ConsentChannel[];
  };

  costs: GrowthModuleCost[];

  /** Defaults; a tenant may tighten them via tenant_modules. */
  caps: { perTenantPerDay: number };

  compliance: {
    /** Honour the recipient's local time; a send outside it must be deferred. */
    quietHours: boolean;
    /** Max sends per contact per rolling 7 days. */
    frequencyCap: number;
  };

  /** The queue consumer that implements it. */
  handler: string;
}

export const GROWTH_MODULES: GrowthModule[] = [
  {
    id: 'dunning',
    name: 'Failed payment recovery',
    problem: 'A card declines and the customer never finds out, so the money is simply gone.',
    outcome: 'lose_less',
    status: 'live',
    channels: ['email'],
    metric: { id: 'recovered_cents', unit: 'cents', label: 'Recovered revenue' },
    attribution: {
      // Deterministic on purpose — see the AttributionMode doc above.
      mode: 'deterministic',
      holdoutPercent: 0,
      windowHours: 336, // 14 days: a retry sequence runs longer than a campaign
      touchRule: 'last_touch',
    },
    requires: {
      data: ['orders', 'customers'],
      // A failed-payment notice is transactional: it concerns a purchase the
      // customer already made. It does not require marketing consent, and
      // gating it behind one would withhold a notice they need.
      consent: ['email_transactional'],
    },
    costs: [{ unit: 'email', perTrigger: 3 }],
    caps: { perTenantPerDay: 500 },
    compliance: { quietHours: false, frequencyCap: 4 },
    handler: 'dunning.retry',
  },
  {
    id: 'cart_recovery',
    name: 'Abandoned cart recovery',
    problem: 'Customers fill a cart and leave without buying.',
    outcome: 'earn_more',
    status: 'planned',
    channels: ['email'],
    metric: { id: 'recovered_cents', unit: 'cents', label: 'Recovered revenue' },
    attribution: { mode: 'holdout', holdoutPercent: 8, windowHours: 72, touchRule: 'last_touch' },
    requires: { data: ['carts', 'customers'], consent: ['email_marketing'] },
    // The number that breaks the budget: ~3 emails per abandoned cart, and a
    // merchant at 2,000 orders/month abandons enough to consume Resend's entire
    // 3,000/month free tier on their own.
    costs: [{ unit: 'email', perTrigger: 3 }],
    caps: { perTenantPerDay: 200 },
    compliance: { quietHours: true, frequencyCap: 3 },
    handler: 'cart.recovery',
  },
  {
    id: 'back_in_stock',
    name: 'Back-in-stock alerts',
    problem: 'People want something that is sold out and there is no way to tell them when it returns.',
    outcome: 'earn_more',
    status: 'planned',
    channels: ['email'],
    metric: { id: 'recovered_cents', unit: 'cents', label: 'Recovered demand' },
    attribution: { mode: 'holdout', holdoutPercent: 10, windowHours: 168, touchRule: 'last_touch' },
    requires: { data: ['alert_subscribers', 'inventory_levels'], consent: ['email_marketing'] },
    costs: [{ unit: 'email', perTrigger: 1 }],
    caps: { perTenantPerDay: 500 },
    compliance: { quietHours: true, frequencyCap: 2 },
    handler: 'stock.notify',
  },
  {
    id: 'speed_to_lead',
    name: 'Speed to lead',
    problem: 'A lead goes cold because nobody answered it for a day.',
    outcome: 'earn_more',
    status: 'planned',
    channels: ['email'],
    metric: { id: 'first_response_seconds', unit: 'count', label: 'Time to first response' },
    // Our own sales team is the first user. Response time is measured directly;
    // lead→close needs cohorts we do not have yet, so it is not claimed.
    attribution: { mode: 'none', holdoutPercent: 0, windowHours: 720, touchRule: 'first_touch' },
    requires: { data: ['leads'], consent: ['email_transactional'] },
    costs: [{ unit: 'email', perTrigger: 2 }],
    caps: { perTenantPerDay: 200 },
    compliance: { quietHours: false, frequencyCap: 6 },
    handler: 'lead.respond',
  },
];

export function moduleById(id: string): GrowthModule | null {
  return GROWTH_MODULES.find((m) => m.id === String(id || '')) || null;
}

export function liveModules(): GrowthModule[] {
  return GROWTH_MODULES.filter((m) => m.status === 'live');
}

/**
 * Why a module may not be enabled, or null when it may.
 *
 * This is the budget constraint expressed as code. At roughly $30/month of
 * fixed cost, a module that bills per SMS segment or per LLM token can outrun
 * the entire infrastructure budget from a single enthusiastic tenant, so those
 * channels are refused at the gate rather than watched afterwards.
 */
export function assertLaunchable(module: GrowthModule): string | null {
  if (module.status !== 'live') {
    return `"${module.name}" is not launched yet.`;
  }
  const expensive = module.channels.filter((c) => c === 'sms');
  if (expensive.length > 0) {
    return `"${module.name}" uses ${expensive.join(', ')}, which is not enabled on this plan: SMS costs roughly $0.0118-0.0133 per segment plus a recurring $15/month campaign fee, and is held until paying merchants cover it.`;
  }
  if (module.costs.some((c) => c.unit.startsWith('llm_'))) {
    return `"${module.name}" consumes LLM tokens, whose cost scales with usage without a natural ceiling. Held until paying merchants cover it.`;
  }
  return null;
}

/**
 * Forecast the units one module consumes at a given trigger volume.
 * Used by the free-tier headroom check and the sales quote calculator, so both
 * read the same numbers rather than keeping their own copies.
 */
export function forecastUnits(module: GrowthModule, triggersPerMonth: number): Record<string, number> {
  const out: Record<string, number> = {};
  const triggers = Math.max(0, Math.floor(triggersPerMonth));
  for (const cost of module.costs) {
    out[cost.unit] = (out[cost.unit] || 0) + triggers * cost.perTrigger;
  }
  return out;
}
