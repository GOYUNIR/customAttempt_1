/**
 * SYSTEM DIAGNOSTICS — the checks behind both the admin "System Health &
 * Security Diagnostic Panel" (app/api/admin/system-health) and
 * scripts/production-readiness-check.ts. One shared implementation so the
 * two surfaces can never silently drift apart.
 *
 * Every check probes REAL state — a Redis lock is actually acquired, the
 * anon key actually attempts a read against sensitive tables, dedupe
 * counters are actually read — never a static "yes we have this configured"
 * claim.
 */

import { createRedisClient } from '@/lib/server-config';
import { readDeadLetteredNotifications } from '@/lib/notifications';
import { withRedisLock } from '@/lib/redis-lock';
import { validateProductionEnv } from '@/lib/env-schema';
import { PROCESSED_SESSIONS_KEY } from '@/lib/redis-keys';
import { DEDUPE_PROCESSED_WINDOW_MS } from '@/lib/redis-maintenance';
import { supabaseServiceConfigured, supabaseRestFetch, readSupabaseEnv } from '@/services/config/supabase-client';
import { getDb } from '@/lib/db/client';
import { cloudflareConfigured } from '@/lib/cloudflare-saas';
import {
  checkCsrf,
  checkNoDestructiveActionsAllowed,
  checkCloudflareConfigured,
  checkPortalIsolation,
  type Check,
  type CheckStatus,
  checkNotificationDeadLetter,
} from '@/lib/system-diagnostics-pure';

export type { Check, CheckStatus };
export { checkCsrf, checkNoDestructiveActionsAllowed, checkCloudflareConfigured, checkPortalIsolation };

export function checkEnvSchema(): Check {
  const { errors, warnings } = validateProductionEnv();
  if (errors.length > 0) {
    return { id: 'env_schema', label: 'Zod Env Configuration', status: 'error', detail: `${errors.length} malformed value(s): ${errors.map((e) => e.field).join(', ')}` };
  }
  if (warnings.length > 0) {
    return { id: 'env_schema', label: 'Zod Env Configuration', status: 'warning', detail: `${warnings.length} weak value(s): ${warnings.map((w) => w.field).join(', ')}` };
  }
  return { id: 'env_schema', label: 'Zod Env Configuration', status: 'ok', detail: 'No malformed or weak production secrets detected.' };
}

/** Probes each sensitive table with the ANON key (never the service-role
 *  key) and confirms RLS actually blocks it. */
export async function checkRlsCoverage(): Promise<Check> {
  if (!supabaseServiceConfigured()) {
    return { id: 'rls', label: 'Supabase RLS Coverage', status: 'not_configured', detail: 'Supabase is not configured.' };
  }
  const { anonKey } = readSupabaseEnv();
  if (!anonKey) {
    return { id: 'rls', label: 'Supabase RLS Coverage', status: 'warning', detail: 'No anon key configured — cannot probe RLS as an unprivileged client.' };
  }
  const sensitiveTables = ['audit_logs', 'orders', 'customers', 'companies', 'quotes', 'raffle_entries'];
  const leaks: string[] = [];
  for (const table of sensitiveTables) {
    try {
      // DELIBERATELY NOT via the DbClient port: the port authenticates with the
      // SERVICE-ROLE key, which bypasses RLS by design. This probe's whole
      // purpose is to attempt the read as an UNPRIVILEGED anon client, so
      // routing it through the port would make it pass unconditionally and
      // silently stop testing anything. See the permanent fence exemption.
      const rows = (await supabaseRestFetch(`/${table}?select=id&limit=1`, { key: anonKey })) as unknown[];
      if (Array.isArray(rows) && rows.length > 0) leaks.push(table);
    } catch {
      // Expected: a thrown request (401/403/permission error) means RLS
      // did its job. Only a successful read with rows is a leak.
    }
  }
  if (leaks.length > 0) {
    return { id: 'rls', label: 'Supabase RLS Coverage', status: 'error', detail: `Anon key can read: ${leaks.join(', ')} — RLS policy missing or misconfigured.` };
  }
  return { id: 'rls', label: 'Supabase RLS Coverage', status: 'ok', detail: `Anon key correctly blocked from ${sensitiveTables.length} sensitive table(s).` };
}

/** Verifies Supabase is actually reachable (a real REST round-trip with the
 *  service-role key), not just "an env var is set". */
export async function checkSupabaseConnection(): Promise<Check> {
  if (!supabaseServiceConfigured()) {
    return { id: 'supabase_connection', label: 'Supabase Connection', status: 'not_configured', detail: 'SUPABASE_SERVICE_ROLE_KEY not set.' };
  }
  try {
    await getDb().select('tenants', { select: ['id'], limit: 1 });
    return { id: 'supabase_connection', label: 'Supabase Connection', status: 'ok', detail: 'Service-role REST request succeeded.' };
  } catch (err) {
    return { id: 'supabase_connection', label: 'Supabase Connection', status: 'error', detail: (err as Error)?.message || 'Request failed.' };
  }
}

/** Actually acquires and releases a real lock — not a config check. */
export async function checkRedisLocks(): Promise<Check> {
  const redis = createRedisClient();
  if (!redis) return { id: 'redis_locks', label: 'Redis Atomic Locks', status: 'not_configured', detail: 'No Redis/KV backend configured.' };
  const start = Date.now();
  const result = await withRedisLock(redis, 'system-health-diagnostic-ping', async () => true, { ttlSeconds: 5, retries: 1 });
  const latencyMs = Date.now() - start;
  if (!result.ok) {
    return { id: 'redis_locks', label: 'Redis Atomic Locks', status: 'error', detail: 'Failed to acquire a diagnostic lock — checkout/inventory locking may be degraded.' };
  }
  return { id: 'redis_locks', label: 'Redis Atomic Locks', status: 'ok', detail: `Lock acquire+release round-trip in ${latencyMs}ms.` };
}

export async function checkWebhookIdempotency(): Promise<Check> {
  const redis = createRedisClient();
  if (!redis) return { id: 'webhook_idempotency', label: 'Stripe Webhook Idempotency', status: 'not_configured', detail: 'No Redis/KV backend configured.' };
  try {
    // The dedupe key self-migrates from a legacy SET to a ZSET on its next
    // WRITE (lib/redis-maintenance.ts's ensureDedupeZset) — a read-only
    // diagnostic must never assume the zset shape already exists, or a
    // perfectly healthy, simply-not-yet-migrated install reports a scary
    // WRONGTYPE error instead of the truth.
    const keyType = await redis.type(PROCESSED_SESSIONS_KEY);
    if (keyType === 'none') {
      return {
        id: 'webhook_idempotency',
        label: 'Stripe Webhook Idempotency',
        status: 'ok',
        detail: 'Atomic claim-based dedupe active (no webhook events processed yet).',
      };
    }
    if (keyType === 'set') {
      const legacyCount = await redis.smembers(PROCESSED_SESSIONS_KEY).then((m) => m.length);
      return {
        id: 'webhook_idempotency',
        label: 'Stripe Webhook Idempotency',
        status: 'ok',
        detail: `Atomic claim-based dedupe active (${legacyCount} session(s) tracked in a legacy SET — self-migrates to a bounded ZSET on the next webhook).`,
      };
    }
    const processedCount = await redis.zcard(PROCESSED_SESSIONS_KEY);
    return {
      id: 'webhook_idempotency',
      label: 'Stripe Webhook Idempotency',
      status: 'ok',
      detail: `Atomic claim-based dedupe active (${processedCount} session(s) tracked in the last ${Math.round(DEDUPE_PROCESSED_WINDOW_MS / 86_400_000)} days).`,
    };
  } catch (err) {
    return { id: 'webhook_idempotency', label: 'Stripe Webhook Idempotency', status: 'warning', detail: (err as Error)?.message || 'Could not read dedupe state.' };
  }
}

/** A live Cloudflare API call (not just "the env vars are set") — used by
 *  the CLI readiness check where a network round-trip is expected/desired;
 *  NOT used by the admin panel (which stays cheap for every page load). */
export async function checkCloudflareLive(): Promise<Check> {
  if (!cloudflareConfigured()) {
    return { id: 'cloudflare_live', label: 'Cloudflare API Credentials', status: 'not_configured', detail: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set.' };
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ message?: string }> } | null;
    if (!res.ok || !json?.success) {
      return { id: 'cloudflare_live', label: 'Cloudflare API Credentials', status: 'error', detail: json?.errors?.[0]?.message || `HTTP ${res.status}` };
    }
    return { id: 'cloudflare_live', label: 'Cloudflare API Credentials', status: 'ok', detail: 'Token verified against the configured zone.' };
  } catch (err) {
    return { id: 'cloudflare_live', label: 'Cloudflare API Credentials', status: 'error', detail: (err as Error)?.message || 'Request failed.' };
  }
}

export async function runAllHealthChecks(): Promise<Check[]> {
  const [rls, redisLocks, webhookIdempotency, supabaseConnection, deadLettered] = await Promise.all([
    checkRlsCoverage(),
    checkRedisLocks(),
    checkWebhookIdempotency(),
    checkSupabaseConnection(),
    // Customers charged but never told. Read here so the pure check stays
    // directly testable (ARCHITECTURE.md SEV-3).
    readDeadLetteredNotifications(50).then((jobs) => jobs.length).catch(() => 0),
  ]);
  return [
    checkEnvSchema(),
    checkCsrf(),
    checkPortalIsolation(),
    rls,
    redisLocks,
    webhookIdempotency,
    checkCloudflareConfigured(),
    supabaseConnection,
    checkNotificationDeadLetter(deadLettered),
  ];
}

export function summarizeChecks(checks: Check[]) {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warning: checks.filter((c) => c.status === 'warning').length,
    error: checks.filter((c) => c.status === 'error').length,
    notConfigured: checks.filter((c) => c.status === 'not_configured').length,
  };
}
