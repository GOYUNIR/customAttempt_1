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
}
