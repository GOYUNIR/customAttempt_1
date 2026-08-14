# Private Allocation Storefront — White-Label Template

A **drop-allocation / raffle storefront** built on Next.js + Redis + Stripe.
Customers enter releases with an email, shipping address, and a saved card; on
a schedule (or when you trigger it), winners are drawn and their cards are
charged automatically. Direct-buy (FCFS) products, a cart/bag, points &
rewards, promo codes with promoter payouts, waitlists, and address autofill are
all included.

**The headline feature is `/admin`:** every product, price, size, inventory,
winner tier, Stripe ID, color, font, brand name, logo, footer link, policy page
and reward rate is editable live from the admin portal — **no code changes and
no redeploys are needed to run the store**. Buyers can rename the entire brand
without touching a single file.

---

## 1. Deploy & connect

1. Deploy this repo to **Vercel** (or any Next.js host).
2. Set the environment variables below in the platform's project settings
   (Production + Preview), then redeploy.
3. Open `https://yourdomain.com/admin`, log in with the admin credentials, and
   click **Seed Defaults** (or build your catalog by hand with **Add Product**).
4. Your store is live.

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis (the data store — everything lives here) |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `ADMIN_BASIC_AUTH_USERNAME`, `ADMIN_BASIC_AUTH_PASSWORD` | Protects `/admin` |
| `CRON_SECRET` | Protects cron endpoints |
| `NEXT_PUBLIC_SITE_URL` or `SITE_URL` | Your canonical domain (used for links, social cards, emails) |

### Recommended environment variables

| Variable | Purpose |
| --- | --- |
| `STRIPE_PRODUCT_ID` | Global default Stripe **Price** ID for any product/size that doesn't have one set in admin. Per-product IDs in admin always win. If nothing is set, checkout fails loudly with `price_placeholder_not_configured` instead of charging the wrong account. |
| `RESEND_API_KEY`, `RESEND_FROM` | Transactional email (entry confirmations, winners, resets). |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Mapbox Address Autofill (public `pk.*` token). Without it, customers just type addresses manually. Set it in the SAME environment you deploy, then redeploy. |
| `BRAND_NAME` or `NEXT_PUBLIC_SITE_NAME` | Brand name used in email "from" and templates. |
| `SUPPORT_EMAIL`, `REPLY_TO_EMAIL` | Support inbox used in emails. |

---

## 2. Branding in 5 minutes (no code)

In `/admin` → **Settings**:

1. **Branding & Share** — set your brand name, upload your logo, pick the
   header mode, set the share title/description/tagline/URL and the social card
   colors. This drives the top bar, footer, browser tab icon, social share
   card, page titles and emails.
2. **Theme Colors / Design Presets** — pick a preset or build your own palette.
3. **Footer** — social links, support email, copyright line.
4. **Legal & Policies** — paste your Terms, Privacy and Shipping content
   (use `## ` for headings, `- ` for bullets, and `{companyName}` /
   `{supportEmail}` tokens). The `/terms`, `/privacy` and `/shipping` pages
   render from this — no code changes needed when your policies change.
5. **Save All Settings.**

That's it — the whole site now reflects your brand.

---

## 3. Running the store day to day

Everything happens in `/admin`:

- **Products** — add / edit / duplicate / publish / archive products, set sizes
  (`priceCategories`), prices, Stripe Price IDs, inventory, winner tiers,
  images, and sort order. New products are **hidden** until you publish them.
- **Catalog** — move items between Upcoming / Archive previews.
- **Draws** — trigger a draw manually, view draw history, search the permanent
  entry ledger.
- **Promos** — create customer discount codes and promoter codes (with payout %),
  set per-email/per-total caps and per-product/size eligibility.
- **Users** — adjust rewards points, view accounts.
- **Developer** — **Seed Defaults** (populates a starter store), **Site
  Self-Test** (health check that repairs missing live states), and **Clean Up
  Redis** (removes legacy keys if an older version of the template was used).

> The storefront shows **0 items until you seed or add products** — that is
> intentional. Product slugs only resolve for products that exist in Redis.

---

## 4. How a raffle drop works

1. A customer enters with email + shipping address and saves a card via Stripe
   (no charge yet).
2. One entry per email per product+size is enforced automatically (server-side).
3. At the scheduled time — or when you click **Trigger Draw** — winners are
   picked randomly up to the configured winner tiers / inventory and their
   saved cards are charged.
4. Non-winners and unfinished checkouts are never deleted — everything is
   logged in the searchable ledger in `/admin`.
5. After a draw, the pool resets so customers can enter the next cycle.

Direct-buy (FCFS) products go through the bag/cart and are charged immediately.

### Anti-double-entry behavior (built in)

- Entering a raffle through the product page **removes that item from the bag**
  so it can't be entered twice.
- After an entry is confirmed, "Add to bag" blocks that product+size for the
  session, and the server rejects a duplicate entry at checkout with a clear
  "You're already entered" message.
- Checkout from the bag clears the bag once all raffle entries are secured.

---

## 5. Customer account / rewards

- Signup creates a session immediately (customers land in `/account` logged in)
  and awards **250 points** + a **one-time 10% welcome promo code**.
- Points are earned on purchases (rate set in admin) and redeemed for unique
  one-time store-credit promo codes in `/account`. The gifting toggle and the
  **redeem info message + gift discount %** are all admin-configurable.
- `/account` also lets customers update shipping addresses, cancel entries, and
  update payment methods via Stripe's secure Customer Portal.

---

## 6. Stripe setup checklist

- Add a webhook endpoint in the Stripe Dashboard pointing to
  `https://yourdomain.com/api/stripe/webhook`, subscribed to
  `checkout.session.completed`.
- Enable the **Customer Portal** (Stripe → Settings → Billing → Customer
  Portal) with "Payment methods" on — this powers "Update payment" on `/account`.
- Create **Price IDs** in Stripe and paste them into each product's
  `priceCategories` in `/admin` (or set `STRIPE_PRODUCT_ID` as the global
  fallback).

---

## 7. Customer-facing pages

| Route | What it is |
| --- | --- |
| `/` | Home (hero + priority drops) |
| `/catalog` | Upcoming → Past Archives → Currently Available |
| `/<slug>` | Product / entry page |
| `/account` | Manage entries, rewards, credits, password |
| `/auth/login` · `/auth/signup` · `/auth/forgot-password` | Accounts |
| `/terms` · `/privacy` · `/shipping` | Policies (admin-editable) |
| `/story` | Brand story (admin copy + legal company name) |
| `/admin` | The control room |

---

## 8. Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (type-checks + compiles)
npm run lint     # eslint
```

Useful files:

- `lib/server-config.ts` — Redis helpers, config loaders, Stripe clients.
- `lib/storefront-config.ts` — defaults + shared storefront helpers.
- `lib/legal-config.ts` — legal/policy defaults + content parser.
- `components/LegalPage.tsx` — server renderer for the policy pages.
- `components/SiteChrome.tsx` — header / footer / cart drawer / glow orbs.
- `components/Storefront.tsx` — product page, entry form, cart logic.
- `lib/mapbox-autofill.ts` — Mapbox address autofill wiring.
- `goyunir.config.ts` — starter defaults (brand seed value, theme, products).

---

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Store shows 0 items | Seed defaults or add a product in `/admin` |
| Product page 404 | Product isn't in Redis — add/seed it in `/admin` |
| `/admin` won't open | Check `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD` |
| "Price not configured" / `price_placeholder_*` | Set the Stripe Price ID for that size in `/admin` |
| Settings don't show immediately | Storefront caches ~10–30s; wait and refresh |
| Mapbox dropdown missing | `NEXT_PUBLIC_MAPBOX_TOKEN` unset or not redeployed |
| Address autofill only fills street | Only happens without the SDK's retrieve handling — ensure you're on the React storefront forms (product page / cart drawer) and the token is valid |
| "Already entered" | That's working as intended — one entry per email per size |

---

*For AI agents working on this codebase, read `AGENTS.md` — it contains the
full architecture, invariants, and the mandatory rule to keep it updated.*

