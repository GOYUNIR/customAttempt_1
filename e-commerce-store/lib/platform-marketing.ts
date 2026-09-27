import { graduatedSchedule, type FeePlan } from './pricing/graduated-fee.ts';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE MARKETING SITE SAYS.
 *
 * Content and prices live here as data, not inside JSX, for the same reason
 * plans live in the database: packaging and positioning change far more often
 * than layout does, and a copy edit should never be a component edit.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 * 1. LEAD WITH THE OUTCOME, PROVE WITH THE MECHANISM. The first draft of this
 *    page said "compare-and-swap" and "append-only audit trail" — true, and
 *    meaningless to the person deciding whether to buy. Every capability below
 *    is therefore a pair: `outcome` is what a shop owner gets, in their words;
 *    `proof` is the mechanism, kept because it is what makes the claim
 *    credible to the technical person they will ask. Neither works alone —
 *    outcome without proof is marketing noise, proof without outcome is a
 *    spec sheet.
 *
 * 2. NO NUMBER HERE MAY BE A PROMISE ABOUT SOMEBODY'S RESULTS. Published
 *    cart-recovery and dunning percentages are vendor marketing with heavy
 *    selection bias, and quoting them as what a prospect will earn is the
 *    thing this platform's whole attribution model exists to refuse. Claims
 *    here describe what the SOFTWARE does. Revenue claims belong in the
 *    merchant's own dashboard, measured against their own holdout.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type Capability = {
  /** What they get, in their language. Leads. */
  outcome: string;
  /** How it works. Follows, and earns the claim. */
  proof: string;
};

export const CAPABILITIES: Capability[] = [
  {
    outcome: 'Two people can never buy the last one',
    proof:
      'A unit is held for a shopper from the moment they reach checkout, so two checkouts can never both take the last one. Every change to stock is recorded, and a count you enter never erases a sale in flight.',
  },
  {
    outcome: 'Run drops, waitlists and ordinary shopping from one catalog',
    proof:
      'Each product picks its own checkout mode — instant buy, a timed release with a fair draw, a waitlist, or a B2B quote. One system, not four plugins that disagree with each other.',
  },
  {
    outcome: 'Know who a customer is, not just what they bought',
    proof:
      'One durable record per person across every entry and order, with their history. Not a blob keyed to an internal id that nothing else can read.',
  },
  {
    outcome: 'Give staff their own logins, and see who did what',
    proof:
      'Invite people by email with a role, from platform admin down to sales rep. Two-step verification on every account, and an activity log the database itself refuses to edit or delete.',
  },
  {
    outcome: 'Your own store address and your own sign-ins',
    proof:
      'Every store gets its own address, with separate sign-ins for you, your staff and our support — instead of one shared admin password everybody passes around. Your own custom domain is coming.',
  },
  {
    outcome: 'Leave whenever you want, and take everything with you',
    proof:
      'Your payments run in your own Stripe account, and your data lives in standard Postgres. Ask and we export all of it for you; self-serve export is coming. Nothing here is designed to make leaving hard.',
  },
];

export type ComparisonRow = {
  /** The question a merchant is actually weighing. */
  question: string;
  /** What the tools they use today typically do. Factual, not a caricature. */
  today: string;
  /** What this platform does. */
  here: string;
};

/**
 * The comparison is written against CATEGORIES of tooling, never a named
 * competitor's current feature list. A named comparison goes stale the week
 * they ship something, and an inaccurate one is worse than none — the first
 * prospect who spots it stops believing the rest of the page.
 */
export const COMPARISON: ComparisonRow[] = [
  {
    question: 'Running a timed release or a fair draw',
    today: 'An app from a marketplace, bolted on, with its own idea of your inventory',
    here: 'Built in, sharing the same stock and the same customer record as everything else',
  },
  {
    question: 'Knowing what your marketing actually earned',
    today: 'Gross attributed revenue — every sale that touched a campaign, including the ones you would have made anyway',
    here: 'Measured against a held-back control group, so the figure is what the campaign ADDED (coming to merchant stores)',
  },
  {
    question: 'Selling to trade buyers',
    today: 'A separate wholesale plan, or a spreadsheet and a lot of email',
    here: 'Quotes, net terms, contract pricing and approvals in the same catalog as retail (coming to merchant stores)',
  },
  {
    question: 'Getting your data out',
    today: 'A CSV export, and an API you pay for',
    here: 'Your own Stripe account; standard Postgres, exported for you on request (self-serve export coming)',
  },
];

export type Plan = {
  id: string;
  name: string;
  /** Null means "talk to us" rather than a number we would have to invent. */
  monthlyUsd: number | null;
  tagline: string;
  points: string[];
  featured?: boolean;
  /**
   * The line under the price. Free-to-start is the answer to "you are new, why
   * would I risk it", so the terms of the risk-removal are data: the sentence
   * that removes the objection changes far more often than the layout does.
   */
  priceNote?: string;
  /** Days of full access before the first charge. 0/undefined means none. */
  trialDays?: number;
  /**
   * What the button says. Here rather than in app/platform/page.tsx because
   * "Start free" and "Talk to us" are different promises, and which promise a
   * tier makes is a pricing decision, not a layout one.
   */
  ctaLabel?: string;
  /**
   * The honest ceiling on a free plan, in the merchant's own terms.
   *
   * A free tier with no stated limit is either a lie or a bill we cannot pay.
   * Ours is bounded by the thing that actually costs us money per tenant —
   * transactional email (see lib/growth/ledger.ts: one shared provider
   * allowance across every tenant on the platform), not storage or pageviews.
   */
  limitNote?: string;
  /**
   * Platform fee on each sale, in basis points (200 = 2%), collected through
   * Stripe Connect. Decided by the owner 2026-09-24: Free 2%, $29 0.5%,
   * $99 0%. Undefined = negotiated (Scale). These rates, together with the
   * monthly prices above, are the ONLY inputs to the graduated fee
   * (lib/pricing/graduated-fee.ts): its breakpoints are derived from them, so
   * changing a price here moves the breakpoints, with nothing to keep in sync.
   */
  platformFeeBps?: number;
  /**
   * false = a band of the fee schedule, not a plan to choose (D2: with the
   * graduated fee, Starter is never the cheaper choice, so the page shows
   * Free · Growth · Scale). It stays in PLANS because the fee engine derives
   * its breakpoints from every priced plan.
   */
  listed?: boolean;
  /** The button opens a conversation (mailto) instead of the signup form:
   *  the plan cannot be bought self-serve yet. */
  contactOnly?: boolean;
};

/**
 * PRICING, as decided 2026-09-24 (STRATEGY.md §5, PRICING.md).
 *
 * Two things are charged, and they are different claims:
 *   - a PLATFORM FEE on each sale — a plain percentage of the transaction,
 *     graduated so a month never costs more than the cheapest plan would have
 *     for the volume actually done (PRICING.md);
 *   - NOT a share of revenue our growth tools claim to have generated. That is
 *     the attribution-honesty promise (holdout-measured incremental impact),
 *     and it stays: we never bill on a gross-attributed number.
 * The pricing page must keep those two statements visibly separate —
 * DEFERRED-9 exists because the current copy blurs them.
 *
 * The real plan rows belong in `public.plans` (migration 00027) so packaging
 * can change without a deploy; those rows carry no fee column yet (PRICING.md
 * has the migration). Until they do, this is both the shop window and the
 * only place the rates live.
 */
export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    monthlyUsd: 0,
    platformFeeBps: 200,
    tagline: 'Open a real store and sell. No card, no clock.',
    // The per-sale fee is stated on the card itself (feeSummary(), from this
    // data), never left for a merchant to find in their Stripe payouts. The
    // old "Up to 50 orders a month" note is gone: owner decision D1 dropped
    // the cap, and it was never enforced anyway.
    priceNote: 'No monthly fee. A small fee on each sale instead (below).',
    ctaLabel: 'Start free',
    points: [
      'A real storefront',
      'Oversell protection from the first sale',
      'Your own Stripe account — the money is yours',
      'The per-sale fee stops growing at the price of Growth',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    monthlyUsd: 29,
    platformFeeBps: 50,
    listed: false,
    trialDays: 14,
    priceNote: '14 days free. Cancel before the first charge and pay nothing.',
    ctaLabel: 'Start free trial',
    tagline: 'One store, everything that stops you losing sales.',
    points: [
      'Unlimited products and drops',
      'Oversell protection and shared stock pools',
      'Failed-payment recovery',
      'Your own domain',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    monthlyUsd: 99,
    platformFeeBps: 0,
    featured: true,
    // No trial and no self-serve upgrade until plan billing exists (it does
    // not yet): the button opens a conversation instead of promising one.
    contactOnly: true,
    priceNote: 'A flat monthly price and no per-sale fee.',
    ctaLabel: 'Talk to us',
    tagline: 'For stores selling enough that a flat price beats the per-sale fee.',
    points: [
      'Everything in Free, with no per-sale fee',
      'Abandoned cart and back-in-stock recovery (coming)',
      'Impact measured against a control group (coming)',
      'B2B quotes and net terms (coming)',
    ],
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyUsd: null,
    ctaLabel: 'Talk to us',
    tagline: 'Multiple stores, or volume that needs its own conversation.',
    points: [
      'Everything in Growth',
      'Multiple storefronts (by arrangement)',
      'Priority support and onboarding',
      'Custom contract and invoicing',
    ],
  },
];

/**
 * The per-sale fee in plain words, DERIVED from PLANS through the fee engine
 * (lib/pricing/graduated-fee.ts), so the page can never drift from what is
 * actually charged. DEFERRED-9: the page used to imply there was no
 * percentage fee at all.
 */
export function feeSummary(): { freeLine: string; footnote: string } {
  const plans: FeePlan[] = PLANS
    .filter((p) => p.monthlyUsd !== null && p.platformFeeBps !== undefined)
    .map((p) => ({ id: p.id, monthlyCents: Math.round((p.monthlyUsd as number) * 100), feeBps: p.platformFeeBps as number }));
  const tiers = graduatedSchedule(plans);
  const pct = (bps: number) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1) + '%';
  const usd = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const capPlan = PLANS.filter((p) => p.monthlyUsd !== null && p.platformFeeBps === 0).sort((a, b) => (a.monthlyUsd as number) - (b.monthlyUsd as number))[0];
  const paid = tiers.filter((t) => t.bps > 0);
  const bands = paid.map((t, i) => (i === 0 ? pct(t.bps) + ' of your sales each month' : 'then ' + pct(t.bps) + ' above ' + usd(t.fromCents)));
  const cap = capPlan ? ', and never more than ' + usd((capPlan.monthlyUsd as number) * 100) + ' a month in total — the price of ' + capPlan.name : '';
  const freeLine = 'Per-sale fee: ' + bands.join(', ') + cap + '.';
  const footnote =
    'Free has no monthly price: we take a small fee from each sale instead, collected by Stripe when the sale happens — ' +
    bands.join(', ') + cap + '. ' +
    (capPlan ? capPlan.name + ' is a flat ' + usd((capPlan.monthlyUsd as number) * 100) + ' a month with no per-sale fee. ' : '') +
    'Separately, and always: we never charge a share of the revenue our own marketing tools claim to have generated.';
  return { freeLine, footnote };
}

export type Faq = { q: string; a: string };

/**
 * Written to answer the objection, including where the honest answer is
 * inconvenient. A FAQ that only asks flattering questions reads as marketing;
 * one that says "we are new" is the reason the rest gets believed.
 */
export const FAQS: Faq[] = [
  {
    q: 'How is this different from the big platforms?',
    a: 'Most of them are excellent at ordinary retail and awkward at everything else — timed releases, draws, waitlists and trade orders end up as bolt-on apps that each keep their own copy of your inventory. Here those are first-class checkout modes sharing one catalog, one stock level and one customer record.',
  },
  {
    q: 'Why do your revenue numbers look smaller than my current tool’s?',
    a: 'Because they measure something different. Most tools report every sale that touched a campaign, including customers who would have bought anyway. We hold back a small control group and report the difference — what the campaign actually added. It is a smaller number and a true one. (Reporting is live for our own store and coming to merchant dashboards.)',
  },
  {
    q: 'Can I use my own payment processor?',
    a: 'Payments run through your own Stripe account, so the money goes directly to you and the relationship is yours. Card details are never stored by us.',
  },
  {
    q: 'What happens to my data if I leave?',
    a: 'You export it. Products, orders, customers and content are stored in standard Postgres and can be extracted in full at any time. We would rather earn the renewal than rely on it being painful to go.',
  },
  {
    q: 'How new is this?',
    a: 'New. It is built and running, and it is not a decade-old platform with a marketplace of ten thousand apps. If you need a large ecosystem of third-party add-ons today, one of the incumbents is the better answer, and we would rather tell you that now.',
  },
  {
    q: 'Do I need a developer?',
    a: 'Not to launch. Your store comes with a storefront, product pages and checkout, and the merchant dashboard handles products, raffles, stock, orders, staff and policies. A developer helps if you want something bespoke.',
  },
];
