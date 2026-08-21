# Multi-Tenant Template Platform (Supabase + Cloudflare Workers + KV)

A dynamic, multi-tenant website template platform (Shopify/Linktree-style):
every aspect of the frontend — site name, theme colors, layout blocks, products,
navigation — is data, not code. **Supabase (Postgres)** is the source of truth
and Admin Portal engine; **Cloudflare Workers + Cloudflare KV** deliver the
compiled site at the edge with a cache-first fast path.

```
visitor ──HTTPS──▶ Cloudflare Worker ──KV fast path──▶ compiled JSON ──▶ HTML
                        │
                        └── KV miss ──▶ Supabase (sites + settings + products)
                                          │  RLS: anon reads PUBLISHED sites only
                                          └──▶ compiled JSON ──▶ warm KV (24h) ──▶ HTML

Admin "Save / Publish" ──▶ Supabase (service role) ──▶ Cloudflare API ──▶ purge site_cache:<hostname>
```

## Repository layout

```
multi-tenant-platform/
├── shared/                        # pure, framework-agnostic contracts (no `any`)
│   ├── types.ts                   #   DB rows, ThemeConfig, LayoutBlock union, CompiledSite, Database
│   └── hostname.ts                #   hostname → tenant resolution + KV key derivation
├── supabase/
│   └── migrations/
│       ├── 00001_initial_schema.sql   # tables + RLS + grants + triggers
│       └── 00002_seed_demo_site.sql   # optional published demo tenant
├── worker/                        # Cloudflare Worker (edge rendering)
│   ├── wrangler.toml              # KV binding, platform apex, TTL, cache version
│   ├── src/
│   │   ├── index.ts               # fetch handler — fast path / slow path / __health
│   │   ├── env.ts                 # typed bindings (SITE_CACHE, secrets)
│   │   ├── cache.ts               # get/set compiled payload in KV (24h TTL)
│   │   ├── supabase.ts            # slow path — supabase-js + runtime normalizers
│   │   └── render.ts              # SSR boilerplate layout + JSON injection + CSS
│   └── test/hostname.test.ts      # node --test
└── admin-portal/                  # cache-invalidation + publish pipeline
    ├── src/
    │   ├── cloudflare-kv.ts       # Cloudflare API bulk/single key purge (typed)
    │   ├── supabase-admin.ts      # service-role client (the trusted writer)
    │   ├── publish.ts             # Save/Publish: Postgres write → KV purge
    │   └── route.example.ts       # Request → Response endpoint (Next.js verbatim)
    └── test/publish.test.ts       # node --test
```

## 1 · Supabase (source of truth + RLS)

1. Create a Supabase project and run `supabase/migrations/00001_initial_schema.sql`
   in the SQL editor (or `supabase db push`). It is idempotent.
2. Run `00002_seed_demo_site.sql` once a user exists — it creates a published
   `demo` tenant owned by the oldest profile so you can test immediately.
3. Grab the **anon** key for the Worker and the **service role** key for the
   Admin Portal (Dashboard → Settings → API).

**RLS guarantees** (the SQL enforces exactly these):

| Table | Owner (authenticated) | Anonymous |
| --- | --- | --- |
| `profiles` | select/insert/update own row | none |
| `sites` | full CRUD on own rows | select only `is_published = true` |
| `site_settings` | full CRUD on own sites | select only for published sites |
| `products` | full CRUD on own sites | select only for published sites |

The Worker queries with the **anon** key, so a draft/unpublished tenant is
invisible until the owner publishes — and can never be rendered by the edge.

## 2 · Cloudflare Worker (edge routing + caching)

```bash
cd multi-tenant-platform/worker
npm install

# create the KV namespace once, then paste its id into wrangler.toml
npx wrangler kv namespace create SITE_CACHE

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY

npx wrangler dev          # local test (set PLATFORM_ROOT_DOMAIN in [vars])
npx wrangler deploy
```

**Hostname handling** (`shared/hostname.ts`):
- `demo.yourplatform.com` → tenant key `demo`
- `shop.acme.com` → tenant key `shop.acme.com` (custom domain)
- `www.shop.acme.com` → same tenant as `shop.acme.com`
- platform apex / malformed subdomains / localhost / IPs → rejected

**Fast path (cache first):** reads `site_cache:v<N>:<siteKey>` from KV, parses
the `CompiledSite` JSON and injects it into the boilerplate HTML layout — zero
network calls, rendered at the edge in microseconds.

**Slow path (cache miss):** one typed sequence against Supabase
(`@supabase/supabase-js`, fetch-based): published `sites` matched by
`subdomain` **or** `custom_domain` → `site_settings` → active `products`
(sort-ordered). The compiled JSON is **async-saved to KV with a 24-hour
expiration** (`SITE_CACHE_TTL_SECONDS`, per spec) so the next hit is instant,
then the page is served.

Bump `CACHE_VERSION` in `wrangler.toml` to invalidate every tenant's cache at
once (key derivation includes the version).

## 3 · Admin cache-invalidation trigger (Save / Publish)

`admin-portal/src/publish.ts` is the boilerplate for your Admin Portal's
"Save/Publish Changes" handler (drop `route.example.ts` into Next.js as
`app/api/publish/route.ts`, or wrap `publishSite()` in any backend). It:

1. **Writes to Supabase** (service role): upserts `site_settings`
   (site_name/theme_config/layout_blocks) and replaces the product catalog.
2. **Flips `sites.is_published`**.
3. **Instantly overwrites/deletes the Cloudflare KV keys** for every hostname
   the site owns (`site_cache:v<N>:<subdomain>` + `site_cache:v<N>:<custom_domain>`)
   via the Cloudflare API bulk-delete endpoint — the live site updates for the
   next visitor immediately, and the Worker re-warms KV on the following miss.

Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`,
`ADMIN_API_SECRET`, `CACHE_VERSION` (must equal the Worker's).

## 4 · Development protocol

- **Types are shared, not copied.** `shared/types.ts` is the single source for
  DB rows, `ThemeConfig`, the `LayoutBlock` discriminated union, `CompiledSite`
  and the supabase-js `Database` generic — the Worker, Admin Portal and SQL all
  map to it. No `any` anywhere; `strict` is on in both `tsconfig.json` files.
- **Tests:** `cd worker && npm test` / `cd admin-portal && npm test`
  (`node --test`, Node ≥ 23.6 for native TS). Root repo checks (`lint`,
  `typecheck`, `build`) intentionally exclude this folder via `tsconfig.json`
  / `eslint.config.mjs` so the storefront template stays green without the
  platform's optional dependencies.
- **Worker local flow:** `wrangler dev`, then visit
  `http://demo.localhost:8787` (or set `PLATFORM_ROOT_DOMAIN` to a value you
  can fake in the Host header) and watch the first request miss, warm KV, and
  every request after that hit.

## Custom domains

1. Tenant sets `custom_domain` (e.g. `shop.acme.com`) in Supabase.
2. Point `shop.acme.com` **and** `www.shop.acme.com` at the Worker route
   (`CNAME` to your Workers zone, or a Worker route on the custom zone).
3. On publish, the Admin Portal purges `site_cache:v<N>:shop.acme.com`, and the
   Worker resolves + serves the same compiled payload for both hosts.

