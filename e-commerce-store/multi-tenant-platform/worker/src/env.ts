/**
 * Worker bindings. `SITE_CACHE` comes from the KV namespace in wrangler.toml;
 * everything else is a var or a secret (`wrangler secret put`).
 */
export interface Env {
  SITE_CACHE: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  PLATFORM_ROOT_DOMAIN: string;
  SITE_CACHE_TTL_SECONDS?: string;
  CACHE_VERSION?: string;
  /**
   * Shared bearer secret guarding `POST /api/flush-cache` (set via
   * `wrangler secret put FLUSH_CACHE_SECRET`). The Admin Portal must send
   * `Authorization: Bearer <this value>` when it invalidates a tenant's cache.
   */
  FLUSH_CACHE_SECRET?: string;
}
