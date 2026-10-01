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

### Owner setup (one time, about 30 minutes)
1. Enable Cloudflare for SaaS on the zone.
2. Create the fallback origin (`stores.<root>`).
3. Add a Worker route for custom hostnames.
4. Create an API token scoped to SSL and Certificates + Custom Hostnames.

## Decisions for the owner
1. **Custom domains:** on every plan (recommended), or Growth and Scale only?
2. **Build order:** subdomain first (recommended: smaller, no infrastructure),
   then custom domains.
3. **www.goyunir.com:** it still mirrors GOYUNIR's store, as shop. did.
   Redirect it to goyunir.goyunir.com too, or keep it?
