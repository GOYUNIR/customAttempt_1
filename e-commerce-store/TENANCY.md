# TENANCY — which store is this request for?

> ## ▶ RESUME HERE (2026-09-25)
>
> Design written; **phase 1 in progress.** Owner chose this work (option "B"
> in CONNECT.md) after the Connect money path was proven on test4. See §5 for
> the phase list.

## 1. The problem

The storefront has always served one store. Every storefront read and every
checkout gets its tenant from `ensureDefaultTenant()`: about 100 call sites in
36 files. A second merchant's customers can't reach their own catalog or
checkout at all.

What production does today:

- **DNS is a wildcard, and the worker claims `*.goyunir.com/*`.** So
  `test4.goyunir.com` and `nosuchstore-xyz.goyunir.com` both return 200 and
  serve the *default* store, working checkout included (checked 2026-09-25).
- **Our own subdomains:**
  - `www`, `api` and `shop` all serve the default store;
  - `app`, `admin` and `sales` are the portals;
  - `media` is the image host.
- **Signup already reserves** `shop`, `admin`, `www` and 14 other labels
  (a list local to the signup route). T4 replaces it with one shared rule that
  also covers the legacy-host setting, so the list and the resolver can't
  drift.
- **Tenant-scoped today:**
  - the Postgres catalog (`readProductsFromPostgres(tenantId)`);
  - per-tenant store config;
  - orders;
  - inventory levels;
  - billing;
  - Connect.
- **Global today, in KV** (the `store_kv` table has one namespace):
  - raffle entries (`entries:*`);
  - the sales ledger (`ARCHIVE_LEDGER_KEY`), which is also the per-email
    purchase cap;
  - live-state mirrors;
  - promo codes;
  - the KV catalog fallback;
  - store config;
  - analytics.

  Two stores would read and write each other's.

## 2. Decisions

Each is the conservative choice. The ones marked **(owner)** can be changed.

| # | Decision | Why |
|---|---|---|
| T1 | A merchant's address is **`<slug>.<PLATFORM_ROOT_DOMAIN>`**, plus their own custom domain once Cloudflare reports it `active` (00010). | Wildcard DNS and the worker route already exist, so no DNS work is needed. |
| T2 | **The default (legacy) store's hosts are listed, never inferred:** the `STOREFRONT_LEGACY_HOSTS` setting (comma-separated; today `shop`, `www`, `api` under the root). Hosts are checked **before** any slug, so no signup can claim them. **(owner)** which hosts stay. | Nothing hardcoded, and no slug can take over a live address. |
| T3 | **An unknown subdomain is a 404**, not the default store. | Today a typo shows your store and lets someone buy from it. A request meant for store X must never be served or charged as store Y. |
| T4 | **Reserved labels can't be slugs:** the portal and system labels (`admin`, `app`, `sales`, `www`, `api`, `media`, `mail`, `shop`, `default`, …), plus every label in T2. Enforced at signup. Existing slugs are checked (none collide today). | Same reason as T2. |
| T5 | **The tenant is resolved from the `Host` header on the server**, with a short per-isolate cache. It is never taken from a client-supplied header, query or body. | A client could otherwise pick whose store it is buying from. |
| T6 | **With no root domain configured** (single-domain deployments, local dev), every host is the default store. | Behaviour for such deployments stays exactly as today. |
| T7 | **A non-default tenant never touches global KV keys.** Its KV state lives under a tenant prefix; the default tenant's keys are unchanged, so no data migration. | Isolation without risking the live store's data. |
| T8 | **A non-default tenant never falls back to the KV catalog.** Postgres or nothing. | The fallback *is* the default store's catalog. |
| T9 | **A non-default tenant sells only through its own connected account** (routing rule, CONNECT.md §3). No account, or onboarding not finished, means checkout is refused. | Already the rule; stated here so no phase forgets it. |

## 3. Resolution order (pure function, `lib/storefront-tenant.ts`)

1. No root domain configured → **default** (T6).
2. Host is the root itself → **marketing**. Not a store.
3. Host is in `STOREFRONT_LEGACY_HOSTS` → **default** (T2).
4. Host is `<label>.<root>`:
   - `admin`, `app` or `sales` → **portal**. Not a store.
   - any other reserved label → **not found**;
   - a tenant with that slug → **that tenant**;
   - otherwise → **not found** (T3).
5. Anything else (outside the root): a tenant whose `custom_domain` is that
   host and `active` → **that tenant**. Otherwise, `localhost`/`127.0.0.1` →
   **default**. Otherwise → **not found**.

## 4. What changes, by surface

- **Read path:** `/api/store`, the home/product/catalog pages, and the
  `/api/store` prefetch. The tenant comes from the host, and the catalog from
  that tenant's Postgres rows.
- **Checkout, direct:** the tenant from the host; the charge routed by
  `chargeRouteForTenant`; for a connected tenant, a direct charge on their
  account with `application_fee_amount` from `platformFeeForCharge`. Then the
  order row, then `recordBillingCharge`. The per-email cap and the ledger are
  tenant-scoped.
- **Checkout, cart:** the Session on the merchant's account. Its
  `checkout.session.completed` arrives at the **Connect** endpoint, so this
  path waits for that endpoint's registration (owner confirmation,
  CONNECT.md).
- **Raffle entry, draws, waitlist, trigger-drop:** tenant-scoped entries, and
  cards saved on the merchant's account. Last, with the cutover rule in
  CONNECT.md §4.
- **Customer accounts, auth, rewards, analytics:** per tenant. Accounts are the
  largest piece: today a customer account is global.
- **Admin / merchant app:** already acts on `resolveActingTenantId`
  (impersonation). A merchant's own login acting on their own tenant is a
  separate piece of work.

## 5. Phases (each verified live before the next)

1. **Resolver + reserved slugs + read path.**
   - Built: the pure resolver with tests, `STOREFRONT_LEGACY_HOSTS`, signup
     rejecting reserved slugs, and `/api/store` plus the pages serving the
     host's tenant.
   - Verify:
     - `shop.goyunir.com` is unchanged: the mobile flows still reach Stripe;
     - `test4.goyunir.com` serves test4's own (empty) catalog;
     - `nosuchstore-xyz.goyunir.com` returns 404;
     - `admin.` and `app.` are unchanged.
2. **Direct checkout for a connected tenant.** A real charge through
   `test4.goyunir.com`. Expect it on test4's account, fee =
   `platformFeeForCharge`, an order row with the fee, and exactly one
   `tenant_billing_charges` row. Plus the refund and dispute checks from
   CONNECT.md §7 through the real route.
3. **Cart**, after the Connect endpoint is registered.
4. **Raffle, draws, waitlist, trigger-drop.**
5. **Customer accounts, rewards, analytics.**

The default store must keep working through every phase: the mobile flows
and a real test checkout on `shop.` after each deploy.
