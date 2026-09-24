# Platform Architecture — Subdomain Tiers, Portability, Cost, Robustness

Audit + plan, evidence-backed against the code as of this pass. Opinionated: where there is a
clearly better call it is made here, not listed as an option.

Three findings reframe everything below, so they lead:

1. **`lib/adapters/` is dead code.** The vendor-abstraction layer exists and is imported by
   exactly 4 files: three are the adapter files re-exporting each other, one is
   `scripts/simulate-concurrency.ts`. Zero business-logic files use it. Meanwhile **16 files
   call Stripe directly** and **26 files call `supabaseRestFetch` directly**. The
   highest-leverage future-proofing move is not "build the wrapper" — it is "the wrapper
   exists, now make it the only way in, and fail the build when it is not."
2. **Four live Stripe charge sites have no idempotency key** (SEV-1 below). A real
   double-charge bug in the money path, not a theoretical risk.
3. **Product images are base64 data-URLs stored inside the catalog blob in Redis.** This is
   simultaneously the biggest cost landmine and the exact "entire catalog in one JSON column"
   anti-pattern the brief asks about.

---

## (a) Subdomain, routing, and auth plan

### The call: route groups + auth realms in ONE deployment. Not four apps.

The brief says tear out path-based routing. Agreed — but "ruthless" here does not mean four
Workers. The requirement that actually matters (internal admin/sales must not share a login
surface with merchant/consumer) is an **auth boundary, not a deployment boundary**. You get
100% of that security benefit from separate auth realms + host-scoped cookies + host-gated
routing in one deployment, without paying for four CI pipelines, four env-var sets, and
shared-library version skew. Splitting staff portals into their own Worker is a later,
trigger-based step (Phase F) — not a day-one cost.

What does get torn out: `app.site.com` and `admin.site.com` currently serve the **same**
`app/admin` route tree, differentiated only by a role check. That is one blast radius and one
login for two different trust tiers. Replace with real route groups:

| Host | Route group | Audience | Auth realm |
|---|---|---|---|
| `site.com` | `app/(marketing)` | public | none |
| `app.site.com` | `app/(merchant)` | merchant owners/staff | Merchant |
| `admin.site.com` | `app/(platform)` | our team | Staff |
| `sales.site.com` | `app/(sales)` | our sales team | Staff |
| `{merchant}.site.com`, custom domains | `app/(storefront)` | shoppers | Consumer |

Each group owns its `layout.tsx` (auth guard at the layout, not scattered per page), its own
login surface, its own nav. `middleware.ts` maps host to group and **rewrites**; a path that
does not belong to the host group 404s. No path leakage, no shared shell.

### Three auth realms, zero shared cookies

The current `PLATFORM_ROOT_DOMAIN` design gets cookie scoping right in spirit but has one
structural problem: any `Domain=.site.com` cookie is transmitted to **every** merchant
storefront host. Staff credentials must never travel to a host a merchant influences.

- **Staff realm** (`admin.` + `sales.`): dedicated IdP at `id.site.com`. Login happens there
  once; it mints a short-lived, host-scoped session per portal via redirect, using `__Host-`
  prefixed cookies (which forbid a Domain attribute, so they are host-locked by construction).
  Role is checked at mint time and on every request. A sales rep session cookie is
  cryptographically useless on `admin.site.com`. This is the only SSO in the system and it is
  staff-internal only.
- **Merchant realm** (`app.site.com`): own login, own `__Host-` cookie, valid nowhere else.
- **Consumer realm** (per storefront host): cookie scoped to that one storefront host. A
  shopper on merchant A must never hold a credential valid on merchant B. Today this is
  accidentally correct (host-only by default) — make it explicit and test it.

**The one legitimate cross-realm bridge** — the brief names it: a merchant previewing their own
storefront. Do NOT solve this with a shared cookie. Merchant clicks Preview in `app.site.com`,
server mints a 60-second single-use HMAC-signed token, redirect to
`{merchant}.site.com/__preview?token=...`, storefront exchanges it for a preview-scoped cookie
that reveals draft content and carries **no consumer identity**. One direction, time-boxed,
revocable.

### Fail closed

Today, if `PLATFORM_ROOT_DOMAIN` is unset every portal-isolation check silently becomes a
no-op. Correct for local dev, dangerous in production. Make it: unset + non-production equals
permissive dev mode; unset + production equals **boot error**. Isolation must never be off by
accident.

---

## (b) Vendor integrations needing an abstraction layer

Ranked by lock-in severity — what a migration would actually cost today.

### 1. Supabase / PostgREST — SEVERE, and deeper than it looks

The problem is not that we use Supabase. It is that **the data layer speaks PostgREST, not
SQL**. All 26 call sites build URL query syntax by hand. Migrating to raw Postgres/RDS is not a
connection-string change; it is rewriting query construction in 26 files.

Compounding it: **16 `auth.uid()` and 3 `auth.role()` calls in RLS policies** bind
authorization to Supabase GoTrue. Because RLS is currently the primary authorization story for
those tables, the security model itself is vendor-shaped.

Fix: a real `DbClient` port with typed repository methods, not a URL builder. PostgREST becomes
one driver; `pg`/Drizzle becomes another. Separately — **demote RLS from enforcement to
defense-in-depth**. App-level authz already exists and is well factored
(`actorHasPlatformAdminAccess` / `actorHasMerchantAccess` / `actorHasSalesAccess`); make that
the enforcement layer and keep RLS as a backstop. That alone removes `auth.uid()` from the
critical path.

### 2. Stripe — HIGH

16 files touch Stripe. The `PaymentDriver` port models only `createCheckoutSession`, so
everything real — payment intents, setup intents, customers, webhook verification — bypasses
it. Widen the port to `charge()`, `saveCard()`, `verifyWebhook()`, `refund()`,
`createHostedCheckout()`, then make the driver the only path.

### 3. Resend — MEDIUM (abstraction exists, is bypassed)

`EmailDriver` and three drivers already exist. `lib/email.ts` exports concrete helpers that
business logic calls directly. Keep the helpers — they are good domain-level API — but route
them through the driver and give them a retry/queue path.

### 4. Mapbox — MEDIUM-LOW

Server side is properly behind `MapDriver`. `lib/mapbox-autofill.ts` loads the Mapbox SDK
directly in the browser and `scripts/inject-mapbox-token.mjs` bakes a token into static HTML at
build time. Client-side provider swap is the gap.

### 5. Cloudflare — LOW, and deliberately accepted

`lib/cloudflare-saas.ts` is a clean API client. Cloudflare-for-SaaS custom hostnames have no
portable equivalent — this is lock-in to **consciously accept** rather than build a fake
abstraction over. Document the decision, do not gold-plate it.

### The model to copy

`lib/storage/*` is already exactly right: a `StorageClient` interface, three real drivers
(Upstash / Supabase / Cloudflare KV), a factory, and tests that exercise the interface rather
than a driver. Every port above should look like that.

### Enforcement, or none of this holds

Abstractions decay silently — this codebase is the proof. Add an ESLint `no-restricted-imports`
rule so `stripe`, `@supabase/*`, `resend`, and `mapbox-gl` are importable only from driver
files, and fail CI otherwise. Without it we re-audit in six months and find the same 26 files.

---

## (c) Data export design

Nothing tenant-level exists today (only `app/api/admin/export-winners`).

**Format**: JSONL as canonical (one object per line — streamable, no whole-file parse), CSV
alongside for spreadsheet users. Delivered as a ZIP containing a `manifest.json`
(export_schema_version, tenant_id, generated_at, per-file row counts and sha256 checksums,
source app version) plus one file per entity: products, variants, inventory, customers, orders,
order_line_items, companies, price_lists, quotes, raffle_entries, theme, config.

**Three decisions that make this real portability rather than a dump:**

1. **Async job, never request/response.** A tenant with 500k orders will exceed any Worker
   CPU/time budget. Queue, generate, write to R2, signed URL, email the link. Anything
   synchronous works in demo and fails at the exact moment a merchant is angry enough to want
   their data.
2. **Versioned, stable field names decoupled from column names.** If we rename
   `quantity_available` internally, the export keeps its name or bumps
   `export_schema_version`. An export whose shape tracks our internal schema is not a
   portability guarantee.
3. **Build the importer at the same time.** An export you cannot re-import is a consolation
   prize, not portability. It is also our own migration tool — the thing that lets *us* move
   off Supabase. Same manifest, in reverse.

---

## (d) Top risks, by severity

### SEV-1 — Double-charging real customers

Four live Stripe charge sites pass **no idempotency key**: `lib/auto-draw.ts:540` (the live
cron draw engine), `lib/raffle.ts:240` (executeDrawWithCharging),
`app/api/admin/trigger-drop/route.ts:155` and `:220`. `app/api/checkout/direct/route.ts:177`
does it correctly — the draw paths do not.

All four run in retryable contexts: cron re-invocation, an admin double-clicking Run Draw,
concurrent triggers. A retry charges the winner again. Fix is a deterministic key per
(draw, variant, email) — hours of work, and it should land before anything else in this
document. Note: `lib/raffle.ts:240` is code from an earlier pass in this session; it inherited
the gap rather than introducing it, but it is ours to fix.

### SEV-1 — Images as base64 inside the catalog blob

Product media is stored as base64 data-URLs inside the Redis `store:products` hash.
Consequences compound:

- `loadProducts()` pulls the **entire catalog including every image bytes** — and it is called
  from the storefront, checkout, the Stripe webhook, and the draw engine.
- base64 inflates payloads about 33%.
- Upstash bills per command and per byte of egress; this multiplies by tenants x products x images.
- It is precisely the convenient-now, painful-later pattern the brief asks about.

Fix: media to **R2** (zero egress, already on Cloudflare), store URLs. `/media/[...parts]`
becomes a redirect or is retired. Biggest cost decision in the system, and it gets worse every
day it is deferred.

### SEV-2 — Storefront cache TTL is 10 seconds

`app/api/store/route.ts` sets `s-maxage=10, stale-while-revalidate=30` — roughly 8,600 origin
hits per day, per PoP, per storefront. Catalogs change rarely. Move to a long TTL (hours) with
**explicit purge on write**, which is both cheaper and fresher than a short blind TTL.

### SEV-2 — withTtlCache is per-isolate on Workers

The in-process 10s cache has a near-zero hit rate across many short-lived isolates. Not
harmful, but it creates false confidence that origin load is controlled. The edge cache does
the real work.

### SEV-2 — Single shared Supabase project across all tenants and tiers

One connection pool, one egress budget, no per-tenant isolation. The brief asks specifically:
**yes, a runaway sales-portal query can starve storefront traffic.** Mitigate in order:
separate pooled connection strings per tier with per-tier limits so internal tools cannot
exhaust the storefront pool; statement timeouts, aggressive on internal tiers; a read replica
for storefront reads. Full per-tenant DB isolation is a later, much larger call.

### SEV-3 — Email failures are swallowed

Send failures are console-logged with no retry path. A winner can be **charged and never told**
— the worst version of this failure. Needs a durable queue with retry and a dead-letter view in
the admin panel.

### SEV-3 — No queue anywhere; the webhook does everything inline

`app/api/stripe/webhook/route.ts` performs Redis writes, Postgres writes, and an email send
inline. A slow Resend call pushes the webhook toward Stripe timeout, so Stripe retries. Today
`claimProcessedSession` dedupe saves us — correctness rests entirely on that one guard. Move
side effects to a queue; keep the handler to verify, claim, enqueue, 200.

### SEV-3 — Portal isolation fails open

Covered in (a): unset `PLATFORM_ROOT_DOMAIN` silently disables every isolation check.

---

## (e) Implementation order

**Phase A — stop the bleeding (days)**

1. Idempotency keys on all four charge sites. *Money-path bug; first, before anything else.*
2. Fail-closed portal isolation in production.
3. ESLint no-restricted-imports fence around vendor SDKs — locks in every later phase.

**Phase B — cost, before tenant count bakes it in (1-2 weeks)**

4. Media to R2; catalog stores URLs; backfill existing base64.
5. Long cache TTL + purge-on-write for the storefront payload.
6. Per-tier connection pooling + statement timeouts.

**Phase C — the subdomain/auth restructure (2-3 weeks)**

7. Route groups per tier; host-to-group rewrite in middleware; delete path-based access.
8. Three auth realms; `id.site.com` staff IdP; `__Host-` cookies.
9. Signed preview-token bridge for merchant to storefront preview.

**Phase D — portability (3-4 weeks)**

10. `DbClient` port + PostgREST driver; migrate the 26 call sites behind it.
11. Demote RLS to defense-in-depth; app-level authz becomes enforcement.
12. Widen `PaymentDriver`; route the 16 Stripe call sites through it.

**Phase E — data portability as a product (2 weeks)**

13. Export job (queue, R2, signed URL), manifest + JSONL/CSV, versioned schema.
14. Importer against the same manifest — our own migration tool.

**Phase F — deployment split (trigger-based, not scheduled)**

15. Extract admin and sales into their own Worker **when** either staff-tool deploys start
    blocking storefront deploys, or an internal-tool incident takes down storefront traffic.
    Not before — the isolation that matters is delivered in Phase C.

Phases A and B are independent of everything else and pay for themselves immediately. Phase C
is the prerequisite for the rest of the restructure. D and E can run in parallel with C given
capacity.

---

## ADR-001: One Worker deployment, three auth realms (not four Workers)

**Status:** Accepted 2026-09-15. Signed off by the platform owner after the
alternative (a Worker per tier) was put forward explicitly.

**Context.** The original sketch called for four separate Cloudflare Workers,
one per subdomain tier. The app today is ONE Next.js build deployed as one
Worker via `@opennextjs/cloudflare` (`wrangler.jsonc`), with host-based portal
classification in `lib/edge-router.ts` and a single middleware chain.

**Decision.** Keep one deployment. Model the split as **three auth realms**
across five hosts, enforced at the edge by host classification, not by
deployment boundaries:

| Realm    | Hosts                                   | Cookie scope           | Required role                          |
|----------|-----------------------------------------|------------------------|----------------------------------------|
| Staff    | `admin.` (platform), `sales.` (revenue) | per-subdomain, `__Host-` | `super_admin` / sales sub-roles       |
| Merchant | `app.`                                  | `app.<root>`           | `owner` / `staff` / `super_admin`      |
| Consumer | bare root (marketing), `*.` tenants     | host-only              | none / customer session                |

Note this is **three realms, not four** — `admin.` and `sales.` are separate
hosts with separate role gates, but they share one staff credential domain and
one session-issuing path. The count that matters for auth design is realms.

**Why not four Workers.**

1. *The security boundary does not come from the deployment.* It comes from
   cookie scoping (`cookieDomainForPortal`), the host→portal path fence
   (`isPortalPathAllowed`), and the per-portal role gates in
   `app/admin/layout.tsx`. All three already exist and are unit-tested. Four
   Workers would add a deployment boundary on top of controls that are doing
   the actual work — and a misconfigured role gate would be just as exploitable
   in a dedicated Worker.
2. *Four Workers means four deploys of the same Next.js build.* The routes are
   one App Router tree. Splitting the deployment without splitting the tree
   yields four copies of identical code, four cold-start surfaces, four sets of
   bindings/secrets to keep in sync, and four chances for version skew between
   a shared `lib/` change and the portals that consume it.
3. *Cost and CPU accounting do not favor the split.* Workers bills active CPU,
   not wall-clock or per-deployment overhead. Four Workers serving the same
   total request volume cost the same CPU, plus additional cold starts.
4. *Cross-realm calls would become network hops.* Impersonation
   (`/api/admin/impersonate`) and the shared quote APIs currently run in-process.
   Splitting turns them into service bindings — more failure modes for no
   isolation gain, since they would still share the same database credentials.

**What would change this decision (the trigger for Phase F).** Split the staff
realm into its own Worker when *any* of these becomes true:

- Staff routes need bindings or secrets that must never be present in the
  consumer-facing Worker (e.g. a payout key, a raw DB superuser credential).
- The bundle grows enough that consumer-path cold starts are measurably hurt by
  code only staff routes use.
- A compliance requirement demands physical, not logical, separation.

Absent one of those, Phase F stays unbuilt. This is written down so the split is
a *triggered* decision, not a preference re-litigated each time someone reads
the topology.

**Consequence accepted.** Logical isolation depends on `PLATFORM_ROOT_DOMAIN`
being configured. That is precisely why Phase A2 added `portalIsolationStatus()`
and the `portal_isolation` readiness check: a production deploy with the
variable unset **fails the deploy gate** (exit 1) rather than silently serving
`/admin` from every tenant subdomain. Deliberate single-host operation requires
an explicit `PLATFORM_SINGLE_DOMAIN_MODE=true`, so the unsafe state is never the
default and never silent.

---

## Finding: idempotency key length ceiling (found by replay, fixed)

**How it surfaced.** Phase A's idempotency keys were correct by construction, so
the Phase A report called them verified by reading. Running them against live
Stripe test mode (`npm run verify:idempotency`) found a defect that reading had
not: Stripe caps idempotency keys at 255 characters and returns a **400** above
it. Every charge site interpolates a raw customer email, and `email` is an
unbounded `text` column in this schema.

```
Idempotent key length is 272 characters long, which is outside accepted
lengths. Idempotent Keys must be 1-255 characters long.
```

**Severity.** This is not degraded idempotency — it is a **failed charge**. A
customer whose address is long enough to push the key over 255 could not be
charged at all on these paths. A ~200-character local part is unusual but
entirely legal (RFC 5321 permits 254), and nothing in the schema prevents it.

**Fix.** `lib/idempotency-key.ts` (pure, zero-import) exposes
`boundIdempotencyKey()`, applied at all **six** charge sites — the four added in
Phase A plus the two pre-existing ones in `lib/draw.ts` and
`app/api/checkout/direct/route.ts`, which had the identical exposure. Leaving
two known-broken sites because they predated Phase A would have been arbitrary.

Properties, all covered by `tests/idempotency-key.test.ts`:

- **Deterministic** — the same logical operation yields the same key on retry.
  Anything else defeats the purpose. No time, randomness, or counters.
- **Pass-through under the cap** — keys ≤255 chars are returned byte-for-byte
  unchanged, so existing traffic is entirely unaffected and keys stay
  human-readable in the Stripe dashboard.
- **Distinct when truncated** — over-length keys keep a readable prefix plus a
  64-bit digest of the *whole* original. A truncate-only fix would have merged
  two customers whose emails shared a long prefix into one charge; the test
  suite pins that case explicitly, along with a 20,000-input collision sweep.
- **Zero-import** — a pure-JS FNV-1a pair rather than `node:crypto`. To be
  precise about why, since an earlier draft of this note got it wrong: Node's
  crypto is available here and is used in several Node-runtime routes, so
  availability is not the reason. Zero-import modules load directly under
  `node --test` (which cannot resolve this repo's `@/` aliases) and remain safe
  if ever imported from an Edge-runtime path like `middleware.ts`, matching the
  convention `lib/csrf.ts` and `lib/cron-auth.ts` already follow. The digest
  needs determinism and collision resistance, not cryptographic strength; it is
  never a security boundary.

**Verification.** `scripts/verify-idempotency-replay.ts` now asserts both halves
against real Stripe: that the unbounded key *is* rejected (4a — the hazard is
real, not theoretical) and that the bounded key is accepted and still deduped
(4b — 272 → 255 chars, replay returns the same PaymentIntent). 10/10 assertions,
exit 0. The harness refuses to run against anything but an `sk_test_` key.

**Standing lesson.** "Correct by construction" is not verification for a money
path. The vendor's own limits are part of the contract, and only the vendor can
confirm them.

---

## Phase B item 5 — storefront cache: the audit's own recommendation was wrong

**What SEV-2 said.** "`s-maxage=10` → roughly 8,600 origin hits per day per PoP.
Catalogs change rarely. Move to a long TTL (hours) with explicit purge on write."

**The arithmetic holds.** 86,400s ÷ 10s = 8,640 revalidations/day/PoP under
continuous traffic. `app/api/store/route.ts:417` is still `s-maxage=10,
stale-while-revalidate=30`.

**The recommendation does not.** "Catalogs change rarely" is true of catalog
*structure* and false of what this payload actually carries. `/api/store`
embeds `inventoryRemaining` and `soldOut` per product, and inventory is written
on the **hot purchase path** — `app/api/checkout/direct/route.ts:210` and
`app/api/stripe/webhook/route.ts:525` both `saveLiveState` on every sale.

So a long TTL forces a choice between two bad outcomes:

- **Purge on every write.** During a drop that is a purge per purchase — a
  purge storm that defeats the cache and costs more than it saves.
- **Don't purge on inventory.** Then the storefront serves stale stock counts
  for hours: items shown available after selling out, countdowns wrong.

There is no third option while one endpoint serves both stable and volatile
data. **The 10-second TTL is not naive — it is load-bearing.** It is the
largest TTL that keeps inventory honest, and raising it without splitting the
payload would trade a cost problem for a correctness problem.

Checked and ruled out: `/api/checkout/stock` is a Stripe price-activity map,
not inventory, and nothing calls it. `/api/catalog/status` is a second full
catalog builder, not a cheap version oracle. Neither can absorb the volatile
half as it stands.

**The actual fix — split by volatility, then cache each half correctly:**

1. **Stable half** (catalog structure, theme, config, media refs) — long TTL,
   keyed by a catalog version token bumped only by admin catalog/config writes
   (`/api/admin/products`, `/api/admin/catalog-settings`, `/api/admin/seed`,
   never by an inventory decrement). Version-keyed URLs make purge-on-write
   exact and instant, with no purge API call that can fail or lag.
2. **Volatile half** (`inventoryRemaining`, `soldOut`, countdown anchors) — a
   small dedicated endpoint on a short TTL. Small enough that 8,640 hits/day of
   *it* is a rounding error next to 8,640 hits of the full payload.

**Not implemented in this phase, deliberately.** This changes the shape of the
`/api/store` response and how `components/Storefront.tsx` fetches — client
behavior that cannot be visually verified in this environment, against the file
this project has repeatedly and correctly ring-fenced from blind rewrites. It
wants its own gated change, not a tail-end addition to Phase B.

**Partly mitigated already:** Phase B item 4 removes the base64 brand logo
(41.8KB raw / 55.8KB encoded) from the payload, so every one of those 8,640
daily revalidations now moves dramatically less data. The TTL is unchanged; the
bytes per hit are not.

---

## Deferred work register

**DEFERRED-8: sold-out auto-archiving has been dead since the catalog moved to Postgres.**
Condition to pick up: when sold-out products visibly pile up on the
storefront, or when the merchant panel grows a catalog-lifecycle screen.

`app/api/store/route.ts` and `app/api/catalog/status/route.ts` both archive a
product once `now >= soldOutAt + soldOutArchiveDelayHours`. Under
`STORAGE_PROVIDER=supabase` that never fires, because `soldOutAt` is always
empty: there is no `sold_out_at` column, `lib/catalog-write.ts` does not write
the field, `lib/postgres-catalog-read.ts` does not read it, and there is no
jsonb passthrough carrying it.

Found while cutting subrequests: the checkout webhook was calling
`writeProductToPostgres` on every sold-out sale — three PostgREST calls plus a
per-variant insert loop, on the most budget-starved path in the system — to
persist exactly one field, which the write then dropped. That call is gone.
Nothing persisted changed, because nothing was being persisted.

Reviving the feature needs a real `sold_out_at` column plus a decision about
what to backfill for products that already sold out (almost certainly
nothing — inventing a sold-out timestamp would archive live products on
deploy). Do it deliberately, with the live schema checked first; do NOT
restore it by putting a catalog write back on the checkout path.

**DEFERRED-9: the homepage promises no percentage fee; the new tiers charge one.**
Condition to pick up: BEFORE the graduated pricing tiers ship publicly. Not
urgent on its own, but it must not be live at the same time as the new plans.

`app/platform/page.tsx` (the pricing footnote) currently reads:

> Paid plans are flat and monthly, billed through Stripe. We do not charge a
> percentage of the revenue our own tools claim to have generated — that is
> only fair once the measurement has been proven over time, and we would
> rather earn it than assume it.

That sentence is about ATTRIBUTION HONESTY: we will not bill a share of
revenue our growth tooling *claims credit for*, because gross attribution
overstates incremental lift. It is not a statement about the billing model.

The decided tier structure is a percentage-of-sale platform fee — free 2%,
$29 0.5%, $99 0%. The distinction is real but nobody reads a pricing page
that closely: seeing "no percentage fees" and then a 2% fee at signup reads
as a broken promise, and that is a trust cost paid at exactly the wrong
moment.

Fix the copy to separate the two claims — the platform fee is what it is and
should be stated plainly, while the attribution promise keeps its own
sentence and stops sounding like a billing guarantee. Owner has said the
showcase copy nearby (Timed drop / Everyday retail / Trade order, the
"Midnight Oud" example in `components/platform/CheckoutModeShowcase.tsx`) is
worth reusing if convenient but is explicitly not worth protecting: drop it
rather than bend anything functional around it.

**DEFERRED-5: separate tenant settings from the storefront payload.**
Condition to pick up: when the merchant panel's SETTINGS screens are built.

Originally H2 step 3, scoped to fix a 950KB config blob shipping on every
storefront read. That problem no longer exists -- the R2 backfill took 945KB
of base64 out of `store:config`, which is now 5,776B, and the live
`/api/store` payload is 18,429B. Building the split now would be solving a
solved problem.

What remains genuinely worth doing is structural, not size: `store:config` is
one blob mixing storefront presentation (theme, hero, copy) with tenant
operational settings (rewards, 2FA policy, ref prefix, recovery config). A
settings screen that edits one field has to read and rewrite the whole thing,
which is both a lost-update race and the reason a single bad write can take
out unrelated configuration. Split it where the editing UI makes the seams
obvious, rather than guessing at them from here.


Changes consciously deferred, with the condition for picking them up. Deferred
is not dropped: each entry names what it needs, so it can be scheduled rather
than rediscovered.

### DEFERRED-1 — Split the `/api/store` payload by volatility

**Status:** deferred out of Phase B (2026-09-15), by agreement. Does not block
Phase C.

**What.** Split the storefront payload into a stable half (catalog structure,
theme, config, media refs) served on a long, version-keyed TTL purged on admin
write, and a volatile half (`inventoryRemaining`, `soldOut`, countdown anchors)
on a small short-TTL endpoint.

**Why it is not just "raise the TTL".** `/api/store` currently carries live
inventory, and inventory is written on the hot purchase path
(`app/api/checkout/direct/route.ts:210`, `app/api/stripe/webhook/route.ts:525`).
A long TTL therefore forces a choice between a purge on every sale — a purge
storm during a drop, costing more than it saves — and serving hours-stale stock
counts. The current `s-maxage=10` is load-bearing, not an oversight: it is the
largest TTL that keeps inventory honest while both kinds of data share one
endpoint. Splitting them is what makes a long TTL safe. Full analysis in the
"Phase B item 5" section above.

**Why it is gated rather than just queued.** It changes the shape of the
`/api/store` response and how `components/Storefront.tsx` consumes it — client
behavior. There is no browser or visual verification available in this
environment, and `Storefront.tsx` is a file this project has repeatedly and
deliberately ring-fenced from blind rewrites. Typecheck and unit tests would go
green on a version that renders wrongly.

**Condition to proceed:** done WITH the operator reviewing client-side
behavior directly — the storefront rendering correct live stock, countdowns,
and sold-out states after the split — not verified blind from tests alone.

**Already partly mitigated:** Phase B item 4 removed the base64 brand logo
(41.8KB raw / 55.8KB encoded) from the payload, so each revalidation now moves
far less data. The TTL is unchanged; the bytes per hit are not.

---

## Phase C finding: portal isolation was classifying the wrong host

**How it surfaced.** Phase C's host-to-tier rewrite was implemented, unit-tested
and typechecked — and did nothing. Driving a real `next dev` server with
`Host:` headers showed why:

```
Host: admin.goyunir.com  ->  nextUrl.host = "localhost:3111", portal = "storefront"
Host: sales.goyunir.com  ->  nextUrl.host = "localhost:3111", portal = "storefront"
Host: acme.goyunir.com   ->  nextUrl.host = "localhost:3111", portal = "storefront"
```

`middleware.ts` classified `request.nextUrl.host`, which is the **server's own
address**, not the Host header. So `classifyHost` returned `'storefront'` for
every request and the entire portal-isolation layer — the host/path fence,
cookie scoping, the per-portal role split — was a no-op locally, regardless of
`PLATFORM_ROOT_DOMAIN`.

**Scope, stated precisely.** This is verified broken in local dev. Production
behavior was NOT verified from here — on a platform that reconstructs
`nextUrl` from the incoming request, it may well resolve correctly, which is
the likeliest reason this survived three phases of work that touched this file.
Either way the property that matters is the same: isolation could not be
verified before deploying, and it depended on deployment-specific behavior
rather than on the request.

**Fix.** `resolveRequestHost()` in `lib/edge-router.ts` reads
`x-forwarded-host` → `host` → fallback, lowercased and port-stripped. Now dev
and production classify identically, and the behavior is testable locally.

**Security note.** `Host` is client-supplied, so this is not an authentication
input. A spoofed Host can at most make the *path fence* more permissive for
that request; it still has to pass the session checks, which key off the path.
That separation is precisely why the path-based auth triggers must not be
"replaced" by host classification — see the correction below.

### Correction to ADR-001's Phase C plan

ADR-001 said: "Route groups per tier; host-to-group rewrite in middleware;
**delete path-based access**." The last clause is wrong and was not carried out.

`isAdminPath` / `isSalesPath` are not redundant access control — they are the
**authentication triggers**, gating the readiness check and the entire admin
session check. `isPortalPathAllowed` answers a different question:

| Check | Question | If removed |
|---|---|---|
| `isPortalPathAllowed(path, portal)` | may this host serve this path? | admin reachable on tenant domains |
| `isAdminPath` | does this path require a session? | **admin reachable with no auth at all** |

Deleting the second would have left `admin.<root>` serving the admin UI to
anyone while still looking correct, because the host fence would keep 404ing
the other hosts. Both are kept; the variables now carry a comment saying so.

Route groups were also skipped deliberately: Next.js `(group)` directories do
not change URLs, so moving `app/admin/` into `app/(staff)/admin/` is churn with
real import-breakage risk and no isolation benefit. The isolation comes from
the rewrite and the fence, both of which are now verified.

---

## Phase C closure — live production topology

`goyunir.com` is served by the Cloudflare Worker **`customattempt-1`**, built
from this repo on push to `main` (~90s). It is NOT `storefront-app`, the name
in `wrangler.jsonc`. Verified with `wrangler tail customattempt-1`: a marked
request to `goyunir.com` appears in that Worker's log and not in the other's.
A local `wrangler deploy` from this repo therefore does NOT deploy production.

**Routing** is a wildcard route, `*.goyunir.com/*`, declared alongside the apex
in `wrangler.jsonc`. It covers admin./sales./app. today and every future
`{tenant}.goyunir.com` with no per-tenant dashboard step. The apex is declared
with it deliberately: a routes array *replaces* a Worker's route set on deploy,
so declaring only the wildcard could delete the apex route and take the site
down. Confirmed live: `admin.goyunir.com` went 522 → 200 when it applied, and
the apex stayed 200 throughout.

### Two failures worth keeping

**1. Enabling the fence before the subdomains were routed locked admin out.**
The fence correctly makes `/admin` unreachable on the bare root — but
`admin./sales./app.` were returning 522 with no route, so the admin panel was
reachable *nowhere*. The preview test that "passed" drove `x-forwarded-host`
against a `workers.dev` URL: it proved the code worked and said nothing about
whether those hostnames existed. **A test that exercises the code path but not
the deployment path is not a deployment test.** Recovery also failed at first,
because a local `wrangler deploy` targets the wrong Worker; only a `git push`
changes production.

**2. The fence made staff login unreachable from the sales portal.**
`sales.<root>/sales` redirects an unauthenticated user to `/admin/login`, which
the fence then 404'd on that same host. A sales user was bounced into a dead
end and could never sign in. The rule: **whenever a gate redirects, the
redirect target must itself survive the gate, on that same host.**
`isSharedStaffAuthPath()` now exempts only the credential-establishing paths
(login page + API, setup/bootstrap, impersonation, super-login) for staff
portals. `/admin` itself stays fenced; consumer hosts get no exemption.

### Verified live, 17/17 plus the login path

| Host | `/` | `/admin` | `/sales` | `/admin/login` | `/catalog` |
|---|---|---|---|---|---|
| `admin.` | 307→login | 307 | 307 | 200 | 200 |
| `app.` | 307→login | 307 | 404 | 200 | 200 |
| `sales.` | 307→login | 404 | 307 | 200 | 200 |
| apex (marketing) | 200 | 404 | 404 | 404 | 200 |
| `{tenant}.` | 200 | 404 | 404 | 404 | 200 |

### DEFERRED-2 — Phase E: data export / import

**Status:** deferred (2026-09-16), by agreement. Not forgotten, not scheduled.

**What.** The vendor-portability deliverable from the original audit: export a
tenant's data (catalog, orders, entries, customers, config) in a form another
platform could ingest, and import it back.

**Why it is deferred rather than queued.** It is product work wearing hardening
clothes. Its scope depends entirely on questions nobody has answered: which
entities, what format, full vs incremental, and whether import must round-trip
an export losslessly. Those answers change the size from days to weeks. Unlike
the rest of the audit it fixes no defect — it is insurance against a migration
nobody is currently planning.

**Condition to pick it up:** a real requirement drives it — a customer asking
for their data, a concrete plan to move off Supabase, or a compliance
obligation. Not audit momentum.

**What already reduces the risk it was meant to address:** the DbClient port
(Phase D4) means queries no longer hard-code Supabase's dialect, which was the
deeper half of the lock-in this phase was guarding against.

### DEFERRED-3 — Reconcile the two parallel commerce-mode systems

**Status:** must be resolved BEFORE any new commerce-engine work (appointments,
lead capture, pre-orders, waitlists, auctions, subscriptions), not after.

**What.** There are two independent attempts at "one schema for many selling
modes":

1. `lib/commerce-modes.ts` (318 lines) — declares 10 modes (INSTANT_BUY,
   ALLOCATION_DRAW, TIME_SLOT, PREORDER, SUBSCRIPTION, GATED_ACCESS,
   GROUP_BUY, DUTCH_AUCTION, PAY_WHAT_YOU_WANT, RFQ_QUOTE), a capability
   vocabulary, typed AccessRule/BillingRule/ScheduleConfig blocks, and
   per-mode metadata. Consumed by exactly three files — app/admin/page.tsx,
   app/api/admin/products/route.ts, lib/server-config.ts — and only to
   NORMALIZE AND PERSIST the blocks. No checkout, draw or fulfilment path
   branches on commerceMode.
2. `lib/item-engine/registry.ts` — a separate registry with its own
   SUBSCRIPTION_SCHEMA and JSON-schema approach to the same problem.

**Why it matters now.** Building engines on top of two competing vocabularies
is how you get a third. Pick one (commerce-modes.ts is the more developed and
already has a storage shape in the product record) and fold the other in.

**Related inconsistency to settle in the same pass:** `waitlist` is modelled
as a `waitlist_entries` table (00012) and a `checkout_mode` enum value, but is
NOT a CommerceMode. Either promote it to a mode or explain why it is not one.

**Honest current state:** the vocabulary and storage shape exist and are
reasonable; the behaviour does not. That phase extends a schema and a type
system, and builds engines fresh.

### DEFERRED-4 — Remove the Redis catalog write bridge

**Status:** deferred (2026-09-16). The bridge STAYS until every reader is
migrated. Do not delete the Redis write before then.

**What.** `app/api/admin/products` writes the catalog to BOTH Redis and
Postgres. Phase G made Postgres authoritative for the storefront read
(`/api/store`), and the bridge was described as scaffolding with a simple end
condition — "flip verified live".

**That framing was wrong.** The blast radius was scoped against `/api/store`
only. A survey found **39 files reading the Redis catalog** (`PRODUCTS_KEY` /
`loadProducts`), of which exactly ONE was migrated. Still Redis-only:

  - `app/api/admin/products` GET — the admin panel's own product list
  - `lib/auto-draw.ts`, `lib/draw.ts` — the draw engines
  - `app/api/checkout/direct`, `checkout/cart`, `stripe/webhook` — MONEY PATH
  - `app/media/[...parts]` — serves base64 images out of the product record
  - `app/api/catalog/status` — the catalog page's Upcoming/Archive sections
  - ~30 more admin and account routes

So the real state is: **Postgres is authoritative for the storefront catalog
read; Redis remains authoritative for everything else.** The bridge is not
scaffolding — it is what keeps those 38 readers correct. Removing it first
would silently stale the admin product list and feed checkout stale prices.

**Condition to proceed:** migrate the readers to the DbClient port /
readCatalogFromPostgres, money-path LAST (checkout, draw engines) with the
same dry-run discipline used for lib/raffle.ts. Only once every reader is
confirmed migrated does the Redis write come out.

**Why it is acceptable meanwhile:** dual-write is not the end state, but it is
currently correct — both stores are written on every save. The failure mode it
guards against (one store going stale) is exactly what premature removal would
cause.

## Credential expiry calendar

Time-bombed credentials, recorded here because an expiry surfaces as a
confusing mystery failure ("uploads suddenly 403") weeks after anyone
remembers provisioning it.

| Credential | Where it lives | Expires | Failure mode when it lapses |
|---|---|---|---|
| R2 API token (`MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY`) | Worker secrets on `customattempt-1`, plus `.env.local` for local runs and the backfill script | **2026-10-16** (30-day TTL from 2026-09-16) | `/api/admin/media/presign` starts returning SignatureDoesNotMatch / 403. Existing images keep serving — they come from `media.goyunir.com`, which does not use this token — so the symptom is "new uploads fail, old ones fine", NOT a visibly broken storefront. That asymmetry is what makes it hard to recognize. |

To rotate: Cloudflare dashboard → R2 → Manage R2 API Tokens → create a new
Object Read & Write token scoped to `goyunir-media`, then
`npx wrangler secret put MEDIA_S3_ACCESS_KEY_ID --name customattempt-1`
(and the secret key), and update `.env.local`. No code change, no redeploy of
the non-secret vars in `wrangler.jsonc`.

Note the bucket's custom domain (`media.goyunir.com`) serves objects publicly
and is independent of this token — rotating or losing the token never takes
already-uploaded media offline.

## SEV-2: the Phase G flip silently dropped all merchant store config

**Found** tracing an unexplained payload-size difference (local `/api/store`
960KB vs production 16.5KB), not by any test or alarm.

`USE_POSTGRES_PRIMARY=true` (Phase G) routes `/api/store` through
`tryBuildStorePayloadFromPostgres`, whose config comes from
`readCatalogFromPostgres` -> the `tenant_store_config` table.

**`tenant_store_config` has zero rows.** It always has: migration 00014
created it, and nothing ever populated it. `readCatalogFromPostgres` returns
`config: {}` (a deliberate `.catch(() => [])`, so a missing row "just means no
overrides"), `mergePublicConfig({})` returns pure defaults, and the storefront
renders the built-in theme.

So from the moment Phase G wrote the catalog into Postgres, the live
storefront stopped seeing anything the merchant had configured. Measured
against production:

    merchant config keys: 25
    reaching the storefront: 8   (only the ones left at their defaults)
    NOT reaching it: 17 — branding (813B -> 14B), copy, legal, rewards,
    gallery, brandFooterData, aiHero, catalogPreview, ...

The brand logo is the clearest symptom: `branding.logoUrl` is set in
`store:config` and empty in the live payload.

**Why nothing caught it.** The fallback is the bug. Every layer treats a
missing config as a legitimate "no overrides" state rather than an error, so
the system reports itself healthy while serving defaults. The catalog read
NEXT TO IT returns null on missing data and falls back to KV — config does
not, and the asymmetry is invisible at a glance. The products kept working
throughout, so the storefront looked fine.

**Lesson, consistent with the rest of this session:** a silent fallback to a
plausible default is indistinguishable from success. `store_kv` holding the
real config while a parallel empty table was authoritative is the same failure
shape as the fake PostgREST accepting what production rejected, and as the
duplicate option labels merging without a word.

**Fix** belongs to H2: populate `tenant_store_config` from `store:config`
BEFORE any config restructuring, then split `aiHero.clips` (682KB) and
`catalogPreview` (264KB) out of the hot read path. A config read that finds no
row for a tenant that has products should be loud, not empty.

## ISSUE-1: an empty saved value is indistinguishable from an unset one

`mergePublicConfig` spreads defaults, then the stored config over them. A
merchant who saves `legal.terms = ""` therefore OVERRIDES the default rather
than falling back to it, and the storefront renders a blank page.

Found while diffing the SEV-2 fix: copying `store:config` verbatim would have
blanked the live Terms, Privacy and Shipping pages, because those fields were
saved empty and the defaults had been silently covering for them.

Deliberately NOT fixed inside the SEV-2 restore — changing merge semantics
under a production incident fix is how one bug becomes two. `legal` is
excluded from that write (`SKIP_KEYS` in scripts/restore-store-config.ts) and
the defaults stay live until real legal text exists.

The real fix needs a decision this codebase has never made: does empty mean
"explicitly blank" or "not set"? Probably per-field — an empty `heroTitle` is
a legitimate choice, an empty `terms` almost never is. Pick up when config
authoring moves into the merchant panel, where the UI can distinguish "cleared
this field" from "never touched it".

## Standing pattern: silent fallbacks are SEV candidates

SEV-2 was not caused by a crash, a bad query or a race. It was caused by a
`.catch(() => [])` that turned "this table is empty" into "no overrides
configured", which is a plausible, non-alarming state. **Absence and success
produced identical output, so nothing could tell them apart.**

Treat every `.catch(() => <default>)` and every empty-default standing in for
a real read as a potential SEV until proven otherwise. The tell is not the
catch itself — it is whether a caller could distinguish the fallback from a
real answer. `readCatalogFromPostgres` returning `null` on failure is fine:
the caller falls back to KV and the two paths are distinguishable. The same
function returning `config: {}` was not fine, because `{}` is a legitimate
config.

Known instances, to audit as each phase reaches them:

| Site | Status |
|---|---|
| `readCatalogFromPostgres` config `.catch(() => [])` | **THE SEV-2 CULPRIT.** Fix in H2 step 2. |
| `app/api/admin/theme` `.catch(() => [])` on `tenant_themes` | Unaudited. Same shape: 0 rows today. |
| `b2b/quotes` contract-pricing reads | **AUDITED + FIXED.** Was fail-OPEN: a failed price_lists / price_list_entries read yielded `entries = []`, indistinguishable from "no negotiated pricing", so resolveUnitPriceCents correctly returned BASE price and a draft quote was saved at list price. NOT live-active — companies, price_lists, price_list_entries, quotes are all 0 rows, so nothing has ever been mispriced. Now returns 503 and logs. The quotes LIST read had the same shape (failed read rendered as "no quotes") and also fails closed now. |
| `b2b/quotes` companies / variants `.catch(() => null)` | Audited, acceptable: both fail CLOSED (404 / 400), no quote is created. Caveat: a DB error is reported to the user as "Company not found", which is misleading to diagnose but safe in outcome. |
| `lib/media-r2.ts` null-on-miss | Mitigated, not removed: `X-Media-Source` makes the read path observable, so a demotion to the signed-GET fallback is visible rather than inferred. |

## Merchant panel requirement: per-drop win/loss and decline policy

Not a deferred idea — a required part of commerce-mode configuration, raised
by a real divergence found during H5.

The two draw engines disagreed about what happens to an entry that does not
win. The KV engines re-push non-winners into the pool, so a loser is
automatically in the next drop. The Postgres `executeDraw` marked them
`not_selected`, which removed them from every future draw. Proven by running
two consecutive draws: Postgres gave draw 2 zero entries where Redis would
have given it two.

H5 resolved it by matching the KV behaviour (non-winners stay `pending` and
roll over), on the principle that a storage migration does not get to change
what customers experience. But "matching the old behaviour" is not the same
as "this is the right behaviour", and the answer legitimately differs per
drop:

| Setting | Options | Why a merchant would choose either |
|---|---|---|
| Loss rollover | roll over / one-shot | A weekly restock rewards persistence with rollover. A one-off collaboration drop wants fresh intent each time, and rollover quietly inflates entrant counts with people who entered months ago. |
| Decline retry | retry next draw / release | KV retries the same failing card every draw indefinitely. That is right for a temporary hold failure and wrong for a dead card. |
| Winner re-entry | eligible / excluded | Some drops deliberately exclude previous winners; the current model has no notion of it. |

Two constraints the implementation has to respect, both discovered rather
than designed:

1. The duplicate-entry index is PARTIAL on `status = 'pending'`, so a
   non-pending entry does not block re-entry. Any policy that parks entries
   in a non-pending state silently re-opens entry for that email.
2. While an entry sits at `status = 'winner'`, the same email can create a
   fresh pending entry. Rolling a declined winner back to `pending` can
   therefore collide with that fresh entry;
   `rollDeclinedEntryBackToPool` leaves it declined in that case rather than
   handing one person two slots.

A `pending` entry also holds a saved payment method indefinitely, which is
the strongest argument for offering one-shot mode: a card sitting in a pool
for months is materially more likely to decline.

## DEFERRED-6: storefront auth to Supabase Auth

Condition to pick up: its own dedicated phase, not folded into a storage
migration.

Numbered 6, not 5, because DEFERRED-5 (tenant settings vs storefront payload)
already exists. Reusing the number would have made the register ambiguous.

`store:users` bundled four unrelated concerns in one KV blob:

| Concern | Fields | Where it lives now |
|---|---|---|
| Authentication | `password`, `emailVerified` | **still KV** — this entry |
| Loyalty | `rewards` | `customers.rewards_balance` (00022) |
| Consent | `emailOptIn`, `termsAgreedAt` | `customers.email_opt_in`, `terms_agreed_at` |
| Authorization | `role` | `customers.role` |

Auth stayed because moving it is customer-facing work, not a storage swap:
password reset, session handling and email verification all become managed
features with different flows, and getting any of them wrong locks customers
out of their accounts. It deserves a phase where that is the whole focus.

CONSEQUENCE, accepted explicitly rather than discovered later: **H9 cannot
fully delete the KV bridge.** `store:users` stays alive specifically to hold
password and emailVerified until this is done. That is a known, logged
exception with a named reason — not a silent gap. Everything else the bridge
carried does get deleted.

Note for whoever picks this up: ten separate routes each do their own
`hgetall(USERS_KEY)` and match by email, rather than going through a shared
lookup. There is no single seam to swap, so this needs a real auth adapter,
which is another reason it is not a small change.

## H7 (profile): the loyalty balance moved, and was proven under load

Migration 00022 gave `public.customers` the four fields `store:users` had been
bundling. This is the phase that made them real: one existing account
backfilled, every writer and reader repointed, and the compare-and-swap
exercised against the live database rather than reasoned about.

### What is authoritative now

`public.customers` owns `rewards_balance`, `email_opt_in`, `terms_agreed_at`
and `role`. `store:users` still holds `password` and `emailVerified`
(DEFERRED-6) plus `welcomePromoCode`, which is promo bookkeeping 00022 did not
move, and a **display mirror** of the balance.

The mirror exists because paths this phase did not repoint — the
order-confirmation email, the entry-confirmation email, the winner emails, the
admin users list — still scan the hash for `u.rewards` to print a number to a
customer. Every writer therefore writes Postgres FIRST, with the CAS, and then
tells KV what Postgres ended up holding. `lib/customer-profile-bridge.ts` is
that one seam, and it carries its own H9 deletion criteria.

### The scope correction

The phase was scoped as two writers (`grantWelcomeRewards`, `redeem-points`)
and four readers. There were **five** writers of the balance, and a sixth
writer of consent:

| Writer | What it does | Was in scope |
|---|---|---|
| `grantWelcomeRewards` | +250 on verification | yes |
| `account/redeem-points` | spends points for credit | yes |
| `stripe/webhook` → `awardPurchasePoints` | points on every paid purchase | **no** |
| `account/claim-welcome` | +250 when no welcome code yet | **no** |
| `auth/signup` | the ONLY writer of consent | **no** |

Repointing only the named two would have left the authoritative balance read
by every display path but written by less than half of what changes it — every
purchase would have earned points that vanished, and no new account would ever
have recorded consent, which is the compliance case 00022 was justified by. A
money field half-migrated is worse than either end state, so all of them moved.

`app/admin` also POSTs `{ action, email, role, rewards }` to `/api/admin/users`
to edit a customer's points. That route only implements GET and PATCH for
platform RBAC roles, so the POST has been answering 405 — the admin "adjust
points" feature does not work and did not work before this phase either. Left
alone deliberately: it is a broken feature, not a migration gap. The comment in
`auth/me` that cited it as a reason to re-read has been rewritten accordingly.

### Two bugs found by exercising it, not by reading it

**1. Concurrent grants were silently dropped.** The CAS retried *immediately*
on a lost swap, which keeps every contender in lockstep — they re-read the same
balance at the same instant and collide again until the budget is gone. Ten
parallel grants against one balance lost **two of them**: points a customer had
earned, discarded with a log line. Fixed with jittered backoff and a larger
budget for grants than for spends, because a spend may legitimately fail and a
grant may not. `lib/inventory.ts`'s `decrementInventory` has the same
no-backoff retry loop; there a lost race refuses a sale rather than destroying
anything, so it is a smaller problem, but it is the same shape.

**2. `redeem-points` minted the credit code BEFORE deducting.** Any failure
between the two handed out a fully valid fixed-amount promo code that was never
paid for. The order is now: CAS the points off, then mint; if the mint fails,
refund and say so.

### The proof

`npm run verify:profile` (live database) and `npm run verify:profile-roundtrip`
(live database + the real HTTP routes, `npm run dev` running).

The invariant asserted for concurrency is **conservation** —
`successes x amount + final balance === starting balance` — not "about half
succeeded". A lost update breaks conservation loudly; retry exhaustion does
not, and conflating the two is how a broken CAS passes a sloppy test.

Measured, four runs, against the live database:

| Race | Result |
|---|---|
| 10 parallel x100 against 500 | 5 succeeded, final 0, conservation exact |
| 8 parallel x100 against 100 | 1 succeeded, final 0, conservation exact |
| 20 parallel x25 against 250 | 10 succeeded, final 0, conservation exact |
| 10 parallel grants of +10 | all 10 landed (was 8/10 before the backoff fix) |

And through the real route, with the real session, lock and CAS: six parallel
redemptions of 100 against a balance of 100 returned `200,400,400,400,400,400`,
left the balance at 0, and minted **exactly one** credit code — asserted on the
codes that actually exist in `promo:codes`, not on what the responses claimed.

Both scripts write only to `@goyunir.invalid` addresses (a reserved TLD that
can never be a real inbox) and delete what they create. The first version of
the round trip cleaned up its `REWARD-` codes but not the `WELCOME-` code the
grant mints, and left three behind in the live promo table; they were removed
and the script now cleans up both.

## Phase order from H8 onwards

Decided deliberately rather than by what was next in the key list: lowest-risk
storage moves first, money paths last, each money path with its own phase and
its own checkpoint.

| Phase | Scope | Why here |
|---|---|---|
| **H8** | drop-alert subscribers, usage metrics | No money, no data to lose (both KV sources are empty in production) |
| **Orders phase** | `archive:ledger` → `orders`/`order_line_items`, **plus draw history** | Money. Needs schema design before code — see below |
| **Promos phase** | `promo:codes` → a table that does not exist yet | Money-adjacent: welcome credits, redemption credits, promoter payouts |
| **H9** | delete the KV bridge | Only defensible once the above are real |

### DEFERRED-7: draw history belongs to the orders phase

Not unfinished H8 work — moved on purpose.

`drop_draws` (00012) is **one row per variant**: `variant_id uuid not null`,
`winner_count`, `entries_count`. A draw RUN is not that shape. `draws:history`
stores one entry per run, containing `processedWinners[]` where each winner
carries its own `product`, `size`, `status`, `amountCents` and **`orderRef`**.
One run spans many variants, and `draws:last` — the "most recent run" the admin
status screen reads — has no home in the schema at all.

Modelling it needs either a `drop_draw_runs` table with a `run_id` on
`drop_draws`, or a different decomposition. Either way the design depends on
how the orders phase resolves `checkout_mode`, the raffle-entry-charged-later
concept and shared pools — the same gaps `lib/postgres-shadow-write.ts` names
as the reason orders were never cut over. Designing a draw-run table first
means designing it against a shape that is about to change.

The coupling is concrete, not theoretical: `processedWinners[].orderRef` and
`.amountCents` are order facts living inside a draw record. Whatever table
holds them should be designed in the same sitting as the orders schema.

Production state at the time of deferral: `draws:history` is empty and
`draws:last` is unset — no draw has ever run here — so nothing is at risk while
this waits.

### H8 scope notes

**The drop-alert list got a new table (00023), not `waitlist_entries`.**
`waitlist_entries` models "notify me when THIS VARIANT restocks"
(`variant_id not null`). `customer:waitlist` is a store-wide announcement list
keyed by email, with `sources` and `interests` and no variant anywhere in the
record. Putting one in the other would have meant inventing a `variant_id` per
subscriber. `waitlist_entries` stays empty and reserved for its real purpose —
nothing writes it yet.

**Analytics moved as counters → events, and only partly.** The usage counters
(`analytics:usage:<tenant>:<day>`) now write `public.analytics_events`, a table
that had sat in the schema since 00001 with **zero writers and zero readers**.
Affordable as one row per occurrence because `trackUsage` has exactly three
call sites, all AI-generation routes, and an AI generation is slow and
human-triggered.

Staying in KV, deliberately: `analytics:online` (a ZSET of visitor ids scored
by last-seen), `analytics:social_boost` and `analytics:ticks`. These are
real-time ephemeral state read on the storefront hot path; an append-only
events table is the wrong shape for them and would add a database round trip
per request for data nobody queries historically. H9 must treat these as
named exceptions, not leftovers.

No analytics backfill: every daily usage hash in production is empty, and a
counter carries no per-event timestamps, so even a non-empty one could only
have been backfilled as a single synthetic event per day.

**`api_calls` and `system_events` read as zero** on the admin analytics screen.
They have no writer anywhere in the app and never did — that predates this
phase and is not something the move lost.

### The empty audit trail was correct — and is now proven

`public.audit_logs` had **zero rows** while `admin:audit_log` held 86, and
`appendAudit` dual-writes both (deliberately `await`ed, so a freezing
serverless runtime cannot drop the Postgres half). That looks exactly like a
silent failure, and `recordPlatformAudit` is built to be silent: it returns
early when `getDb().configured` is false and downgrades every error to a
`console.warn`.

Three explanations, separated before anything was written:

| # | Hypothesis | Verdict |
|---|---|---|
| 1 | The Worker lacks `SUPABASE_SERVICE_ROLE_KEY`, so the writer returns at line 1 | **Ruled out** — both secrets confirmed present on `customattempt-1` |
| 2 | The deployed build predates the dual write | **Ruled out** — it landed 73 commits before the deployed tip |
| 3 | No admin action has happened since it shipped | **Confirmed** |

All 86 KV entries are dated 2026-08-30 to 2026-09-06. The dual write landed
2026-09-14. Nobody has performed an admin action since. The empty table was the
correct state, and no code was changed.

That is a diagnosis, not a proof. A path that has never executed in production
is a path nobody has watched work — which is how the H4 lock, the H5 mirror and
the H6 charging blocker were all found. So `npm run verify:audit -- --probe`
executed it once, on purpose, rather than letting the first real admin action be
the first attempt. It works, and the row is permanent by design.

**While there, the tamper-resistance claim was tested for the first time.**
00008 says triggers block UPDATE and DELETE on `audit_logs` unconditionally,
service-role key included. Nothing had ever checked. A scoped DELETE of the
probe row was attempted: it was refused and the row survived. The claim holds.

`npm run verify:audit` is read-only and safe to re-run; it reconciles the two
stores and reports a mismatch as a failure. `--probe` is opt-in precisely
because its row can never be removed.

## Auth phase: staff identity, invites, and who may sign in

The platform could create exactly ONE staff account — the master super-admin
the Setup Wizard makes. The eight RBAC roles from 00015 were fully enforced by
`lib/admin-actor.ts` and completely unassignable, because nothing ever inserted
a row to assign them to. That single hole blocked staff onboarding, sales reps
(so the sales portal had no account that could use it) and tenant owner
provisioning at the same time.

### Three blockers, not one

| # | Blocker | Fix |
|---|---|---|
| 1 | No way to CREATE a staff identity | `staff_invites` (00024) + `lib/staff-invites.ts` |
| 2 | Even if one existed, it could not SIGN IN — `/api/admin/login` used `verifySuperAdminSignIn`, which fails closed without `is_super_admin` | the route verifies the password, then resolves the role from `public.users` |
| 3 | `profiles` and `users` both held a role and neither synced | 00024 backfilled `users` and made it authoritative |

Blocker 2 was the dangerous one: the invite flow could have been built
perfectly and the invited rep still could not have logged in.

### A privilege bug fixed on the way past

`verify-confirm` issued the admin device with NO metadata, which sent
`resolveAdminActor` down its legacy branch and granted **`owner` — full
merchant access — to whoever passed the emailed 6-digit code.** Survivable
while exactly one account existed; not survivable the moment a sales rep can
sign in. The device now carries the real role, read fresh from `public.users`
at the moment it is issued rather than carried through from the password step,
so a role change or a removed account takes effect on the next sign-in.

### What makes the invite flow safe

- **The token is never stored.** `staff_invites.token_hash` holds SHA-256; the
  token exists only in the emailed link. An invite row IS a grant of privilege,
  so a database dump must not be usable to accept one.
- **The role comes from the invite row, never the request body.** Verified:
  posting `role: 'super_admin'` while holding a `sales_rep` invite produces a
  `sales_rep`.
- **Acceptance claims the row BEFORE creating the account**, with a conditional
  update — the same compare-and-swap shape as the loyalty balance. Four
  parallel acceptances of one link produced `200,409,409,409` and exactly one
  account. A failed creation RELEASES the claim.
- **Escalation gate on issuing.** Inviting a `super_admin`, or a platform-level
  invite with no tenant, requires platform-admin access — otherwise an `owner`
  could invite a `super_admin` and escalate past their own ceiling.
- **Account creation is all-or-nothing.** `public.users.id` is an FK to
  `auth.users(id)`, so the Auth user is created first; if the `users` row then
  fails, the Auth user is DELETED. Otherwise the account could authenticate
  with no role, which reads as "invalid email or password" forever.

### Unverified customers can no longer sign in

Login used to let an unverified customer in and merely withhold the welcome
rewards, making "verified" a rewards rule rather than an identity one. It now
refuses, as Shopify does, and returns `needsVerification: true` so the page can
offer to resend the code.

The test is `emailVerified === false`, NOT falsy. Accounts created before email
verification existed have no such field, and treating those as unverified would
lock out every legacy customer over a flag that was never set — the same rule
`/api/auth/me` already applied.

**Consequence on this deployment:** the one existing customer record has
`emailVerified: false` and must confirm their address before signing in again.
Intended, not an oversight.

### Tenant provisioning now produces an owner

`/api/admin/tenants` takes `ownerEmail` and issues an `owner` invite scoped to
the new tenant; a tenant created without one returns an explicit warning rather
than silently being unreachable.

`/api/signup/merchant` adds self-serve signup, **disabled by default** behind
`ALLOW_MERCHANT_SIGNUP=true`. Public tenant creation on a single-brand store
would let anyone create tenants on somebody's live shop. It sends an invite
rather than taking a password directly: an `owner` can read customer records
and change payment settings, so proving the inbox first is the right trade.

### A deployment gap this surfaced

`SUPABASE_ANON_KEY` is **not set**. `supabaseConfigured()` is therefore false
and the Supabase branch of `/api/admin/login` never executes — every account
gets 401 and the only way in is the legacy `ADMIN_BASIC_AUTH_PASSWORD`. The
service key is present, so invites and account creation work; it is
specifically the PASSWORD GRANT that needs the anon key.

`npm run verify:staff-auth` reports this as BLOCKED rather than skipping it,
because a silent skip is how a gap like this reads as "auth works" right up
until nobody can sign in.

## SEV-2 audit: the filter-quoting bug

`lib/db/query.ts` double-quoted any scalar filter value containing `, ( ) " :`
or whitespace, then percent-encoded the quotes as well. PostgREST compared the
quotes as part of the value, so the filter returned **nothing** — and nothing is
indistinguishable from "no rows matched". It sat under every Postgres read in
the system.

### Blast radius, established against the live database

| Column type | Quoted (the old behaviour) | Verdict |
|---|---|---|
| `timestamptz` | **matched** | Never affected — Postgres strips the quotes while casting |
| `uuid` | matched | Never affected — no reserved characters to trigger quoting |
| `text` | **zero rows** | **Affected** |

That timestamps were safe is the finding that made this tractable: every
date-range read in the system was correct throughout. The damage was confined to
text columns holding a value with a reserved character.

### Every affected call site

An inventory of all scalar filters found two, both filtering a text column by
free text:

| Call site | Value | Effect |
|---|---|---|
| `lib/ai-assistant/tools.ts` | `'AI Assistant Discounts'` | The "does this price list exist" check never matched, so a duplicate would be created on every use |
| `app/api/admin/theme/route.ts` | theme name, default `'Default Theme'` | Upsert-by-name never matched, so every save inserted a new row and left an orphaned inactive theme |

Everything else filters on uuids, timestamps, enum tokens (`status`, `unit`,
`role`), generated slugs, hex hashes or `cus_`/`prod_` identifiers — none of
which can contain a reserved character. `product_variants.option_label` is
merchant-entered and *could* ("8 oz"), which would have broken variant
resolution on orders; production holds only `50ml` and `sample`, so it never
did.

### Damage

**None.** Both affected tables were empty — neither feature had been used in
production — so there was nothing to repair. Both lookups are proven working
after the fix, and `tests/db-query.test.ts` pins the exact shapes.

### Why it survived so long

Nothing in the codebase had filtered a text column by a value with a reserved
character until a `usage_events` lookup keyed `contact:<email>` did. A wrong
filter that throws gets found immediately; one that returns an empty list looks
like an ordinary "no results" and can outlive everyone who wrote it.
