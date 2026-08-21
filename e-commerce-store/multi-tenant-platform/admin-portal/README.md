# Admin Portal — publish & cache-invalidation

The bridge between your Admin Portal backend and the edge.

## What it does

`src/publish.ts` → `publishSite()` is the exact "Save/Publish Changes" flow:

1. **Supabase write** (service role, bypasses RLS): upsert `site_settings`
   (`site_name`, `theme_config`, `layout_blocks`) and replace the site's
   product catalog.
2. **Publish state**: flip `sites.is_published`.
3. **Cloudflare KV purge**: delete `site_cache:v<N>:<subdomain>` and
   `site_cache:v<N>:<custom-domain>` via the Cloudflare API bulk endpoint —
   the live site is fresh for the next visitor instantly.

## Wiring it into a backend

**Next.js App Router** (this repo's stack) — copy `src/route.example.ts` to
`app/api/publish/route.ts`. The file is already a valid route handler:

```ts
export async function POST(request: Request): Promise<Response>
```

Any other runtime (Express, Fastify, a Worker in front of the admin) just calls
`publishSite(adminClient, kvCredentials, input, cacheVersion)` directly.

## Env vars

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin writes (never ship to the browser/Worker) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account |
| `CLOUDFLARE_KV_NAMESPACE_ID` | The same namespace the Worker binds as `SITE_CACHE` |
| `CLOUDFLARE_API_TOKEN` | Token with `Workers KV Storage:Edit` on that namespace |
| `ADMIN_API_SECRET` | Bearer token guarding the publish endpoint |
| `CACHE_VERSION` | Must equal the Worker's `CACHE_VERSION` |

## Verify

```bash
npm install
npm run typecheck
npm test
```

Then publish a change and confirm the KV key is gone:

```bash
npx wrangler kv key list --binding SITE_CACHE | grep site_cache:v1:demo   # after publish → empty
```
