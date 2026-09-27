# STRATEGY — what this platform is for, and how to decide

The business context behind every technical decision in this repo. ARCHITECTURE.md
records *how* things are built and what went wrong; this records *why*, and what
"right" means. Stated by the owner on 2026-09-24. When a decision is unclear,
check it against this document before choosing. If this document is wrong or
stale, say so and ask. Do not work around it quietly.

---

## 1. The goal

Build a commerce platform that beats Shopify, Adobe Commerce/Magento, Salesforce
Commerce Cloud, BigCommerce, SAP Commerce Cloud, Oracle CX Commerce, WooCommerce,
Wix, Squarespace, commercetools, Shopware, VTEX, Sana Commerce, OroCommerce,
Spryker and Elastic Path.

The full platform, all of it multi-tenant: storefront, merchant app panel,
internal admin panel, sales portal, lead-intelligence layer.

**Target: meaningful real revenue by end of 2027.** That means real paying
customers getting real results. A technically impressive build with no
customers is a failure against this goal, however good the code is.

## 2. The wedge, not the whole market

The edge is **unified drop / raffle / FCFS / B2B commerce on one catalog, one
stock count and one customer record**. Nobody serves that well at $29–99/month.

Going broad against Shopify's decade of app ecosystem loses. Going narrow on
**"brands that sell in drops, not just carts"** wins, and the platform expands
from there.

**The test for every feature:** does this serve the wedge, or is it premature
breadth? If it is breadth, it waits unless the owner asks for it.

## 3. GOYUNIR is a placeholder brand

This platform will later power a second, different business. Never hardcode an
assumption that GOYUNIR is permanent: not the brand name, the domain, the copy
or the visual identity. These are always config or data. A rebrand must be a
data change, never a refactor.

## 4. How to think about decisions

Think like a large, disciplined company, not a startup cutting corners, and
apply that rigor where it matters.

**Money path and infrastructure get the rigor of a company that would be sued,
or lose massive trust, for getting it wrong:**
- Real **reservation holds** on inventory, not check-then-decrement.
- Atomic operations: correct by construction, not "correct unless two requests
  race".
- **No silent failures.** A failure on the money path is logged loudly and
  reported to the caller. It is never swallowed, and never a `.catch(() => null)`
  that skips work without a word.
- No "probably fine". If it isn't proven, say it isn't proven.

**Everything else moves at startup speed:** don't gold-plate UI, don't build
features nobody asked for yet, and don't let perfect block shipped on cosmetic
work.

**Use the known solution shape when a large company has solved the problem.**
Inventory reservation holds (Amazon/Shopify), Stripe Connect for multi-tenant
payments, holdout-based attribution for honest marketing numbers. Don't reinvent
solved problems. Differentiate on the parts nobody does well: the wedge in §2
and the honesty in §5.

### Business type is data, never code (owner, 2026-09-27; standing constraint)

Read this before any commerce-mode or industry-specific work.

- **No code path knows a business type, industry or legal entity.** The
  platform is generic, composable primitives: products, variants, checkout
  modes, inventory, pricing and customer records. Every business type
  configures those. Nothing branches on "farmer", "perfume brand" or "LLC".
- **Legal entity type is Stripe's concern.** LLC, sole proprietor, nonprofit
  and so on are collected and verified by Stripe Connect during KYC. The
  platform passes that through and never builds logic on it.
- **Industry is data.** Starter templates, catalog presets and example copy
  are chosen by, or suggested to, the merchant. A "bookings" business and a
  "drops" business run on the same checkout-mode infrastructure, configured
  differently.
- **AI's role is narrow and bounded.** It helps a merchant reach a sensible
  starting configuration and copy during onboarding (for example, "you sell
  candles; here is a suggested catalog structure"). It never runs business
  logic. It is optional, cost-capped and metered, on the same pattern as
  ImageProvider, and never load-bearing.
- **The test before building anything new here:** is this a genuinely new
  configuration primitive, or a preset or template on top of what exists?
  Always prefer the preset.

## 5. Business model

| Plan | Monthly | Platform fee | Notes |
|---|---|---|---|
| Free | $0 | 2%, graduated | Removes "pay before you've made money". The rate falls to 0.5% and then 0% as the month grows, and a month never costs more than $99 (PRICING.md). No order cap (D1). A 1,000-orders-a-month abuse review alerts a human and never blocks a sale by itself. |
| Starter | $29 | 0.5% | **Not sold** (D2). Its rate is the middle band of Free's graduated schedule. |
| Growth | $99 | 0% | Growth modules included. |
| Scale | custom | custom | |

- **Pricing is data, not code.** Plans, fees (the tier-to-basis-points mapping),
  limits and copy live in `lib/platform-marketing.ts`; the graduated mechanism
  is designed in `PRICING.md`.
- **Graduated pricing (in progress).** As a free-tier merchant's volume grows,
  their effective percentage should move smoothly toward flat pricing. Show it
  to them as an approaching milestone, not a sales push. It should feel
  premium: the kind of thing a merchant screenshots.
- **The platform fee is a real revenue line**, collected through Stripe Connect
  (in progress). Connect is not just friction removal. It is also what makes
  multi-merchant legal, which is why no new merchant is onboarded until it
  ships.
- **Growth modules report proven incremental impact only**, measured against
  holdout groups (dunning, cart recovery, back-in-stock, reviews, loyalty,
  B2B). Never report gross attributed numbers. The smaller, honest number is a
  deliberate differentiator against every competitor's inflated attribution.
  **Never compromise this**, even when it makes the product look less
  impressive.

## 6. B2B targeting

Prioritize customers that are financially stable and hard to displace:
distributors; industrial, medical and food-service supply; companies that buy
the same things every month regardless of the economy. Prefer them over small
businesses likely to churn or negotiate hard.

The B2B schema (quotes, price lists, net terms, approval workflows) is a genuine
moat. Treat it as **core**, not a side feature.

## 7. Future roadmap — know it, don't build it

**Do not build any of this until explicitly asked.** Do make sure today's
architecture doesn't rule it out.

- **8+ commerce and order types** beyond raffle, FCFS and B2B: bookings and
  appointments, pre-orders, subscriptions, auctions, group buys. Each needs its
  own example copy, not one product reused across every showcase. Commerce
  modes must stay data-driven so a new one isn't a schema rewrite.
- **AI product imagery** (background removal and lifestyle scenes) as a metered
  add-on, with hard per-tenant cost caps. There is no live provider yet: the
  abstraction and caps come first, and nothing is spent until a provider is
  deliberately wired.
- **i18n, Spanish first**, once English has real traction. Every new
  user-facing string goes through a `t()` wrapper now, so this isn't a full
  retrofit later.
- **Speed-to-lead automation**: first for our own sales team, then as a
  sellable module.
- **Call automation and similar**: use an off-the-shelf tool (Bland, Vapi, etc.)
  for our own operations now. Build it into the product only once there is real
  demand.

## 8. Standing operating rules

- **Extremely budget-constrained.** Check the cost before adding any paid
  service. Use the free tier or the cheapest viable option unless there's a
  specific reason not to.
- **Nothing hardcoded that might change:** brand, domain, pricing, copy,
  commerce modes, templates. All data or config.
- **Work continuously; only stop to ask for** (1) an irreversible or
  hard-to-reverse action not already authorized; (2) a genuine product judgment
  call where reasonable people would disagree and customers would notice;
  (3) a credential or manual action only the owner can do.
- **The verification standard never drops.** Exercise real behaviour against
  production or Stripe test mode rather than assuming from code. Audit your own
  work before reporting. Name what is unverified rather than rounding up.
  Details: the `verification-standard` memory.
- **When session budget runs low,** stop at a clean, verified point, never
  mid-fix, and leave an explicit "resume here" note.
- **Tag every report** `[chat: routine | decision | strategic]` plus
  `[next: /model X /effort Y — reason]`. Calibrate honestly: a report
  containing a new real finding is never "routine".

## 9. Go-live trigger — the event, not a date

Real customer transactions must not be possible until every pending item below
is done. The trigger is the moment real traffic *becomes possible*, not a date.
Add an item whenever a gap is found; tick it only with evidence, recorded in
`EVIDENCE.md` (not auto-loaded), not here.

**Done (evidence in EVIDENCE.md / TENANCY.md):**
- Stock holds + movement ledger, all checkout, raffle and waitlist paths,
  merchant and original store (2026-09-27).
- Merchant stock tools in /app (count, add/remove, history, oversold).
- Stripe Connect for merchants: single, cart, raffle/waitlist, fees, refunds,
  disputes, order emails.
- Merchant dashboard with per-route isolation proofs; public signup closed.
- Pooled stock is refused by every gate (real pool support is a separate feature).
- The original store's admin Stock tab (count, add/remove, history, oversold)
  on the same ledger (2026-09-27).
- The pricing page states the per-sale fee, derived from the plan data
  (DEFERRED-9, 2026-09-27).
- Plan billing: Growth by Stripe subscription, 7-day grace, proven in test
  mode with real sales at 0% and graduated (PRICING.md §9, 2026-09-27).

**Pending:**
- **PLATFORM-IDENTITY (own session, not a quick fix).** GOYUNIR is a
  tenant, not the platform; goyunir.com is a stand-in for both. Audit
  2026-09-27:
  - No platform domain is hardcoded in code: it comes from
    `PLATFORM_ROOT_DOMAIN` (the `goyunir.com` literals are only in comments
    and wrangler routes, which are config).
  - The platform's name is now config (`PLATFORM_NAME`, marketing chrome).
  - Still tangled:
    (a) The root layout's metadata and title suffix, the staff sign-in
        header, and the `/og` share image take the ORIGINAL STORE's
        settings, so platform pages say "| GOYUNIR" from store data.
    (b) admin.<root> is BOTH the platform admin and the original store's
        admin (`app/admin/page.tsx` seeds from `GOYUNIR_STORE_SUITE`).
    (c) The original store is the "default tenant" in code paths
        (`DEFAULT_TENANT_ID`, `ensureDefaultTenant`) rather than an
        ordinary tenant.
    (d) System emails' from-name and auth pages (`app/auth/*`) use store
        branding.
    (e) Platform Terms/Privacy name the operator only by domain; the
        platform's legal entity name must replace that at legal review.
  - Target: the platform on its own domain, and GOYUNIR at
    goyunir.<platform-domain> or its own custom domain.
- 🛑 Cloudflare Workers Paid (50-subrequest ceiling on Free): the first
  go-live action; staying on Free until then is deliberate (owner).
- 🛑 Live-mode Stripe webhooks (platform + Connect) must subscribe to
  `checkout.session.expired`, as the test-mode ones do. The live PLATFORM
  webhook must also subscribe to `customer.subscription.created/updated/deleted`
  and `invoice.paid/payment_failed` (plan billing).
- 🛑 Stripe Tax on plan invoices before real subscription revenue (PRICING.md §9).
- 🛑 support@goyunir.com must receive mail (goyunir.com has no MX), then set
  `SUPPORT_EMAIL`.
- Every charge path writes an order: admin trigger-drop not yet proven with a
  real charge.

## 10. Where things live

- **Proof logs and detailed go-live evidence:** `EVIDENCE.md` (not
  auto-loaded; read it when debugging stock, Connect or a go-live item).
- **Engineering decisions, incidents, deferred work:** `ARCHITECTURE.md`. The
  *Deferred work register* holds everything consciously postponed, each entry
  with the condition for picking it up. Check the highest existing
  `DEFERRED-n` before numbering a new one; IDs have collided before.
- **Pricing, plans, marketing copy:** `lib/platform-marketing.ts` (the data);
  `PRICING.md` (the graduated-fee design and decisions D1–D5); `CONNECT.md` (Connect);
  `lib/pricing/graduated-fee.ts` (the engine).
- **Production deploys:** push to `main`. Cloudflare's git integration builds
  the `customattempt-1` worker. Never `wrangler deploy` locally: the `name` in
  `wrangler.jsonc` is stale and would claim the domain for the wrong worker.
