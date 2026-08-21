#  Private Allocation Storefront — White-Label Template

A **drop-allocation / raffle storefront** built on Next.js + Redis + Stripe.
Customers enter releases with an email, shipping address, and a saved card; on
a schedule (or when you trigger it), winners are drawn and their cards are
charged automatically. Direct-buy (FCFS) products, a cart/bag, points &
rewards, promo codes with promoter payouts, waitlists, and address autofill are
all included.

**The headline feature is** `/admin`**:** every product, price, size, inventory,
winner tier, Stripe ID, color, font, brand name, logo, footer link, policy page
and reward rate is editable live from the admin portal — **no code changes and
no redeploys are needed to run the store**. Buyers can rename the entire brand
without touching a single file.

---



## Related workspaces

- **`multi-tenant-platform/`** — a self-contained multi-tenant website template
  platform: Supabase Postgres + RLS as the source of truth, Cloudflare Workers +
  Cloudflare KV for edge delivery. Strict shared TS contracts, SQL migrations
  with RLS policies, an edge-rendering Worker and an admin Save/Publish +
  cache-invalidation pipeline. See its `README.md`.

## 1. Deploy & connect

The app is **platform-agnostic** — the same code runs on Vercel, Netlify,
Cloudflare (via the OpenNext adapter), Railway, Render, Fly.io or any Node
host that runs `next start` / Next.js functions. The only external services
are **Upstash Redis** (the data store), **Stripe** and **Resend** — all plain
HTTPS APIs, no platform-specific code.

### Pick your platform

| Platform | How hard | Why you'd pick it | Where to look |
| --- | --- | --- | --- |
| **Vercel** | Easiest — click "Import", done | Git-connected auto-deploys, built-in cron, zero config | [Vercel](#vercel) below |
| **Netlify** | Easiest — click "Import", done | Same as Vercel, if you prefer Netlify | [Netlify](#netlify) below |
| **Cloudflare** | A few terminal commands | Edge network, free tier, single Worker | [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) — full 6-step walkthrough |
| **Any Node host** (Railway, Render, Fly, VPS) | `npm run build` + `npm start` | You already run a VPS/container | [Any other Node host](#any-other-node-host) below |

### Common setup (every platform, once it's deployed)

1. **Set the environment variables** from the tables below in your platform's
   project settings (Production + Preview), then trigger a redeploy.
2. Open `https://yourdomain.com/admin`, log in with the admin credentials
   (`ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD`), complete the
   emailed two-step code, and click **Developer → Seed Defaults** (or build
   your catalog by hand with **Add Product**).
3. Set your Stripe webhook to `https://yourdomain.com/api/stripe/webhook`
   (Stripe → Developers → Webhooks).
4. Check **/admin → SetUp** — it shows ✓/✗ for every env var and a launch
   checklist.
5. Your store is live.

> **Repo layout:** the entire application lives in the `e-commerce-store/`
> subdirectory of this repo (it is fully self-contained — its own `package.json`,
> lockfile, `vercel.json`, `netlify.toml`, `.gitignore`). Set your platform's
> **Root / Base directory** to `e-commerce-store`.



### Vercel

1. **Import the repo**: vercel.com → **Add New → Project** → connect your Git
   repo.
2. **Set the Root Directory to `e-commerce-store`** (where `package.json`
   lives) — Vercel auto-detects Next.js from there.
3. **Environment Variables** (Project → Settings → Environment Variables, both
   Production and Preview): add the variables from the tables below.
4. **Deploy** (Vercel auto-deploys on every push to the connected branch).
5. **Daily safety net**: already wired by `vercel.json`
   (`0 0 * * *` → `/api/checkout/cron-draw`). Set `CRON_SECRET` in the env so
   the cron can authenticate. Note: Vercel's Hobby plan allows **one cron run
   per day** — draws still fire in real time from the client countdown, so the
   cron is a backstop, not a requirement.
6. When no site URL is configured, `VERCEL_PROJECT_PRODUCTION_URL` /
   `VERCEL_URL` are used automatically — no `NEXT_PUBLIC_URL` needed unless
   you want a specific domain.



### Netlify

1. **Import the repo**: app.netlify.com → **Add new site → Import an existing
   project** → connect your Git repo.
2. **Set the Base directory to `e-commerce-store`**. The included
   `netlify.toml` sets the build command and the daily scheduled function
   automatically.
3. **Environment Variables** (Site configuration → Environment variables, both
   Production and Preview): add the variables from the tables below.
4. **Deploy** (auto-deploys on push; Netlify's Next.js runtime plugin handles
   routing, the middleware/proxy and server functions).
5. **Daily safety net**: automatic — Netlify invokes
   `netlify/functions/cron-tasks.mjs` daily, which pings
   `/api/checkout/cron-draw`, `/api/cron/recovery` and
   `/api/analytics/social-tick` with `Authorization: Bearer $CRON_SECRET`
   (set `CRON_SECRET` in the Netlify env).
6. When no site URL is configured, Netlify's `URL` / `DEPLOY_URL` are used
   automatically.



### Cloudflare

Follow the complete, copy-paste walkthrough in **`DEPLOY-CLOUDFLARE.md`** —
six numbered steps. The one-line version (full details in the guide):

```bash
npm install
npm run build:cloudflare          # set NEXT_PUBLIC_* in your shell first
npx wrangler deploy               # then: npx wrangler secret put <each runtime var>
npx wrangler domains add your-store.com   # optional — or test on *.workers.dev
cd cron-worker && npx wrangler deploy && npx wrangler secret put TARGET_URL && npx wrangler secret put CRON_SECRET
cd ..
```

- The whole app runs as **one Worker** via the official OpenNext adapter
  (`@opennextjs/cloudflare` — already in `package.json`). The `/api/*` routes,
  middleware, `/og` card, `/icon` and `/media` all work unchanged, and the
  public routes already emit `CDN-Cache-Control` headers Cloudflare's edge
  honors.
- **Build-time vs runtime env vars matter on Cloudflare** — `NEXT_PUBLIC_*`
  must be in your shell when you build; everything else is set with
  `npx wrangler secret put` after the first deploy. The guide explains this
  with a table.
- The daily safety net is the tiny scheduled worker in `cron-worker/` — deploy
  it once and set two secrets: `TARGET_URL` (your store URL) and `CRON_SECRET`
  (the same value as any platform). See `cron-worker/README.md`.
- When no site URL is configured, Cloudflare's `CF_PAGES_URL` is used
  automatically.



### Any other Node host

1. Run `npm run build` then `npm start` (or the platform's Next.js runtime).
2. Set the environment variables from the tables below (Production).
3. Schedule a daily hit to `/api/checkout/cron-draw` (plus the optional
   `/api/cron/recovery` and `/api/analytics/social-tick`) with
   `Authorization: Bearer $CRON_SECRET` — cron-job.org, GitHub Actions,
   UptimeRobot and QStash all work. See `lib/cron-auth.ts`.
4. Done — draws still fire in real time from the client countdown even without
   any scheduler.



### Required environment variables


| Variable                                                 | Purpose                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`     | Redis (the data store — everything lives here). Any Upstash REST pair works from any platform. Aliases accepted: `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Upstash/Vercel KV), `REDIS_REST_URL`/`REDIS_REST_TOKEN`. Wire-protocol `redis://` URLs are skipped automatically.                                                      |
| `STRIPE_SECRET_KEY`                                      | Stripe API key                                                                                                                                                                                                                                                                                                                 |
| `STRIPE_WEBHOOK_SECRET`                                  | Stripe webhook signing secret                                                                                                                                                                                                                                                                                                  |
| `ADMIN_BASIC_AUTH_USERNAME`, `ADMIN_BASIC_AUTH_PASSWORD` | Protects `/admin` (Basic Auth + two-step verification)                                                                                                                                                                                                                                                                         |
| `ADMIN_VERIFY_EMAIL`                                     | Inbox that receives the `/admin` two-step code. Falls back to `SUPPORT_EMAIL`/`REPLY_TO_EMAIL`.                                                                                                                                                                                                                                |
| `CRON_SECRET`                                            | Protects the scheduled safety-net endpoints (`/api/checkout/cron-draw`, `/api/cron/*`). Schedulers authenticate with `Authorization: Bearer $CRON_SECRET`.                                                                                                                                                                     |
| `NEXT_PUBLIC_URL`, `NEXT_PUBLIC_SITE_URL`, or `SITE_URL` | Your canonical domain (used for links, social cards, emails). Any of the three works — set whichever your platform provides. If none are set, the platform's own URL variables are used automatically: Vercel (`VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL`), Netlify (`URL`/`DEPLOY_URL`), Cloudflare Pages (`CF_PAGES_URL`). |




### Recommended environment variables


| Variable                                | Purpose                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_PRODUCT_ID`                     | Global default Stripe **Price** ID for any product/size that doesn't have one set in admin. Per-product IDs in admin always win. If nothing is set, checkout fails loudly with `price_placeholder_not_configured` instead of charging the wrong account.              |
| `STORAGE_PROVIDER`                      | Optional data-backend selector. Default (unset) = Upstash Redis — recommended for payments/raffles. Set to `cloudflare-kv` to run on the Workers-KV adapter (`lib/storage/cloudflare-kv.ts`; see its concurrency caveats). Active provider shows in `/admin → SetUp`. |
| `RESEND_API_KEY`, `RESEND_FROM`         | Transactional email (entry confirmations, winners, resets).                                                                                                                                                                                                           |
| `NEXT_PUBLIC_MAPBOX_TOKEN`              | Mapbox Address Autofill (public `pk.*` token). Without it, customers just type addresses manually. Set it in the SAME environment you deploy, then redeploy.                                                                                                          |
| `BRAND_NAME` or `NEXT_PUBLIC_SITE_NAME` | Brand name used in email "from" and templates.                                                                                                                                                                                                                        |
| `SUPPORT_EMAIL`, `REPLY_TO_EMAIL`       | Support inbox used in emails.                                                                                                                                                                                                                                         |


---



## 2. Branding in 5 minutes (no code)

In `/admin` → **Settings**:

1. **Branding & Share** — set your brand name, upload your logo, pick the
  header mode, set the share title/description/tagline/URL and the social card
   colors — then open **Share card style** to control the card's layout
   (classic / split / minimal), typeface, title & description sizes, glow
   intensity, corner radius, image darkness and which elements (logo, tagline,
   site URL) appear. This drives the top bar, footer, browser tab icon, social
   share card, page titles and emails.
2. **Theme Colors / Design Presets** — pick a preset or build your own palette.
  Every preset speaks Apple's design language (continuous squircles, Liquid
   Glass chrome, soft shadows, airy spacing); the flagship **Apple** preset is
   the full iOS 26 Liquid Glass look, and **Minimal (Default)** is the clean
   neutral starting point.
3. **Footer** — social links, support email, copyright line.
4. **Legal & Policies** — paste your Terms, Privacy and Shipping content
  (use `##`  for headings, `-`  for bullets, and `{companyName}` /
   `{supportEmail}` tokens). The `/terms`, `/privacy` and `/shipping` pages
   render from this — no code changes needed when your policies change.
5. **Catalog (section order on /catalog)** — choose whether `/catalog` shows
  Upcoming → Past Archives → **Currently Available** (the default, with live at
   the bottom) or any other order. **Product categories** (Perfume, Clothes,
   Shoes, Food, …) are created/deleted here and become the filter bar on
   `/catalog`.
6. **Checkout & Orders** — the entry/order **reference-code prefix** (default
  `GU-`, letters/numbers up to 4 chars; legacy `GY-`/`GOY-` refs re-label
   automatically) and whether customers must pick the full Mapbox-dropdown
   address at checkout (the admin portal always overrides this).
7. **Behavior** — "Start at the top when the page opens" (default ON) keeps the
  store from reopening mid-page; switch it off to restore the browser's saved
   scroll position.
8. **Save All Settings.**

That's it — the whole site now reflects your brand.

---



## 3. Running the store day to day

Everything happens in `/admin`:

- **Products** — add / edit / duplicate / publish / archive products, set sizes
(`priceCategories`), prices, Stripe Price IDs, inventory, winner tiers,
images **and videos** (PNG · JPEG · JPG · SVG · WEBP · GIF · BMP + MP4 · MOV ·
MKV · AVI · WEBM), per-photo **crop with live desktop/mobile previews**, and
sort order. New products are **hidden** until you publish them. **Every size
has its own checkout mode** (Auto / RAFFLE / FCFS), so one product can be
*both* — e.g. a sampler that sells instantly while the full bottle runs a
raffle. FCFS sizes charge immediately and are never drawn; RAFFLE sizes run
the draw. Size chips, the product-page CTA and the cart all reflect each
size's mode automatically.
- **Per-size raffle settings** — when two sizes both run raffles you can make
them *completely different*: each size card in Pricing & Sizes has its own
**countdown end** and its own **recurring schedule** (hourly/daily/weekly/
biweekly/monthly/yearly/custom "every N hours"), plus its own winner tiers.
The product page shows the timer for the size you've selected, and the draw
engine draws each size's pool on its own cycle — a 12-hour collector raffle
and a daily standard raffle can run side by side on the same product.
- **Customer-facing copy** — every product has its own optional urgency and
status lines ("Handmade allocation. Low supply by design." /
"Reserved for collectors moving early…" etc.) that override the site-wide
Settings → Storefront copy per product. Leave them blank to inherit the
global defaults. Products that **mix formats** (raffle + instant-buy sizes)
also get an editable **mixed-format ribbon** — set once site-wide in
Settings → Storefront copy (`{raffle}`/`{fcfs}` tokens become the size
counts) or per product in the Customer-facing copy section.
- **Catalog** — move items between Upcoming / Archive previews.
- **Draws** — trigger a draw manually, view draw history, search the permanent
entry ledger.
- **Promos** — create customer discount codes and promoter codes (with payout %),
set per-email/per-total caps and per-product/size eligibility.
- **Users** — adjust rewards points, view accounts.
- **Developer** — **Seed Defaults** (populates a starter store), **Site
Self-Test** (health check that repairs missing live states), and **Tidy Redis
Schema** (losslessly migrates any legacy key names from older template
versions into the tidy `domain:subdomain:` schema and removes redundant
keys — safe to re-run anytime).

> The storefront shows **0 items until you seed or add products** — that is
> intentional. Product slugs only resolve for products that exist in Redis.

---



## 4. How a raffle drop works

1. A customer enters with email + shipping address and saves a card via Stripe
  (no charge yet).
2. One entry per email per product+size is enforced automatically (server-side).
3. **When a product's countdown hits zero, the drop fires automatically** — the
  storefront pings `/api/checkout/auto-draw` the instant the timer ends (and
   re-pings with backoff if the network blips, so a flaky connection can't
   silently miss the drop), and a scheduled safety net on whatever platform you
   deploy to (Vercel's `vercel.json` cron, Netlify's scheduled function, the
   Cloudflare cron worker, or any external scheduler — all authenticated via
   `CRON_SECRET`, see §1) is the final server-side backstop. Drop times are
   stored as **store-timezone wall-clock strings**
   (`store:config.dropSchedule.timezone`) and parsed consistently by the browser
   countdown AND the server engine (`lib/drop-timestamps.ts`), so a release
   whose end has already passed fires the draw immediately when anyone loads the
   product/home/catalog page. The draw engine reads each product from Redis
   (never the static config), so admin-created products draw too. Winners are
   picked randomly up to the configured winner tiers / inventory and their saved
   cards are charged. The public trigger endpoint is rate-limited per IP, and
   the engine's due-check + 90s cooldown make a stampede of pings harmless.
4. **A draw is cycle-aware — nobody is ever charged before the timer they saw
  hits zero.** Every entry records `registeredAt`; when a countdown ends the
   engine draws ONLY the entries made before that instant. If you enter a
   raffle *after* the countdown restarted (the "new raffle" timer), your entry
   is carried into the next round untouched. A stale cycle that ended with no
   eligible entries is rolled forward to the next draw moment without charging
   anyone. Non-winners and unfinished checkouts are never deleted — everything
   is logged in the searchable ledger in `/admin`.
5. **If inventory remains, the raffle can repeat on a schedule.** The draw
  engine rolls the countdown forward to the next scheduled draw moment —
   **hourly, daily, weekly, biweekly, monthly, yearly, or a custom
   "every N hours" interval** (per-product under
   `/admin → Products → Edit → Raffle schedule (recurring)`, per-size inside
   each size card in Pricing & Sizes, or the global
   cadence in `/admin → Draws → Automation`) — the storefront shows the NEW
   timer (never a stale "Until sold out"), and unselected entries carry over
   into the next round. **Each size's raffle can run on its own cycle** (own
   countdown end + own cadence) even on the same product. One-shot drops (a
   fixed date with no next occurrence) draw once and are done.

> Set `CRON_SECRET` in your platform so the scheduled safety-net endpoints
> (`/api/checkout/cron-draw`, `/api/cron/*`) are authorized. The client-side
> countdown trigger works with or without it.

Direct-buy (FCFS) products go through the bag/cart and are charged immediately.

### Anti-double-entry behavior (built in)

- Entering a raffle through the product page **removes that item from the bag**
so it can't be entered twice.
- After an entry is confirmed, "Add to bag" blocks that product+size for the
session, and the server rejects a duplicate entry at checkout with a clear
"You're already entered" message.
- Checkout from the bag clears the bag once all raffle entries are secured.
- **The bag follows the account.** Signed-in customers get their cart saved to
Redis (`store:carts` — a single hash keyed by user id — via `/api/cart/sync`) on every change, and it is
merged into the browser bag on login — so the same account sees the same bag
on any device. Anonymous visitors keep the localStorage bag as before.

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


| Route                                                    | What it is                                     |
| -------------------------------------------------------- | ---------------------------------------------- |
| `/`                                                      | Home (hero + priority drops)                   |
| `/catalog`                                               | Upcoming → Past Archives → Currently Available |
| `/<slug>`                                                | Product / entry page                           |
| `/account`                                               | Manage entries, rewards, credits, password     |
| `/auth/login` · `/auth/signup` · `/auth/forgot-password` | Accounts                                       |
| `/terms` · `/privacy` · `/shipping`                      | Policies (admin-editable)                      |
| `/story`                                                 | Brand story (admin copy + legal company name)  |
| `/admin`                                                 | The control room                               |




### Shipping addresses are validated — strictly

Every entry, cart checkout, waitlist and address update requires a **complete,
shippable address** (street number + street name, city, state/region, ZIP/postal
code and country). Partial input like `123 realstreet` is rejected with one
short, friendly message that points the customer to the address dropdown —
Mapbox Address Autofill is the fast path and always fills the whole address.
See `lib/address-validation.ts`.

### Admin extras

- **Two-step admin verification**: after the Basic Auth password, `/admin`
emails a 6-digit code to `ADMIN_VERIFY_EMAIL` (fallback `SUPPORT_EMAIL`) that
you must enter before the portal unlocks. Check "remember this device" to
skip the code for 30 days on that browser. Wrong codes lock out for 15 minutes
after 5 tries, so a leaked password alone can't get into `/admin`.
- **Streamer Mode** (default ON): masks customer emails, shipping addresses,
card numbers, tracking numbers, promo codes, order refs, phone numbers and
names (fixed-length bullet masks — even the character lengths never leak), and
the password field shows a fixed mask (never the real length) so you can
safely share the portal on a livestream (draw reveals, winner announcements).
Turn it off only when you need to work on live data.
- **SetUp tab**: environment-variable status dashboard (✓ set / ✗ missing, never
the values) plus a production launch checklist.
- **System → Wipe & Rebuild Redis**: destructive full wipe with **two-step
confirmation** (admin password + typing `WIPE`), optionally rebuilding the
seeded defaults. Use it to reset a demo or hand a clean slate to a new buyer.

---



## 8. Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (type-checks + compiles)
npm run lint     # eslint (100% clean — 0 errors, 0 warnings)
npm test         # unit tests (node --test on tests/*.test.ts)
npm run typecheck # tsc --noEmit
```

Useful files:

- `lib/redis-keys.ts` — **the single source of truth for every Redis key**
(tidy `domain:subdomain:` schema + helpers). Never hardcode a key elsewhere.
- `lib/server-config.ts` — Redis helpers, config loaders, Stripe clients.
- `lib/storefront-config.ts` — defaults + shared storefront helpers.
- `lib/legal-config.ts` — legal/policy defaults + content parser.
- `components/LegalPage.tsx` — server renderer for the policy pages.
- `components/SiteChrome.tsx` — header / footer / cart drawer / glow orbs.
- `components/Storefront.tsx` — product page, entry form, cart logic.
- `lib/mapbox-autofill.ts` — Mapbox address autofill wiring.
- `goyunir.config.ts` — starter defaults (brand seed value, theme, products).



### A note on Redis

Everything lives in Redis (Upstash). The key space is intentionally tidy so the
Redis data browser stays readable even at thousands of customers:

- `store:*` — catalog, site config, user accounts (the data you edit in `/admin`)
- `archive:ledger` — permanent entry/charge history
- `promo:*` — promo codes and their usage state
- `entries:*` — live entry/intent/waitlist pools, fraud blocks, dedupe sets
- `draws:*` — draw summaries + history
- `ops:*` — live inventory state, catalog archive, recovery, admin overrides
- `auth:*` — sessions and password-reset tokens
- `admin:*` — audit log + two-step verification state (device tokens live in one `admin:devices` hash)
- `analytics:*` — social-proof counters, online visitors
- `customer:*` — waitlist subscribers and standalone address submissions
- `cache:*` — ephemeral caches (safe to delete anytime)

If you ever see legacy key names (`drop_pool:*`, `session:*`, `live_state`,
`stats:*`, `config:promos`, …) in the browser — e.g. after upgrading an older
install — run **/admin → Developer → Tidy Redis Schema** and they will be
renamed in place with no data loss.

---



## 9. Troubleshooting


| Symptom                                        | Fix                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store shows 0 items                            | Seed defaults or add a product in `/admin`                                                                                                         |
| Product page 404                               | Product isn't in Redis — add/seed it in `/admin`                                                                                                   |
| `/admin` won't open                            | Check `ADMIN_BASIC_AUTH_USERNAME` / `ADMIN_BASIC_AUTH_PASSWORD`                                                                                    |
| "Price not configured" / `price_placeholder_*` | Set the Stripe Price ID for that size in `/admin`                                                                                                  |
| Settings don't show immediately                | Storefront caches ~10–30s; wait and refresh                                                                                                        |
| Mapbox dropdown missing                        | `NEXT_PUBLIC_MAPBOX_TOKEN` unset or not redeployed                                                                                                 |
| Address autofill only fills street             | Only happens without the SDK's retrieve handling — ensure you're on the React storefront forms (product page / cart drawer) and the token is valid |
| "Already entered"                              | That's working as intended — one entry per email per size                                                                                          |


---

*For AI agents working on this codebase, read* `AGENTS.md` *— it contains the
full architecture, invariants, and the mandatory rule to keep it updated.*