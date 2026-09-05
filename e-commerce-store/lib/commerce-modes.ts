/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSAL COMMERCE PRIMITIVES — 10 sellable "modes".
 *
 * The storefront's historical model only understood two retail motions:
 * INSTANT_BUY (FCFS) and ALLOCATION_DRAW (raffle). This module generalises that
 * into 10 universal commerce modes, each described by THREE flexible JSON
 * blocks — `accessRule` (who may buy), `billingRule` (how/when money moves) and
 * `scheduleConfig` (when it is open / how it recurs).
 *
 * The three blocks are DELIBERATELY loose: they type the well-known fields but
 * also accept arbitrary extension keys (index signature) so a new vertical can
 * add fields without a schema rewrite.
 *
 * DESIGN — this file has ZERO imports so the `node --test` runner loads it with
 * a plain `import … from '../lib/commerce-modes.ts'`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type CommerceMode =
  | 'INSTANT_BUY'
  | 'ALLOCATION_DRAW'
  | 'TIME_SLOT'
  | 'PREORDER'
  | 'SUBSCRIPTION'
  | 'GATED_ACCESS'
  | 'GROUP_BUY'
  | 'DUTCH_AUCTION'
  | 'PAY_WHAT_YOU_WANT'
  | 'RFQ_QUOTE';

export const COMMERCE_MODES: readonly CommerceMode[] = [
  'INSTANT_BUY',
  'ALLOCATION_DRAW',
  'TIME_SLOT',
  'PREORDER',
  'SUBSCRIPTION',
  'GATED_ACCESS',
  'GROUP_BUY',
  'DUTCH_AUCTION',
  'PAY_WHAT_YOU_WANT',
  'RFQ_QUOTE',
];

/** Behavioural capabilities a commerce mode may declare (drives UI + engine). */
export type CommerceCapability =
  | 'instant_checkout'
  | 'raffle_draw'
  | 'schedule'
  | 'booking'
  | 'recurring'
  | 'inventory'
  | 'gated'
  | 'group'
  | 'auction'
  | 'pay_what_you_want'
  | 'quote'
  | 'preorder';

export type CommerceBlock = 'accessRule' | 'billingRule' | 'scheduleConfig';

/** Canonical description of one commerce mode. */
export interface CommerceModeMeta {
  id: CommerceMode;
  label: string;
  description: string;
  capabilities: CommerceCapability[];
  /** Which of the three JSON blocks this mode uses. */
  blocks: CommerceBlock[];
}

/**
 * `accessRule` — who may access / purchase this item. Flexible: the known
 * fields cover the common gating models; extra keys are preserved verbatim.
 */
export interface AccessRule {
  gatedBy?: 'none' | 'account' | 'password' | 'email_list' | 'membership';
  requiresAuth?: boolean;
  allowedEmails?: string[];
  allowedRoles?: string[];
  accessCode?: string;
  /** GROUP_BUY — minimum participants before the buy unlocks. */
  groupMinParticipants?: number;
  [key: string]: unknown;
}

/**
 * `billingRule` — how and when money moves. Flexible: covers immediate charge,
 * deposit, recurring, auction and quote pricing; extra keys preserved verbatim.
 */
export interface BillingRule {
  mode?: 'immediate' | 'on_win' | 'on_fulfillment' | 'recurring' | 'deposit' | 'quote' | 'pay_what_you_want' | 'auction';
  priceCents?: number;
  depositCents?: number;
  /** PAY_WHAT_YOU_WANT / DUTCH_AUCTION floor. */
  minPriceCents?: number;
  /** PAY_WHAT_YOU_WANT suggested anchor. */
  suggestedPriceCents?: number;
  /** DUTCH_AUCTION step between price drops. */
  auctionStepCents?: number;
  /** SUBSCRIPTION cadence. */
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  trialDays?: number;
  currency?: string;
  [key: string]: unknown;
}

/**
 * `scheduleConfig` — when the mode is open and how it recurs. Flexible.
 */
export interface ScheduleConfig {
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  /** TIME_SLOT slot length / buffer. */
  durationMinutes?: number;
  bufferMinutes?: number;
  slotsPerWindow?: number;
  daysOfWeek?: number[];
  recurring?: { mode?: string; intervalHours?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** A product/variant's full commerce configuration (the three blocks + mode). */
export interface CommerceConfig {
  commerceMode: CommerceMode | '';
  accessRule: Record<string, unknown>;
  billingRule: Record<string, unknown>;
  scheduleConfig: Record<string, unknown>;
}

/** The registry — the single source of truth for commerce-mode behaviour. */
export const COMMERCE_MODE_META: Record<CommerceMode, CommerceModeMeta> = {
  INSTANT_BUY: {
    id: 'INSTANT_BUY',
    label: 'Instant Buy',
    description: 'First-come, first-served — charge at checkout.',
    capabilities: ['instant_checkout', 'inventory'],
    blocks: ['billingRule'],
  },
  ALLOCATION_DRAW: {
    id: 'ALLOCATION_DRAW',
    label: 'Allocation Draw',
    description: 'Enter an allocation pool; winners are drawn and charged.',
    capabilities: ['raffle_draw', 'inventory'],
    blocks: ['billingRule', 'scheduleConfig'],
  },
  TIME_SLOT: {
    id: 'TIME_SLOT',
    label: 'Time Slot',
    description: 'Reserve a specific time slot (services, appointments).',
    capabilities: ['schedule', 'booking'],
    blocks: ['scheduleConfig', 'billingRule'],
  },
  PREORDER: {
    id: 'PREORDER',
    label: 'Preorder',
    description: 'Sell before fulfilment — charge now or on ship.',
    capabilities: ['preorder', 'inventory'],
    blocks: ['billingRule', 'scheduleConfig'],
  },
  SUBSCRIPTION: {
    id: 'SUBSCRIPTION',
    label: 'Subscription',
    description: 'Recurring billing on a cycle.',
    capabilities: ['recurring'],
    blocks: ['billingRule', 'accessRule'],
  },
  GATED_ACCESS: {
    id: 'GATED_ACCESS',
    label: 'Gated Access',
    description: 'Restricted purchase — account, password or list.',
    capabilities: ['gated', 'inventory'],
    blocks: ['accessRule', 'billingRule'],
  },
  GROUP_BUY: {
    id: 'GROUP_BUY',
    label: 'Group Buy',
    description: 'Unlocks at a participant threshold.',
    capabilities: ['group', 'inventory'],
    blocks: ['accessRule', 'billingRule'],
  },
  DUTCH_AUCTION: {
    id: 'DUTCH_AUCTION',
    label: 'Dutch Auction',
    description: 'Price descends until a buyer accepts.',
    capabilities: ['auction', 'inventory'],
    blocks: ['billingRule', 'scheduleConfig'],
  },
  PAY_WHAT_YOU_WANT: {
    id: 'PAY_WHAT_YOU_WANT',
    label: 'Pay What You Want',
    description: 'Customer sets the price above a floor.',
    capabilities: ['pay_what_you_want'],
    blocks: ['billingRule'],
  },
  RFQ_QUOTE: {
    id: 'RFQ_QUOTE',
    label: 'RFQ / Quote',
    description: 'Request-for-quote with manual pricing.',
    capabilities: ['quote'],
    blocks: ['billingRule', 'accessRule'],
  },
};

/** Coerce an untrusted value into a valid CommerceMode, or null. */
export function sanitizeCommerceMode(value: unknown): CommerceMode | null {
  const v = String(value ?? '')
    .trim()
    // camelCase → snake_case (e.g. "GroupBuy" → "Group_Buy")
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // any non-alphanumeric separator (space, hyphen, dot, …) → underscore
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .toUpperCase()
    // collapse underscore runs and strip leading/trailing underscores
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (COMMERCE_MODES as readonly string[]).includes(v) ? (v as CommerceMode) : null;
}

/** Human label for a commerce mode (empty/unknown → ''). */
export function commerceModeLabel(value: unknown): string {
  const mode = sanitizeCommerceMode(value);
  return mode ? COMMERCE_MODE_META[mode].label : '';
}

/** Registry metadata for a mode (null for empty/unknown). */
export function commerceModeMeta(value: unknown): CommerceModeMeta | null {
  const mode = sanitizeCommerceMode(value);
  return mode ? COMMERCE_MODE_META[mode] : null;
}

/** Whether a mode exposes a given capability (false for unknown/empty). */
export function commerceModeHasCapability(value: unknown, capability: CommerceCapability): boolean {
  const meta = commerceModeMeta(value);
  return meta ? meta.capabilities.includes(capability) : false;
}

/** Coerce an untrusted value into a plain JSON object (never null/array). */
export function normalizeJsonBlock(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function normalizeAccessRule(value: unknown): Record<string, unknown> {
  return normalizeJsonBlock(value);
}

export function normalizeBillingRule(value: unknown): Record<string, unknown> {
  return normalizeJsonBlock(value);
}

export function normalizeScheduleConfig(value: unknown): Record<string, unknown> {
  return normalizeJsonBlock(value);
}

/**
 * Normalize a full commerce configuration into the canonical shape
 * `{ commerceMode, accessRule, billingRule, scheduleConfig }`. The mode is
 * sanitized (unknown/empty → ''), and every block is coerced to a plain object.
 */
export function normalizeCommerceConfig(value: unknown): CommerceConfig {
  const raw = normalizeJsonBlock(value);
  return {
    commerceMode: sanitizeCommerceMode(raw.commerceMode) ?? '',
    accessRule: normalizeJsonBlock(raw.accessRule),
    billingRule: normalizeJsonBlock(raw.billingRule),
    scheduleConfig: normalizeJsonBlock(raw.scheduleConfig),
  };
}

export interface CommerceConfigValidation {
  ok: boolean;
  errors: string[];
  config: CommerceConfig;
}

/** Light validation: mode must be known (or empty), blocks must be objects. */
export function validateCommerceConfig(value: unknown): CommerceConfigValidation {
  const errors: string[] = [];
  const raw = normalizeJsonBlock(value);

  const rawMode = String(raw.commerceMode ?? '').trim();
  if (rawMode !== '' && !sanitizeCommerceMode(rawMode)) {
    errors.push(`Unknown commerce mode "${rawMode}".`);
  }
  for (const block of ['accessRule', 'billingRule', 'scheduleConfig'] as const) {
    const v = raw[block];
    if (v !== undefined && (v === null || typeof v !== 'object' || Array.isArray(v))) {
      errors.push(`"${block}" must be a JSON object.`);
    }
  }

  return { ok: errors.length === 0, errors, config: normalizeCommerceConfig(value) };
}

/**
 * Map the legacy checkout mode to a commerce mode. RAFFLE → ALLOCATION_DRAW,
 * FCFS → INSTANT_BUY. This keeps the existing two-mode storefront readable
 * through the universal lens without a data migration.
 */
export function commerceModeFromCheckoutMode(checkoutMode: unknown): CommerceMode {
  return String(checkoutMode || '').toUpperCase() === 'FCFS' ? 'INSTANT_BUY' : 'ALLOCATION_DRAW';
}

/**
 * Inverse mapping. INSTANT_BUY → FCFS, ALLOCATION_DRAW → RAFFLE, everything
 * else → null (no direct retail checkout-mode equivalent).
 */
export function checkoutModeFromCommerceMode(mode: unknown): 'RAFFLE' | 'FCFS' | null {
  const resolved = sanitizeCommerceMode(mode);
  if (resolved === 'INSTANT_BUY') return 'FCFS';
  if (resolved === 'ALLOCATION_DRAW') return 'RAFFLE';
  return null;
}
