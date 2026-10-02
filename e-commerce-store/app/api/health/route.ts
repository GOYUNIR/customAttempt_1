import { readSupabaseEnv } from '@/services/config/supabase-client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health: for uptime monitors (RELEASE-PLAN.md §10).
 *
 * Cheap and reveals nothing: the Worker answered, and the database answered
 * one tiny public-reference read within 2 seconds. No versions, hosts, keys,
 * counts or error text. 200 {"status":"ok"} or 503 {"status":"degraded"}.
 * Never cached, so a monitor sees now, not a minute ago.
 */
export async function GET() {
  const started = Date.now();
  let db = false;
  try {
    const env = readSupabaseEnv();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(env.url.replace(/\/+$/, '') + '/rest/v1/plans?select=id&limit=1', {
      headers: { apikey: env.serviceRoleKey, authorization: 'Bearer ' + env.serviceRoleKey },
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    db = r.ok;
  } catch {
    db = false;
  }
  return new Response(JSON.stringify({ status: db ? 'ok' : 'degraded', db: db ? 'ok' : 'unreachable', ms: Date.now() - started }), {
    status: db ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
