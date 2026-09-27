# A skeptical stranger on goyunir.com (2026-09-27)

Written for the owner, to decide what to act on. Nothing here has been fixed.

**Method.** I read the live site in a browser (the homepage, /platform, /terms
and /privacy), plus the FAQ and comparison copy from `lib/platform-marketing.ts`.
I read them the way a store owner on Shopify or BigCommerce would. I then
checked every claim against what is actually built. "Valid" means the
objection is true today. "We're new" is left out: the FAQ already answers it
honestly.

## The strongest reason to walk away

**You can't become a customer.**
- **Signup is a dead end.** "Signups are not open yet… Get in touch." There is
  no email address, no form and no link.
- **The prices can't be bought.** "$29/month, 14 days free" and "Start free
  trial" have no plan billing behind them: no subscriptions and no trials exist
  in the code.

A stranger concludes the site is a demo or abandoned. That alone ends the visit
before any other objection matters.

## Objections, in order of how badly they hurt

### 1. The pricing page contradicts how you actually charge (VALID, serious)
- **What the page says:** it advertises flat monthly plans. It also says "We do
  not charge a percentage of the revenue our own tools claim…", which a reader
  will take as "no percentage fee".
- **What actually happens:** every sale on a merchant store carries a platform
  fee (Free 2%, $29 0.5%, $99 0%), collected through Stripe. The page never
  mentions it.
- **Consequence:** a merchant finds a 2% deduction in their Stripe payouts after
  signing up. That's how a store loses trust, and could be read as deceptive.
  It's already logged internally as DEFERRED-9.
- **To resolve:** state the per-sale fee next to each plan, and keep the
  "we never bill on attributed revenue" promise as its own separate sentence.
  **Cheap:** it's copy in `lib/platform-marketing.ts`. **Your call:** the wording.

### 2. Claims the product doesn't back up today (VALID)
A stranger who tries the product finds these, and then stops believing the
rest of the page.

| Claim on the page | Reality today | Fix size |
|---|---|---|
| "Two people can never buy the last one… oversells are refused by the database" | False until the stock rollout now under way lands. Two buyers can both pay for the last unit. | In progress |
| "Oversell protection **and shared stock pools**" (Starter) | Pooled stock is deliberately refused (B1). Pools don't exist. | Cheap to remove the claim; a project to build |
| "Sell on your own domain, not a slug of ours" | Merchants get `name.goyunir.com`. Custom domains exist only for the original store. The merchant dashboard can't add one. | A project (Cloudflare for SaaS is partly wired) |
| "Export it all at any time… standard Postgres" | A merchant has no export button and no database access. | Medium: CSV/JSON export of products, orders and customers |
| "Abandoned cart and back-in-stock recovery", "Impact measured against a control group", "you can read the method in your dashboard" | Built for the original store only. Nothing for merchants. Back-in-stock isn't even store-aware. | A project |
| "B2B quotes and net terms" | The database schema exists. There is no merchant UI, and merchant storefronts refuse B2B routes. | A project |
| "Failed-payment recovery" | The original store only. | Medium |
| "Staff accounts with roles **and audit history**" | Staff: yes (today). A merchant can't see the audit history. | Cheap: a read-only list |
| "Multiple storefronts on one account" (Scale) | Not built. | A project; could be "talk to us" copy for now |
| "Starter templates… for each way of selling" / "Do I need a developer? Not to launch" | A merchant can't choose a template or theme. | Medium: presets as data (STRATEGY §4) |
| "Up to 50 orders a month" on Free | Nothing enforces it (a generous gap, not a deceptive one). | Cheap, whenever |

**To resolve cheaply:** make the page claim only what a merchant can use today,
with "coming" labels where honest. The copy is all data in one file. The
honesty positioning ("smaller, true numbers") makes overclaiming doubly
damaging: the whole pitch is that we don't exaggerate.

### 3. You can't run a real store with the merchant dashboard yet (VALID)
This compares the dashboard with Shopify's basic plan, not its app store.

| Gap | Fix size |
|---|---|
| **No product photos.** The merchant form saves `images: []` and has no upload, so every product is text-only. For any consumer brand this ends the evaluation. | Medium: the media storage already exists for the original store |
| **No fulfilment.** Orders can't be marked shipped, tracking can't be added, and the customer gets no shipped email. | Medium |
| **No refunds in the dashboard.** Refunds happen in the Stripe dashboard (the webhook does handle them correctly). | Cheap to medium |
| **No discount codes.** "Promo codes aren't available in this store yet." | Medium |
| **No customer accounts** on merchant storefronts, and no customer list in the dashboard. | Medium |
| **No shipping rates, no tax setup, one currency per store.** | A project, part of it via Stripe Tax |
| **Products can't be deleted or archived** (create and edit only). | Cheap |
| **No bulk import.** A Shopify merchant can't bring their catalog over. | Medium: CSV import |
| **No analytics** beyond the order list. | Medium |

### 4. Nothing tells a stranger who you are (VALID)
Each of these is cheap to fix but needs your input.

- **Who is behind it:** no About page, no named people, no company name or
  legal entity, no address.
- **The support address:** the only contact on the site is a **gmail** address
  (`goyunir.support@gmail.com`, in the /terms footer). For a payments platform
  that reads as a hobby project.
- **No proof anyone uses it:** no customers, logos, testimonials, case studies or
  live example stores.
- **No reassurance:** no status page, no security page, no statement of where
  data is hosted.
- **Confusing links:** the public footer links a **"Sales portal"** and a
  merchant sign-in, which looks odd to a stranger.

### 5. The platform's legal pages are the perfume store's (VALID, serious for B2B)
- **Terms:** `goyunir.com/terms` shows the **original store's consumer terms**:
  "Allocation system", "All sales final", "Manage My Entry", Instagram and
  TikTok links, "← Back to store".
- **Privacy:** lists **Vercel** and **Redis**, which isn't where anything runs
  now (Cloudflare and Postgres).
- **What a merchant expects:** SaaS terms, a data processing agreement, a
  subprocessor list and an acceptable use policy. None exist.
- **Consequence:** a merchant with any legal review, or anyone in the EU, stops
  here.
- **To resolve:** platform-level terms, privacy notice and subprocessor list on
  the platform domain, separate from the store's. **Mechanically cheap, but it
  needs you and ideally a lawyer.**

### 6. What pushes them to a competitor instead
- **Shopify, plus a raffle or launch app and a B2B app:** photos, themes,
  shipping, tax, POS, discounts, 10,000 apps, and "nobody got fired for
  choosing Shopify". Our real edge (drops, waitlists, retail and trade on one
  inventory and one customer record) only matters once a merchant has felt that
  pain. The page argues it well, but the product doesn't yet let them feel it.
- **BigCommerce B2B Edition, or Shopify Plus B2B:** for trade buyers, because
  ours isn't usable by merchants yet (see 2).
- **Dedicated drop tools (queue and raffle services) bolted onto an existing
  store:** a merchant can keep their store and add only the thing we're best at.
  "Switch your whole platform to get fair draws" is a much bigger ask than
  "add fair draws".

### 7. Technical skepticism (partly valid, mostly internal)
- **Scale:** the platform runs on the Cloudflare Workers free plan (50 outbound
  calls per request). A popular drop charges winners about one per trigger. A
  1,000-winner drop would take a long time to charge. The Workers Paid upgrade
  is already the first go-live action, so this is known and cheap
  ($5/month), but it's real until then.
- **Security:** a stranger can't see the security work, and would have no reason
  to trust it without a security page.

## Triage

**Cheap and quick** (mostly copy or data, hours each):
1. **A contact route on the closed signup:** an email or a "tell us about your
   store" form. Highest leverage of anything here.
2. **Disclose the per-sale fee on the pricing cards** (DEFERRED-9), and keep the
   attribution promise as its own sentence.
3. **Remove or label claims that aren't true yet:** pools, custom domain,
   export, the growth modules, B2B, multi-store, templates, "your dashboard
   shows the method".
4. **Replace the gmail support address** with one on the platform's domain
   (needs a mailbox; forwarding is often free).
5. **Drop "Sales portal" from the public footer.**
6. **Product archive/delete; a read-only audit list for owners.**

**Medium** (days each, each needs its isolation proof):
- product photos for merchants (the highest-value product gap);
- data export (CSV/JSON);
- order fulfilment and a shipped email;
- refunds in the dashboard;
- discount codes;
- CSV catalog import;
- customer list;
- starter presets (as data).

**Real projects:**
- merchant custom domains;
- merchant growth modules (cart recovery, back-in-stock, control-group
  reporting);
- B2B for merchants;
- shipping and tax;
- shared stock pools;
- multi-store accounts;
- plan subscription billing, needed before "$29/month, 14 days free" can be
  sold;
- platform legal documents (needs you, ideally a lawyer).

**Deliberately not listed:** "you're new / no app ecosystem". The FAQ already
answers it honestly.
