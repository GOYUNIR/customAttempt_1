# Moving the platform off goyunir.com: SUPERSEDED for the move by BOOTSTRAP-RUNBOOK.md

> 2026-10-02: the owner chose a FRESH INSTALL on new accounts (BOOTSTRAP-RUNBOOK.md). This file describes the earlier plan (same accounts, new domain). Its check, `scripts/verify-domain-migration.ts`, is still the right tool for verifying the new domain on move day (runbook §7).


The platform is borrowing goyunir.com. Eventually the platform gets its own
name and domain (written NEWROOT below; not chosen yet), and goyunir.com goes
back to being GOYUNIR's own store domain. Nothing is hardcoded to a specific
new name.

## The move in three steps (when NEWROOT exists)

1. **Set the value.** `npx tsx scripts/set-platform-domain.ts NEWROOT --name "<Name>"`
   - It rewrites everything domain-shaped in wrangler.jsonc from one value:
     routes (the old routes are kept), root, old-root list, Turnstile host,
     support address, sink domain, GOYUNIR's interim address, and the name.
   - Commit and push (deploys).
2. **Do the dashboard steps** below, in order. The sending domain goes **add,
   verify, flip, remove**: never a moment without a verified sender.
3. **Check it.** `npx tsx scripts/verify-domain-migration.ts NEWROOT --old goyunir.com --goyunir-domain goyunir.com`
   - It covers DNS (zone, apex, wildcard, proxied), the Worker on every kind of
     host, HSTS and CSP, cookies, Turnstile, Stripe webhooks and their events,
     Supabase Auth (with `SUPABASE_ACCESS_TOKEN`), media, links in email,
     support@ MX, DMARC, the Resend domain and sender, the old-address 301s,
     and GOYUNIR's own domain.
   - Repeat until every line is PASS or checked by hand.
   - **Rehearsed 2026-10-01 against goyunir.com:** 23 pass, 3 by hand, 1 real
     finding (Resend's `rsend` CNAME was missing; see RELEASE-PLAN.md §5).

**Lesson from the rehearsal:** the proxied wildcard `*.<root>` answers for ANY
missing name. A forgotten email record (DKIM, the `rsend` CNAME, `send.` MX)
therefore resolves to Cloudflare instead of failing loudly. On NEWROOT, add
every email record explicitly, as **DNS only** (grey cloud).

## What depends on the platform domain today
| Item | Where | Today |
|---|---|---|
| Platform root (portals, store subdomains, cookies, invite links, legal text) | `PLATFORM_ROOT_DOMAIN` | goyunir.com |
| Platform name (marketing chrome, sign-in email) | `PLATFORM_NAME` | GOYUNIR |
| Worker routes | wrangler.jsonc `routes` (`<root>/*`, `*.<root>/*`) | goyunir.com zone |
| Portal hosts and their cookies | derived: `admin.` / `app.` / `sales.<root>` (`cookieDomainForPortal`) | per-host cookies |
| Marketing on the bare root | `PLATFORM_MARKETING_ROOT=true` | goyunir.com |
| GOYUNIR's store address | `PLATFORM_STOREFRONT_HOST`, `STOREFRONT_LEGACY_HOSTS`, `STOREFRONT_REDIRECT_HOSTS` | goyunir.goyunir.com (+ www., 301 from shop.) |
| Merchant stores | derived: `<slug>.<root>` | e.g. demo.goyunir.com |
| Support inbox | `SUPPORT_EMAIL` + Cloudflare Email Routing | support@goyunir.com |
| Email sender | `RESEND_FROM` / `TENANT_EMAIL_FROM` / `EMAIL_FROM` + Resend domain (SPF, DKIM) + DMARC | notifications@goyunir.com |
| Media URLs | `MEDIA_S3_PUBLIC_BASE_URL` | https://media.goyunir.com/media/r2 |
| Stripe webhooks (platform, Connect) | Stripe dashboard endpoints + their signing secrets | https://goyunir.com/api/stripe/webhook, /connect-webhook |
| Stripe return URLs (Connect onboarding, plan billing, checkout) | derived from `<root>` / the request host | automatic |
| Platform legal pages | derived from `PLATFORM_ROOT_DOMAIN` + `getPlatformName()` | automatic |
| Internal names (not visible to shoppers) | cookie `goyunir_admin_device`, storage keys `goyunir-*`, `GOYUNIR_STORE_SUITE` | **CODE**, optional: rename at the move, since everyone signs in again anyway |

## Before the move (one-time code work: DONE 2026-10-01)
1. **Old-root redirect: BUILT** (`oldRootRedirect`, lib/edge-router.ts; 11
   unit tests).
   - `PLATFORM_OLD_ROOT_DOMAINS` (a list): `<label>.<old root>` 301s to
     `<label>.<NEWROOT>`, path and query kept, page loads only. `/api/*` keeps
     answering, so an in-flight checkout return or an old email's API link
     never breaks.
   - The old apex and www are NOT redirected: they become GOYUNIR's own store
     domain.
   - Old Stripe webhook URLs on the old apex stop being platform routes once
     it is GOYUNIR's custom domain. So the new endpoints must be live first
     (Stripe sends every event to every endpoint, and the dedupe handles the
     overlap); delete the old endpoints after.
2. **Proof scripts: DONE.** They read the root from wrangler.jsonc
   (`scripts/proof-config.ts`, or `PROOF_ROOT_DOMAIN`), so after step 1 of the
   move they run against NEWROOT unchanged.
3. **Media URLs: DECIDED (owner, 2026-10-01), and the code is DONE.**
   - **`media.goyunir.com` keeps answering forever.** Never remove its route
     or DNS, even after the move.
   - **Photos are stored as domain-free keys** (`media:tenants/<id>/products/<file>`),
     resolved against `MEDIA_S3_PUBLIC_BASE_URL` when read
     (`lib/media-key.ts`):
     - written at one place, `lib/catalog-write.ts` (a URL on our media host
       becomes its key);
     - read at one place, `lib/postgres-catalog-read.ts` (a key becomes a URL).
       Every reader (storefront, dashboard, emails) sees URLs.
   - **Older photos stay as stored.** The 12 photos saved before this (the
     original store and the demo) are full `media.goyunir.com` URLs and are
     served as they are. Each one becomes a key the next time its product is
     saved, so no data migration is needed.
   - **On the day:** set `MEDIA_S3_PUBLIC_BASE_URL` to the new media host
     (the same R2 bucket behind it). Every key-stored photo follows
     automatically, and the older URLs keep working because
     `media.goyunir.com` stays up.
   - **Isolation:** a key must pass a strict check (no `..`, no empty or `.`
     segments, letters, digits and `/._-` only). A new photo must be under
     the saving store's own folder. Proof: `tests/media-key.test.ts`,
     `tests/merchant-routes.test.ts`, live `scripts/verify-merchant-photos.ts`
     ("Stored as a domain-free key").

## The move, in order
1. **Add the NEWROOT zone to Cloudflare.** Proxied DNS for the apex and a
   wildcard (`*`).
2. **Email first, so nothing goes out unauthenticated:**
   - Cloudflare Email Routing for `support@NEWROOT`;
   - **onboard NEWROOT for SENDING with every provider that is active** in
     `email_provider_plans`: Cloudflare Email Service (the primary: onboard
     the domain to Email Service) AND Resend (the fallback: verify the domain,
     SPF and DKIM). Resend's free plan allows only ONE verified sending domain,
     so moving it to NEWROOT means removing goyunir.com there (or Resend Pro);
   - add a DMARC record (`v=DMARC1; p=none`, tighten later);
   - send a test to Gmail through EACH provider and check SPF/DKIM/DMARC all
     PASS ("Show original") and that it lands in the inbox.
   - `EMAIL_SINK_DOMAINS` (the proofs' never-mailed domain, today
     `proof.goyunir.com`): may stay, or move to `proof.NEWROOT`; it needs no
     DNS and must never get an MX record.
3. **Worker routes:** add `NEWROOT/*` and `*.NEWROOT/*` ALONGSIDE the
   goyunir.com routes (both zones served during the transition). Deploy.
4. **Stripe:**
   - add new webhook endpoints at `https://NEWROOT/api/stripe/webhook` and
     `/connect-webhook`, with the same events as today (platform:
     `checkout.session.*`, `payment_intent.succeeded`, the five plan-billing
     events; Connect: `account.updated`, `checkout.session.*`,
     `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`);
   - store their signing secrets;
   - keep the old endpoints until the cut-over is verified, then delete them;
   - do it in test mode first, then live.
5. **The config flip (one deploy):**
   - `PLATFORM_ROOT_DOMAIN=NEWROOT`, `PLATFORM_NAME=<new name>`;
   - `SUPPORT_EMAIL`, `RESEND_FROM` / `TENANT_EMAIL_FROM`;
   - `MEDIA_S3_PUBLIC_BASE_URL` to the new media host (photos stored as keys follow it; media.goyunir.com stays up for older URLs);
   - `PLATFORM_OLD_ROOT_DOMAINS=goyunir.com`;
   - wrangler.jsonc routes for NEWROOT.

   Effects:
   - Portals move to `admin.` / `app.` / `sales.NEWROOT`. Cookies are per
     host, so **every staff and merchant session ends**: tell users first.
   - Merchant stores move to `<slug>.NEWROOT`; old addresses 301 there (item 1
     above).
   - Invite links already sent point at the old host: re-issue any pending
     invites after the flip, or keep the old portal hosts redirecting.
6. **goyunir.com becomes GOYUNIR's own domain (dogfooding the primary-domain
   model):**
   - Point `PLATFORM_STOREFRONT_HOST` at `www.goyunir.com` (or the apex).
   - Turn off `PLATFORM_MARKETING_ROOT` for goyunir.com; marketing lives on
     NEWROOT.
   - Connect goyunir.com to the GOYUNIR store as its primary domain; then
     `goyunir.NEWROOT` and every other GOYUNIR address 301 to it, and the
     canonical tag follows automatically.
7. **Legal pages:** text updates automatically from config. Add the platform's
   legal entity name at legal review.
8. **Verify, all on NEWROOT:**
   - merchant isolation, core journey, purchase (test4 and the demo store),
     plan billing, photos, store address;
   - one real email to Gmail (SPF/DKIM/DMARC pass);
   - an old store link → 301 → new address.
9. **Keep the old-root 301s for at least 12 months.** Never delete DNS
   records that still answer for a merchant, so nothing dangles.

## Third parties to update the same day
- **Cloudflare Turnstile (signup's human check):** the widget only issues
  tokens on its listed hostnames (today `goyunir.com`). Add NEWROOT to the
  widget's hostname list (Cloudflare dashboard → Turnstile → the existing
  widget → Hostname management; do NOT create a new widget, the site key in
  wrangler.jsonc stays), and add NEWROOT to `TURNSTILE_EXPECTED_HOSTNAMES`
  (the server refuses tokens solved on any other host). Without both, signup
  fails closed on the new domain.
- Supabase Auth: site URL and redirect allow-list, if password-reset links
  are used.
- Mapbox: token URL restrictions.
- Google / Stripe / Resend dashboards: any allowed-origin lists.
- Social profiles and Stripe business profiles that link to the old
  addresses.
