# Moving the platform off goyunir.com (PLAN ONLY, not performed)

The platform is borrowing goyunir.com. Eventually the platform gets its own
name and domain (written NEWROOT below; not chosen yet) and goyunir.com goes
back to being GOYUNIR's own store domain. Everything below is configuration
unless marked **CODE**. Nothing is hardcoded to a specific new name.

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

## Before the move (one-time code work, not built)
1. **CODE: old-root redirect.**
   - Config: `PLATFORM_OLD_ROOT_DOMAINS` (a list). A request to
     `<slug>.<old root>` 301s to `<slug>.<NEWROOT>` with path and query kept,
     for page loads only. The same rule as `retiredHostRedirect`.
   - Without this, every merchant's printed links and emails break on the
     day of the move.
2. **CODE: proof scripts.** They name `https://app.goyunir.com` etc. Read the
   root from `PLATFORM_ROOT_DOMAIN` instead, so every proof can run against
   NEWROOT on the day.
3. **Decide the media URLs.** Product photos are stored as absolute URLs on
   `media.goyunir.com`. Either:
   - keep `media.goyunir.com` serving forever (simplest; it is just a Worker
     path), or
   - rewrite the stored URLs. That is a data migration, destructive, and the
     owner approves the SQL first.

   New uploads use whatever `MEDIA_S3_PUBLIC_BASE_URL` says; existing photos
   stay valid on edit (a product may keep the photos it already has).

## The move, in order
1. **Add the NEWROOT zone to Cloudflare.** Proxied DNS for the apex and a
   wildcard (`*`).
2. **Email first, so nothing goes out unauthenticated:**
   - Cloudflare Email Routing for `support@NEWROOT`;
   - verify NEWROOT in Resend (SPF, DKIM);
   - add a DMARC record (`v=DMARC1; p=none`, tighten later);
   - send a test to Gmail and check SPF/DKIM/DMARC all PASS.
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
   - `MEDIA_S3_PUBLIC_BASE_URL` (if moving media);
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
- Supabase Auth: site URL and redirect allow-list, if password-reset links
  are used.
- Mapbox: token URL restrictions.
- Google / Stripe / Resend dashboards: any allowed-origin lists.
- Social profiles and Stripe business profiles that link to the old
  addresses.
