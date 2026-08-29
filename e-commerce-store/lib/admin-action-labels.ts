/**
 * Single source of truth for admin-action labels shared across the admin
 * portal UI, API self-test output, and docs.
 *
 * These used to be hardcoded (and inconsistent) in multiple places — e.g. the
 * Developer tab titled a card "Tidy Redis Schema" while its button read
 * "Tidy & Migrate Redis Schema". Keeping the exact wording in one module means
 * the UI and the API can never drift apart again.
 *
 * This file has ZERO imports on purpose so it stays edge-safe and loadable by
 * the `node --test` runner (no `@/` alias).
 */

/** Canonical label for the Redis tidy/migrate maintenance action. */
export const TIDY_REDIS_ACTION_LABEL = 'Tidy & Migrate Redis Schema';

/** Canonical label for the third-party provider keys section. */
export const API_KEYS_INTEGRATIONS_LABEL = 'API Keys & Integrations';

/**
 * Human display name for the ACTIVE data store. The admin portal used to
 * hardcode "Redis" in several places, but the template can run on Supabase
 * (default), Upstash Redis, or Cloudflare KV — so labels are now derived from
 * the same storage-provider string the rest of the app uses
 * (`lib/env-discovery.ts` → `detectStorageProvider()`).
 */
export function dataStoreDisplayName(provider?: string | null): string {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'upstash' || p === 'redis') return 'Redis';
  if (p === 'supabase' || p === 'postgres' || p === 'pg') return 'Supabase';
  if (p === 'cloudflare-kv' || p === 'kv' || p === 'd1' || p === 'workers-kv') return 'Cloudflare KV';
  return 'Data Store';
}

/**
 * Canonical label for the schema tidy/migrate maintenance action, parameterised
 * by the active data store. Keeps the old Redis wording for Redis-backed
 * installs while correctly naming Supabase / Cloudflare KV / generic stores
 * everywhere else (the /admin → System card, its button, and any docs).
 */
export function tidyDataStoreActionLabel(provider?: string | null): string {
  const name = dataStoreDisplayName(provider);
  return `Tidy & Migrate ${name} Schema`;
}
