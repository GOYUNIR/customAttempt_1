/**
 * Netlify scheduled function — the platform's equivalent of the Vercel cron.
 *
 * Netlify's scheduler (netlify.toml → [functions."cron-tasks"].schedule)
 * invokes this function once a day. It pings the app's own safety-net
 * endpoints with the shared CRON_SECRET (the same contract the Vercel cron and
 * the Cloudflare cron worker use — see lib/cron-auth.ts):
 *
 *   - /api/checkout/cron-draw   → the Redis-driven auto-draw engine
 *   - /api/cron/recovery        → entry-recovery reminder emails
 *   - /api/analytics/social-tick → social-proof counter tick
 *
 * Environment:
 *   - CRON_SECRET  (required) — same secret value used on any other platform
 *   - URL          Netlify injects the production URL automatically; falls
 *                  back to DEPLOY_PRIME_URL / NEXT_PUBLIC_URL for safety.
 */
export default async () => {
  const base = String(
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.NEXT_PUBLIC_URL || ''
  ).replace(/\/+$/, '');
  const secret = process.env.CRON_SECRET || '';

  if (!base || !secret) {
    console.warn('[cron-tasks] SKIPPED — CRON_SECRET or site URL not configured');
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, skipped: true, reason: 'CRON_SECRET or site URL not set' }),
    };
  }

  const results = {};
  for (const path of ['/api/checkout/cron-draw', '/api/cron/recovery', '/api/analytics/social-tick']) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(50_000),
      });
      results[path] = { status: res.status };
      await res.text();
    } catch (err) {
      console.error(`[cron-tasks] ${path} failed`, err?.message || err);
      results[path] = { error: String(err?.message || err) };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
};
