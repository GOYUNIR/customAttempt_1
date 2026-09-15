/**
 * DATABASE REQUEST POLICY — timeouts, retry eligibility, backoff.
 * Pure, zero-import (see tests/db-timeout-policy.test.ts).
 *
 * Phase B item 6. This app reaches Postgres exclusively through PostgREST over
 * HTTPS — there is no pg driver and no client-side connection pool to tune
 * (Supabase pools server-side). The real exposure is that every one of those
 * calls was a bare `fetch` with NO timeout: a slow or hung Supabase response
 * would occupy the request until the platform killed it.
 *
 * Two tiers, because a storefront read and a nightly backfill want opposite
 * things. An interactive request should fail fast — a user waiting 15s has
 * already left. A background job should be patient; failing it fast just means
 * re-running the whole job.
 *
 * THE SAFETY RULE: only idempotent methods are ever retried. Retrying a POST
 * or PATCH against PostgREST can duplicate a row — an order, a raffle entry, a
 * ledger line. A timeout does not tell you whether the server applied the
 * write, so the only safe assumption is that it did.
 */

export type DbTier = 'interactive' | 'background';
export type DbMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 5_000;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 15_000;

/** Clamp to a sane band — a 0ms or 10-minute timeout is always a mistake. */
function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_INTERACTIVE_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(ms), 250), 60_000);
}

function readIntEnv(env: Record<string, string | undefined>, name: string): number | null {
  const raw = String(env[name] || '').trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Timeout for one request. Env overrides, most specific first:
 *   SUPABASE_TIMEOUT_MS_INTERACTIVE / SUPABASE_TIMEOUT_MS_BACKGROUND
 *   SUPABASE_TIMEOUT_MS  (applies to both)
 */
export function resolveTimeoutMs(
  tier: DbTier,
  env: Record<string, string | undefined> = {},
): number {
  const specific = readIntEnv(
    env,
    tier === 'interactive' ? 'SUPABASE_TIMEOUT_MS_INTERACTIVE' : 'SUPABASE_TIMEOUT_MS_BACKGROUND',
  );
  if (specific !== null) return clampTimeout(specific);
  const shared = readIntEnv(env, 'SUPABASE_TIMEOUT_MS');
  if (shared !== null) return clampTimeout(shared);
  return tier === 'interactive' ? DEFAULT_INTERACTIVE_TIMEOUT_MS : DEFAULT_BACKGROUND_TIMEOUT_MS;
}

/**
 * Is this method safe to retry? GET only.
 *
 * DELETE is idempotent in the HTTP spec, but PostgREST DELETEs here carry
 * filters and often run inside multi-step flows, and a retried DELETE that
 * races a concurrent insert removes a row the caller never saw. Not worth it.
 */
export function isRetryableMethod(method: DbMethod): boolean {
  return method === 'GET';
}

/** Transient conditions worth a second attempt. 4xx (except 408/429) is not. */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

export const MAX_DB_ATTEMPTS = 3;

/** Exponential backoff with a deterministic base (jitter is added by the caller). */
export function retryDelayMs(attempt: number): number {
  const base = 100;
  const capped = Math.min(attempt, 5);
  return base * Math.pow(3, Math.max(0, capped - 1));
}

/** Should attempt `attempt` (1-based) be followed by another? */
export function shouldRetry(opts: {
  method: DbMethod;
  attempt: number;
  status?: number;
  networkError?: boolean;
  maxAttempts?: number;
}): boolean {
  const max = opts.maxAttempts ?? MAX_DB_ATTEMPTS;
  if (opts.attempt >= max) return false;
  if (!isRetryableMethod(opts.method)) return false;
  if (opts.networkError) return true;
  if (typeof opts.status === 'number') return isRetryableStatus(opts.status);
  return false;
}
