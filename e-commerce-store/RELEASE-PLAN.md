# Release plan: the critical path to public launch

## WAITING ON ME (the owner), in priority order

1. **Resend DNS record:** Cloudflare DNS, CNAME `rsend` → `send.forge.rmta.net`, DNS only (grey cloud); then Resend → Domains → Verify. This unblocks the stranger journey.
2. **Stranger-journey address** (`STRANGER_EMAIL`): an inbox you control. Plus-addresses work.
3. **R2 API token replacement before 2026-10-16** (§1). Send me the new keys.
4. **Stripe live activation and the Connect platform profile** (§3).
5. **Supabase Pro ($25/month) for backups:** yes or no (§7).
6. **Uptime monitor:** sign up and add the monitors listed in §10.
7. **Signup WAF rule** (§12).
8. **Platform name and domain** (§2); then the move runs from §13.
9. **Legal review** (§4).
10. **Workers Paid**, 5–7 days before opening signup (§5 runbook).

Written 2026-10-01. Owner: **you** (the owner), **me** (the coding agent), or
**both**. Lead time is the elapsed wait (review, propagation, warm-up), not the
work itself. The longest waits come first, because they decide the date.

## The critical path at a glance

| # | Item | Owner | Lead time | Blocked by | Status |
|---|---|---|---|---|---|
| 1 | R2 API token replacement (expires **2026-10-16**) | you, then me | minutes | nothing | **do this week** |
| 2 | Platform name and domain chosen and registered | you | 1 day (DNS) | nothing | open |
| 3 | Stripe live activation + Connect platform profile | you | 1–3 business days (can be longer if Stripe asks for more) | 2 is helpful, not required | open |
| 4 | Legal review of Terms and Privacy; legal-entity name | you (+ lawyer) | 1–2 weeks | 2 (the domain goes in the text) | draft live, notice shown |
| 5 | Workers Paid + Cloudflare Email Service warm-up | you, then me | 5–7 days of warm-up | 2 (sending domain) | deferred by owner |
| 6 | Secret-rotation pass | both | 1 hour | 1 | open |
| 7 | Supabase plan, backups, restore check | you (cost), me (check) | 1 hour | nothing | open |
| 8 | Live webhooks (platform + Connect) | me (with your keys) | minutes | 3 | test-mode done |
| 9 | Stripe Tax on plan invoices | you | days per registration | 3 | code ready (flag) |
| 10 | Uptime monitoring and error alerts | you (sign-up), me (wiring) | minutes | nothing | open |
| 11 | Support runbook (below) | me (written), you (inbox) | none | support@ inbox | written |
| 12 | Cloudflare WAF rate-limit rule for signup | you | minutes | nothing | steps below |
| 13 | Domain move (if the platform domain is not goyunir.com) | both | 1 day | 2, 5 | executable (DOMAIN-MIGRATION.md) |
| 14 | Launch cleanup (proof data) | done 2026-10-02 | - | - | scripts/launch-reset.ts (dry run default; re-run --apply at launch) |
| 15 | Stranger journey on the real email path | me | minutes | Resend reset, your address | waiting |
| 16 | Release gate GO, then switch signup on | me, you confirm | 15 minutes | all above | gate built |

## 1. R2 API token (expires 2026-10-16): do first

The media bucket's S3 credentials (`MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`) expire on 2026-10-16. When they do, **photo uploads stop**. Photos people already uploaded keep showing, because reads go through the Worker's R2 binding.

1. Cloudflare dashboard → **R2 Object Storage** → **Manage API tokens** (top right) → **Create Account API token**.
2. Name: `media-uploads-<platform>`. Permissions: **Object Read & Write**.
3. **Specify bucket(s):** only the media bucket (the `MEDIA_BUCKET` value).
4. **TTL:** *Forever*, or a date at least a year out with a calendar reminder. Client IP filtering: none.
5. Create, then copy the **Access Key ID** and **Secret Access Key** (shown once).
6. Give them to me through the same channel as other credentials. I set both Worker secrets and your `.env.local`, then run `verify-r2-roundtrip.ts` and the photo proof.
7. Once both pass, **delete the old token** on the same page.

## 2. Platform name and domain

- **You:** choose and register the domain. Add it to Cloudflare as a zone (Free plan) and point the nameservers there.
- **Me:** the move is mechanical (see 13).
- Signup, Turnstile, the email sending domain and the legal text all follow the domain. Launching on goyunir.com and moving later also works: everything is built for it.

## 3. Stripe live mode: what it needs

**Account activation** (Stripe Dashboard → "Activate payments"), all yours:
- the business type and **legal entity name**, address and tax ID (EIN or SSN for a sole proprietor);
- a representative's identity (name, date of birth, address, last 4 of SSN, possibly an ID upload);
- the bank account for payouts;
- the public website (the platform's marketing domain). Stripe reviews it, so Terms, Privacy, pricing and a contact address must be visible; they are.
- a statement descriptor (up to 22 characters, the platform name) and a support email or phone.

**Connect platform profile** (Settings → Connect):
- **Platform profile:** "A platform where independent merchants sell their own products. Each merchant has its own Stripe account; payments are direct charges on that account; we take an application fee per sale, or a monthly subscription." Merchant of record: the connected account. Countries: the ones you'll onboard.
- **Branding** (name, icon, color): this is what merchants see in Stripe's onboarding, so it waits on the platform name.
- Account settings match the code: merchants get full Stripe Dashboards, and **Stripe collects fees and covers losses** (`lib/connect.ts`). That keeps the platform's own risk review light.

**Then, me (with the live keys you paste into the Setup Wizard):**
- the live webhook endpoints (8 below);
- the Growth plan's live product and price, so plan data points at live prices;
- the Customer Portal settings for plan billing.

**Lead time:** often same-day, but allow 1–3 business days. If Stripe asks for documents, that's on you.

## 4. Legal review and the legal-entity name

- **Built (2026-10-01):** the operator's name is config.
  - `PLATFORM_LEGAL_ENTITY` (e.g. "Example Ltd") is used in Terms and Privacy; until it's set, the operator is named by the domain.
  - The draft notice stays on both pages until `PLATFORM_LEGAL_REVIEWED` holds the review date.
- **Your lawyer must set:** governing law and the venue for disputes (currently "will be set out after legal review"), the refund policy for plan fees, and the processor list (Stripe, Supabase, Cloudflare, Resend, plus any added provider).
- Terms version: `signup.terms_version` (policy data) is logged with every signup. Bump it when the reviewed text goes live.

## 5. Email path and limits

- **Today:** Resend Free is the only live path: 100 a day, 3,000 a month, one verified sending domain. Signup may use 40% of a day (`email.signup_daily_share_percent`), so **at most 40 signup emails a day** right now.
- **Before launch:** fix the failed Resend DNS record. Resend shows goyunir.com as `partially_failed` because the `rsend` CNAME is missing (the proxied wildcard `*.goyunir.com` answers instead).
  - Cloudflare DNS → Add record → **CNAME**, name `rsend`, target `send.forge.rmta.net`, **Proxy status: DNS only** (grey cloud).
  - Then Resend → Domains → goyunir.com → **Verify**.
- **Launch:** Workers Paid (you plan 5–7 days before opening signup), then the runbook below.
- **Fallback:** Resend Pro ($20/month: 50,000 a month, no daily cap), only if Cloudflare's measured limit is too low. That's a data edit in `email_provider_plans`.

### Workers Paid day: runbook (about 30 minutes)

1. **You:** Cloudflare dashboard → Workers & Pages → **Plans** → Workers Paid ($5/month).
2. **You:** dashboard → **Email Service** → Email Sending → **Onboard domain** → the platform domain.
   - Cloudflare adds the sending records (SPF and DKIM on its sending subdomain) to the zone. Accept them.
   - Keep the existing DMARC record, and add one if there's none: TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:<support address>`.
3. **You:** dashboard → Email Service → Email Routing → **Destination addresses** → add and verify your own inbox. This is the "verified address" for the first test, and sends to it are free.
4. **Me:**
   - add the binding to `wrangler.jsonc`: `"send_email": [{ "name": "EMAIL" }]`;
   - set the Cloudflare plan row active: `update email_provider_plans set active = true where provider = 'cloudflare'`;
   - commit and push (deploys).
5. **Me:** one test send through Cloudflare (priority 10, before Resend) to your verified address:
   - a sign-in code through the real staff sign-in, with your account;
   - confirm in `email_send_counts` that it counted on `cloudflare`, not `resend`.
6. **You:** in Gmail, open it → ⋮ → **Show original**. Read out the three lines (SPF, DKIM and DMARC must each say PASS) and whether it landed in Inbox, Promotions or Spam.
7. **You:** if the dashboard doesn't show the daily sending limit, open a ticket (Support → Get help → Email Service):
   > "We are launching a commerce platform on account `<account id>`, sending transactional email (sign-in codes, order confirmations, signup verification) from `<domain>` via the Workers `send_email` binding. What is our current daily sending quota for Email Service, where can we see it, and how does it ramp? We expect about N emails/day at launch, rising to M. Please raise the limit if possible."
8. **Me:** enter the measured limit:
   - `update email_provider_plans set daily_limit = <n> where provider = 'cloudflare'`;
   - signup then gets 40% of it automatically;
   - re-run the release gate (record mode, no real mail) and the email unit tests.
9. **Watch the first days:** `email_send_counts` per provider per day. Resend takes over automatically if Cloudflare errors or fills up.

## 6. Secret-rotation pass

Rotate every credential that has ever been pasted into a chat or a document. These are the secrets the platform uses (names only):

| Secret | Where it lives | How to rotate |
|---|---|---|
| Supabase secret key (`SUPABASE_SERVICE_ROLE_KEY`) | Worker secret, `.env.local` | Supabase → Project Settings → **API Keys** → create a new **secret key** (`sb_secret_…`), give it to me, I swap it in; then **revoke the old one**. Don't rotate the legacy JWT secret: that also invalidates the anon key and signs everyone out. |
| R2 access keys (`MEDIA_S3_*`) | Worker secrets, `.env.local` | Section 1 |
| Cloudflare API token (custom domains) | not deployed yet | Dashboard → My Profile → API Tokens → **Roll** (or delete and create one scoped to the zone's SSL for SaaS + DNS edit) |
| Turnstile secret (`TURNSTILE_SECRET_KEY`) | Worker secret, `.env.local` | Turnstile → the widget → **Rotate secret key** → give me the new one; the site key stays |
| Resend API key | database (Setup Wizard) | Resend → API Keys → create (sending access, the domain only) → paste it into the Setup Wizard → delete the old key |
| Stripe keys | database (Setup Wizard) | Test keys: roll in the Stripe Dashboard if they were ever shared. Live keys are new at activation; never paste them in chat, use the Setup Wizard. |
| Stripe webhook signing secrets | database | Re-issued with the live endpoints |
| `CRON_SECRET`, `ADMIN_BASIC_AUTH_PASSWORD`, `ADMIN_LAUNCH_SECRET` | Worker secret / `.env.local` | I generate new random values and set them |
| Upstash Redis tokens, `VERCEL_OIDC_TOKEN` | `.env.local` only (production uses Supabase storage) | Not used in production: delete the Upstash database (or rotate its token) and remove both from `.env.local` |
| Supabase CLI access token | your Windows Credential Manager | Supabase → Account → Access Tokens: create a new one, `supabase login` again, revoke the old |

**Order:** R2 first (it's expiring), then Supabase, Turnstile and Resend, then the rest. After each one I re-run the release gate.

## 7. Supabase plan, backups, restore check

- **The Free plan has no downloadable backups**, and it pauses projects inactive for a week (production traffic prevents that).
- **Recommended before launch: Supabase Pro, $25/month.** It adds daily backups kept 7 days, no pausing, and more headroom. Point-in-time recovery is a paid add-on and not needed at launch.
- **Restore check (me, after Pro):**
  1. restore yesterday's backup into a **new** project (Database → Backups → Restore to new project);
  2. point a local copy of the release gate at it with `PROOF_ROOT_DOMAIN` and `.env` overrides;
  3. check that order and tenant counts match, then delete the copy.
  - Free alternative: a nightly `pg_dump` from GitHub Actions to a private R2 bucket, using the database password, restored into a local Postgres to check. Cost $0, but it needs the password from you.

## 8. Live webhooks (after Stripe activation)

Stripe Dashboard (live mode) → Developers → Webhooks → **Add endpoint**:

- **Platform:** `https://<root>/api/stripe/webhook`, "Your account". Events:
  - checkout: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`;
  - plan billing: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
- **Connect:** `https://<root>/api/stripe/connect-webhook`, "Connected accounts". Events:
  - `account.updated`, `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`.
- Paste both signing secrets into the Setup Wizard. Then `verify-domain-migration.ts <root>` checks both endpoints and their events (it reads Stripe).

## 9. Stripe Tax on plan invoices

- **You:** Stripe Dashboard → Tax:
  - head office address;
  - default product tax code **Software as a service**;
  - **registrations** where you're required to collect (Stripe's monitoring tab shows thresholds).
- **Me:** set `PLAN_BILLING_AUTOMATIC_TAX=true`. Growth checkout then collects the address and tax. I prove it with a test-mode subscription.
- Merchants' own sales tax stays theirs, in their own Stripe accounts (the Terms say so).

## 10. Uptime and errors (free first)

**Health endpoint (built 2026-10-02):** `GET https://<root>/api/health`.
- It returns 200 `{"status":"ok","db":"ok","ms":…}`, or 503 `degraded` when the database doesn't answer within 2 seconds.
- It reveals nothing else, and is never cached.

**UptimeRobot (Free: 50 monitors, 5-minute checks). Add these monitors:**

| Monitor | Type | URL | Expect | Interval |
|---|---|---|---|---|
| Health (Worker + database) | HTTP(s) – keyword | `https://<root>/api/health` | status 200 **and** keyword `"status":"ok"` | 5 min |
| Marketing site | HTTP(s) | `https://<root>/` | 200 | 5 min |
| Merchant sign-in | HTTP(s) | `https://app.<root>/app/login` | 200 | 5 min |
| A merchant storefront | HTTP(s) | `https://demo.<root>/` | 200 | 5 min |
| Signup API | HTTP(s) – keyword | `https://<root>/api/signup/merchant` | 200 and keyword `siteKey` | 15 min |

**Alert path:**
1. UptimeRobot alert contact: email to the support address (Email Routing forwards it to you). Optionally, the UptimeRobot mobile app's push notifications.
2. Alert after 2 failed checks (avoids one-off blips).
3. When "Health" is down but "Marketing site" is up, the database is the problem (Supabase status page). When everything is down, it's the Worker or DNS (Cloudflare status page, then Workers → customattempt-1 → Logs).

- **Uptime:** UptimeRobot Free (50 monitors, 5-minute checks) or Better Stack Free (10 monitors, 3-minute checks), alerting by email to support@. Monitors:
  - `https://<root>/`;
  - `https://app.<root>/app/login`;
  - `https://<root>/api/health` (built: see above);
  - one merchant store page.
- **Errors:** Workers Logs are already on (`observability.enabled`; free, short retention). For alerts, Sentry's free plan (5,000 errors a month) needs a small SDK addition on Workers. That's half a day, and **post-launch** unless you want it before. Until then, the breaker alert and Stripe's own webhook-failure emails are the alarms.

## 11. Support runbook

- **support@:** Cloudflare Email Routing forwards `support@<root>` to your inbox. MX is verified for goyunir.com; send yourself a test before launch. The address shows on the dashboard checklist, the signup screens and in every store email's footer as the platform contact.
- **"Signup paused itself" alert:** the circuit breaker tripped (a signup flood).
  - Signup resumes by itself after `signup.breaker_pause_minutes`.
  - Look at `merchant_signups` (recent IPs and domains) and `audit_logs`.
  - If it's an attack, use the kill switch below.
- **Kill switches:**
  - **Signup off:** Worker secret `ALLOW_MERCHANT_SIGNUP=false` (`wrangler secret put`); I can do it, or you can in Cloudflare → Workers → customattempt-1 → Settings → Variables. It takes effect immediately; the form shows "contact us".
  - **One store:** suspend it (tenant `license_status`). Its storefront closes; its data stays.
  - **Email:** set a provider's plan row `active = false` and the chain skips it. All providers off means nothing sends; sign-in still shows the code screen, but no code arrives.
  - **Whole site:** maintenance mode (`MAINTENANCE_MODE=true`).
- **A merchant can't get a sign-in code:** check `email_send_counts` (is the day full?) and the provider dashboards. Then check `audit_logs` for their account.
- **A refund or dispute question:** it's in the merchant's own Stripe account. We see the refund status on the order (charge.refunded) and log disputes.

## 12. Cloudflare WAF rate limit for signup (Free plan: 1 rule)

1. Cloudflare dashboard → the platform domain's zone → **Security** → **WAF** → **Rate limiting rules** → **Create rule**.
2. **Rule name:** `Signup form`.
3. **If incoming requests match:** Field **URI Path**, Operator **equals**, Value `/api/signup/merchant`.
   - Use "equals", not "contains": `/api/signup/merchant/complete` (the email link) and the Stripe and Resend webhooks are untouched.
4. **With the same characteristics:** IP (fixed on Free).
5. **When rate exceeds:** 5 requests per 10 seconds.
6. **Then take action:** Block, for 10 seconds (fixed on Free).
7. **Deploy.** Tell me, and I'll check that the 6th quick request is blocked.
8. Repeat on the new zone after a domain move.

## 13. Domain move (when the domain exists)

Three steps:
1. `npx tsx scripts/set-platform-domain.ts <new-root> --name "<Name>"`, then commit and push.
2. The dashboard steps in DOMAIN-MIGRATION.md.
3. `npx tsx scripts/verify-domain-migration.ts <new-root> --old goyunir.com --goyunir-domain goyunir.com`, until every line is PASS or checked by hand.

Rehearsed on 2026-10-01 against goyunir.com: 23 pass, 3 for a dashboard look, and 1 real finding (the Resend DNS record in 5).

## 14. Launch cleanup

Done 2026-10-02 with `scripts/launch-reset.ts` (dry run by default; `--apply` backs up to launch-backups/ first, then deletes and verifies). Re-run it at launch: `npx tsx scripts/launch-reset.ts`, read the plan, then `--apply`. Stripe test leftovers: `scripts/stripe-test-cleanup.ts` (test keys only).

## 15. Stranger journey

It runs after Resend's daily reset (midnight UTC), with at most 3 real sends to the address you give me. Then signup goes back off and I report.

## 16. Go

`npm run release:gate` (about 15 minutes) must print **GO** before any deploy that touches money or identity. Then you confirm, I set `ALLOW_MERCHANT_SIGNUP=true`, and I watch the first signups.

## Speed (measured 2026-10-02, not on the path)

`npx tsx scripts/measure-speed.ts --runs 10` (throttled phone: 150ms RTT, 1.6 Mbps, 4x CPU; median, cold cache):

| Page | TTFB | LCP |
|---|---|---|
| Marketing home | ~0.4s | ~0.9s |
| Store home | ~0.5s | ~3.8s |
| Product page | ~0.6s | ~2.7s |
| Dashboard | ~0.4-1.1s | ~3.3s |

- Server work is small: store home ~200ms, marketing ~100ms above a static file. TTFB on this link swings 0.3-1.6s run to run, which is network, not code.
- Caching HTML would not move LCP, and every page that shows money or stock must stay uncached. `scripts/verify-no-stale-money.ts` (in the gate) proves a price change and sold-out reach checkout at once, while the catalog display may lag up to 10s.
- Two hint changes were measured with an interleaved A/B (`--ab`) and reverted: preloading /api/store, and preloading the first photos from the server. Neither gave a gain above the noise, and the photo preload made product pages ~700ms slower.
- The real cost is client-side: ~220KB of JS must download and hydrate before the storefront draws its hero, which is a CSS background. The fix is to render the storefront's first screen on the server, a refactor logged below.

## CSP plan (2026-10-02)

Evidence: `scripts/csp-scan.ts` loads 13 real pages (marketing, legal, two storefronts with home, product, catalog, account and login, the dashboard with every tab clicked, the admin and sales sign-ins) and records every violation. The policy has no report endpoint, so this scan is the report-only data. Result: one source on every page, Cloudflare Web Analytics' beacon (static.cloudflareinsights.com), now allowed in the report-only policy. Nothing else.

| Step | Directives | State |
|---|---|---|
| 1 | frame-ancestors, frame-src (Turnstile, Stripe), img-src, media-src, font-src, object-src 'none', base-uri | **Enforced 2026-10-02**. The scan runs in the release gate and fails on any enforced violation. |
| 2 | connect-src, form-action | Enforce after one clean scan with signup on (Turnstile) and one Stripe embedded-onboarding session. Both wait on the stranger journey. |
| 3 | script-src, style-src | Need nonces instead of 'unsafe-inline' (the layout's inline theme and prefetch scripts). That's a code change; until then enforcing them adds little, because 'unsafe-inline' allows the main attack. |

## After launch (logged, not on the path)

- A staging copy (second Worker on workers.dev, second Supabase project, Stripe test keys) so the release gate can keep running after live mode. Without it, purchase proofs can't run against live production.
- Sentry or similar error alerting.
- PLATFORM-IDENTITY beyond the release minimum:
  - admin.<root> is both the platform admin and GOYUNIR's admin;
  - GOYUNIR is still "the default tenant" in code;
  - internal names (`goyunir_admin_device` cookie, `goyunir-theme-json`).
- Discount codes are built and OFF on every plan (`plans.discount_codes_enabled`); turning them on for a plan is a one-row change.
- Storefront first screen rendered on the server (see Speed).
- The custom-domain real-domain proof.
