# Store addresses: self-serve subdomain and custom domains

**Status (2026-09-30): BOTH BUILT.**
- §A self-serve address: live and proven (scripts/verify-store-address.ts).
- §B custom domains: built and proven up to Cloudflare (scripts/verify-custom-domains.ts). It switches on when the owner completes "Owner setup" below; until then, connecting a domain answers "not switched on yet".

**Owner decisions (2026-09-30):**
- Custom domains on every plan, capped as plan data (Free 1, Growth 3, Scale unlimited).
- A domain activates only with payments connected and verified.
- Subdomain first.
- www.goyunir.com keeps serving GOYUNIR, with a canonical tag to the primary address.
- Ownership: our own TXT proof is required in addition to Cloudflare's check (dangling-CNAME takeover protection).

## Already in place
- Every store lives at `<slug>.<root>`: `tenants.slug`, wildcard route,
  `lib/storefront-host.ts`, and tenant lookup in `lib/storefront-tenant.ts`.
- Reserved labels (`RESERVED_STORE_LABELS`, plus the legacy hosts in
  `STOREFRONT_LEGACY_HOSTS`) cannot be taken.
- Custom domains, half built:
  - `lib/cloudflare-saas.ts` (Cloudflare for SaaS custom hostnames: create,
    status, delete, sync to the tenant row);
  - `tenants.custom_domain` / `domain_status` / `cloudflare_hostname_id`
    (00010);
  - an admin-only panel;
  - the storefront resolves a store by an ACTIVE custom domain.
  - Not set in production: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID`, the
    fallback origin, and a Worker route for custom hostnames.

## A. Self-serve subdomain (about 1 day with its proofs)
The goal is to feel like picking a username: easy, reversible, low stakes.

- **Where:** Settings → "Store address". An input with `.<root>` shown after
  it, and a live preview line: "Your store: https://name.<root>".
- **Live availability.** `GET /api/merchant/address/check?slug=` runs 300 ms
  after typing stops. It answers available / taken / not allowed, each with
  a one-line reason. Rules:
  - the same normalization as today (a–z, 0–9, hyphens; 3–40 characters);
  - reserved labels;
  - not another store's current address;
  - not another store's recent old address (see below).
- **Changing is safe, so it can feel low stakes.**
  - The old address keeps working for 90 days as a 301 redirect to the new
    one, so printed links, emails and bookmarks don't break. The dashboard
    says so under the Save button.
  - During those 90 days the old name stays reserved for the same store, so
    nobody can grab it and receive its traffic. The store can switch back.
  - Up to 3 changes per day (rate limit), to stop squatting churn.
- **Data:** one additive migration, `tenant_slug_aliases (tenant_id,
  slug unique, expires_at)`. The host lookup tries the current slug, then a
  live alias (301 to the current address).
- **Correctness and isolation:**
  - The change goes through a unique index, so two stores racing for one name
    cannot both win.
  - The session decides which store changes (never the request body).
  - Audited.
  - The tenant-lookup cache is short-lived (minutes); the dashboard says a
    change "can take a minute to reach everyone".
- **Proof:** a change goes live; the old address 301s; another store cannot
  take the old name inside 90 days; the race; reserved names refused.

## B. Custom domains as a plan feature (about 2–3 days, plus the owner's Cloudflare setup)

### How others price it (researched 2026-09-30)
- **Bundled, never a separate add-on fee, never metered to the merchant.**
  - Shopify: paid plans connect a domain at no extra cost; the cheapest
    (Starter) has no custom domain at all.
  - Squarespace: every paid plan; a free domain for year one on annual
    billing.
  - Wix: the free plan is a `*.wixsite.com` subdomain only; custom domains
    from the first paid plan.
  - BigCommerce: every plan connects a domain; no free domain included.
- **Buying the domain itself** is separate and passed through (about $10–20
  a year for a .com).

### What it costs us
Cloudflare for SaaS: 100 custom hostnames included, then $0.10 per hostname
per month. Effectively free at our scale.

### Recommendation
**Custom domains on every plan, Free included.**
- **We earn per sale on Free.** A store on its own domain looks trustworthy
  and sells more, which is more fee for us.
- **Cost:** about $0.10 a month per store after the first 100.
- **Marketing line:** "your own domain, even on Free", where the big
  platforms gate it behind a paid plan.
- **Alternative, if you want an upgrade lever:** custom domains on Growth and
  Scale only (the industry norm). On a downgrade, the domain keeps working
  through the existing 7-day grace, then the store serves from its subdomain
  again. The domain is parked, not deleted.
- **Domain purchase:** not in v1. Merchants connect a domain they already
  own. Selling domains (registrar reseller) is a later, separate decision.

### The merchant flow: DNS kept as invisible as possible
1. Settings → "Custom domain" → they type `shop.example.com` or `example.com`.
2. We register it with Cloudflare for SaaS and show ONE instruction, written
   for their registrar, e.g. "Add a CNAME record: `www` → `stores.<root>`".
   A "Check now" button, plus automatic re-checks.
3. Cloudflare verifies ownership and issues the SSL certificate by itself
   once the record resolves. No certificate work for the merchant.
4. When it's live: an email, and the dashboard says "Live". The store's
   subdomain 301s to the custom domain; checkout and email links use the
   custom domain.
5. **Root domains** (`example.com` without `www`): pointing a root domain at
   us needs Cloudflare Enterprise. v1 connects `www.example.com` and tells the
   merchant to forward `example.com` → `www` at their registrar (every major
   registrar has a one-click forwarding setting).
6. **Later, truly invisible:** Domain Connect, the one-click "authorize"
   flow supported by GoDaddy, IONOS, Cloudflare and others, sets the record
   for them. This needs a template approved with each registrar.

### Safety
- **Ownership:** Cloudflare's verification means nobody can attach a domain
  they don't control.
- **One store per domain:** a unique index, plus the store id stored with it.
- **Limit:** one custom domain per store in v1.
- **Removal:** removing a domain deletes the Cloudflare hostname, which stops
  its billing.

### Owner setup to switch custom domains on (one time, about 30 minutes)
Cloudflare charges $0.10 per hostname per month after the first 100, on every
plan including Free (Cloudflare docs: cloudflare-for-saas/plans).
1. Cloudflare → goyunir.com → SSL/TLS → **Custom Hostnames** → enable
   Cloudflare for SaaS.
2. **DNS:** add a proxied A record `stores` → `192.0.2.1`, and set
   `stores.goyunir.com` as the **Fallback Origin** on that page.
3. **Workers Routes:** add the route `*/*` → Worker `customattempt-1`, so
   custom hostnames reach the app.
4. **API token:** My Profile → API Tokens → Create. Permissions:
   Zone → SSL and Certificates → Edit; Zone → Zone → Read. Scope: the
   goyunir.com zone.
5. **Worker secrets:** add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`
   (Overview → Zone ID). `CUSTOM_DOMAIN_CNAME_TARGET` is optional; the
   default is `stores.<root>`.
6. Then the end-to-end proof runs with a real domain: connect → records →
   live → main address → disconnect.

### As built (differences from the plan above)
- **Ownership is proven twice:** the CNAME (Cloudflare) AND a TXT record
  `_store-verify.<host>` holding a per-claim token. A domain serves only
  when both hold, so a dangling CNAME cannot be claimed by another store.
- **Caps are plan data** (`plans.custom_domain_limit`): Free 1, Growth 3,
  Scale unlimited.
  - On a plan change and on every listing, domains above the cap are
    released, newest first, keeping the main address.
  - Cloudflare's hostname is deleted first, so nothing dangles.
- **Primary domain:**
  - every other address of the store 301s to it (same path), and the
    canonical tag follows;
  - GOYUNIR's www. mirror keeps serving, with a canonical tag to its primary
    (`PLATFORM_STOREFRONT_HOST`).
- **HTTPS only** on every host (middleware).
- **The old admin-only domain panel is retired** (its route answers 410).

## Owner decisions (answered 2026-09-30)
1. **Custom domains:** every plan, with caps as above and verified payments
   required.
2. **Order:** subdomain first, then custom domains. Both built.
3. **www.goyunir.com:** keeps serving GOYUNIR's store, canonical to the
   primary address. When custom domains are live, dogfood them by
   connecting GOYUNIR's own domain as primary.
