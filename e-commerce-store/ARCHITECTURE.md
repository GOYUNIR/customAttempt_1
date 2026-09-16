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
