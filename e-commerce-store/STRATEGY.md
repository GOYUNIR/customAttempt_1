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

## 5. Business model

| Plan | Monthly | Platform fee | Notes |
|---|---|---|---|
| Free | $0 | 2% | Up to 50 orders/month. Removes "pay before you've made money". |
| Starter | $29 | 0.5% | |
| Growth | $99 | 0% | Growth modules included. |
| Scale | custom | custom | |

- **Pricing is data, not code.** Plans, fees (the tier-to-basis-points mapping),
  limits and copy live in `lib/platform-marketing.ts`.
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

Real customer transactions must not be possible until **every** item below is
true. The trigger is the moment real traffic *becomes possible*, not a calendar
date. Each item is here because it has already failed or been shown to be
missing. Add to this list whenever such a gap is found. Tick an item only with
evidence, and write the evidence next to it.

### Hard blockers — without these it is not a usable or safe store

- [ ] **🛑 A MERCHANT CAN SET STOCK. Today they cannot.** A merchant who can't
  restock, or can't mark something sold out, is not running a store. That
  makes this a hard blocker, not a polish item (owner, 2026-09-24).
  - For any variant that already has an `inventory_levels` row, the product
    editor's per-size inventory field is saved into config and then ignored:
    `catalog-write` only creates missing rows.
  - `/api/admin/inventory` writes only the KV mirror, and no UI calls it.
  - `inventory-matrix` is read-only.
  - Production logs show it happening: "configured inventory 15 differs from
    live stock 1."
  - A merchant can't restock, and can't set a product to 0 to pull it from
    sale.
  - The fix is an explicit stock-set / stock-adjust operation that is safe
    against in-flight sales. **Design it together with reservation holds, in
    one pass.** Both need stock changes recorded as movements rather than
    overwritten numbers, and two separate patches would disagree with each
    other.
- [ ] **🛑 Inventory reservation holds.** The cart path checks stock when the
  Stripe session is created and decrements only after payment, so two buyers
  can both pay for the last unit. §4 requires a real hold. Same design pass as
  the item above.
- [ ] **🛑 Stripe Connect.** A per-merchant connected account, with the
  platform fee collected. Until then every tenant shares one Stripe key, which
  is what makes multi-merchant legal.
- [ ] **🛑 Cloudflare Workers Paid.** On Free the ceiling is 50 subrequests per
  invocation. The checkout webhook measured 51 on a one-item cart before B
  (2026-09-24). Staying on Free until go-live is deliberate (owner). Upgrading
  is the first go-live action.

### Must also be true

- [ ] **Every charge path writes an order**, proven by a real charge on each
  path.
  - Proven with real test-mode charges: direct checkout, cart (the webhook), and
    the auto-draw winner charge.
  - Not yet proven with a real charge: admin trigger-drop, and waitlist
    conversion.
- [x] **No shared-inventory pool can be sold through a path that ignores it.**
  Postgres stock is per-variant and ignores `shared_pool_id`, so every stock
  gate refuses a pooled variant (`lib/stock-gate.ts`, B1). Evidence: unit tests
  in `tests/stock-gate.test.ts`. Not exercised live, because no production
  variant uses a pool. Real pool support is a separate feature.
- [ ] **The homepage copy doesn't contradict the fee model** (DEFERRED-9).

## 10. Where things live

- **Engineering decisions, incidents, deferred work:** `ARCHITECTURE.md`. The
  *Deferred work register* holds everything consciously postponed, each entry
  with the condition for picking it up. Check the highest existing
  `DEFERRED-n` before numbering a new one; IDs have collided before.
- **Pricing, plans, marketing copy:** `lib/platform-marketing.ts`.
- **Production deploys:** push to `main`. Cloudflare's git integration builds
  the `customattempt-1` worker. Never `wrangler deploy` locally: the `name` in
  `wrangler.jsonc` is stale and would claim the domain for the wrong worker.
