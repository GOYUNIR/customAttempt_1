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
      'Stock is decremented with a compare-and-swap, so simultaneous checkouts cannot both take the final unit. Oversells are refused by the database, not patched up by support afterwards.',
  },
  {
    outcome: 'Run drops, waitlists and ordinary shopping from one catalog',
    proof:
      'Each product picks its own checkout mode — instant buy, a timed release with a fair draw, a waitlist, or a B2B quote. One system, not four plugins that disagree with each other.',
  },
  {
    outcome: 'Know who a customer is, not just what they bought',
    proof:
      'One durable record per person across every drop, order and subscription, carrying their loyalty balance, marketing consent and history. Not a blob keyed to an internal id that nothing else can read.',
  },
  {
    outcome: 'Give staff their own logins, and see who did what',
    proof:
      'Invite people by email with a role, from platform admin down to sales rep. Two-step verification on every account, and an activity log the database itself refuses to edit or delete.',
  },
  {
    outcome: 'Sell on your own domain, not a slug of ours',
    proof:
      'Every store runs on its own domain or subdomain, with separate sign-ins for staff, merchants and sales — instead of one shared admin password everybody passes around.',
  },
  {
    outcome: 'Leave whenever you want, and take everything with you',
    proof:
      'Your data lives in standard Postgres, your media in standard object storage, your payments in your own Stripe account. Export it all at any time. Nothing here is designed to make leaving hard.',
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
    here: 'Measured against a held-back control group, so the figure is what the campaign ADDED',
  },
  {
    question: 'Selling to trade buyers',
    today: 'A separate wholesale plan, or a spreadsheet and a lot of email',
    here: 'Quotes, net terms, contract pricing and approvals in the same catalog as retail',
  },
  {
    question: 'Getting your data out',
    today: 'A CSV export, and an API you pay for',
    here: 'Standard Postgres, your own Stripe account, your own object storage',
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
};

/**
 * PRICES ARE A STARTING PROPOSAL, and deliberately simple.
 *
 * They are flat and per-month because performance pricing — a share of proven
 * incremental revenue — is only defensible once we have measured our own
 * cohorts. Charging a percentage of a number we cannot yet stand behind would
 * undercut the one thing that differentiates the attribution model.
 *
 * The real plan rows live in `public.plans` (migration 00027) so packaging can
 * change without a deploy. What is here is the shop window; that table is the
 * contract.
 */
export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    monthlyUsd: 0,
    tagline: 'Open a real store and sell. No card, no clock.',
    priceNote: 'Free while you are finding your first customers.',
    ctaLabel: 'Start free',
    // The ceiling is stated in orders because that is the unit a merchant
    // thinks in. It maps to our real constraint — every order sends
    // transactional mail out of one shared provider allowance.
    limitNote: 'Up to 50 orders a month. Everything else is the same product.',
    points: [
      'A real storefront on your own domain',
      'Oversell protection from the first sale',
      'Your own Stripe account — the money is yours',
      'Move to a paid plan only when the limit starts costing you sales',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    monthlyUsd: 29,
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
    featured: true,
    trialDays: 14,
    priceNote: '14 days free. Cancel before the first charge and pay nothing.',
    ctaLabel: 'Start free trial',
    tagline: 'For stores where the growth modules pay for themselves.',
    points: [
      'Everything in Starter',
      'Abandoned cart and back-in-stock recovery',
      'Impact measured against a control group',
      'Staff accounts with roles and audit history',
      'B2B quotes and net terms',
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
      'Multiple storefronts on one account',
      'Priority support and onboarding',
      'Custom contract and invoicing',
    ],
  },
];

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
    a: 'Because they measure something different. Most tools report every sale that touched a campaign, including customers who would have bought anyway. We hold back a small control group and report the difference — what the campaign actually added. It is a smaller number and a true one, and you can read the method in your dashboard.',
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
    a: 'Not to launch. Starter templates cover the storefront, product pages and catalog for each way of selling, and the merchant panel handles day-to-day changes. A developer helps if you want something bespoke.',
  },
];
