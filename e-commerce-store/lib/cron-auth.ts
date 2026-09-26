/**
 * Cross-platform scheduled-invocation authentication.
 *
 * The store's safety-net jobs (auto-draw, recovery emails, social tick) are
 * plain HTTP endpoints so ANY scheduler can run them:
 *
 *   - Vercel cron        → vercel.json. With CRON_SECRET set, Vercel sends
 *                          `Authorization: Bearer $CRON_SECRET` itself. The
 *                          `x-vercel-cron` header is NOT trusted (see below).
 *   - Netlify scheduled  → netlify/functions/cron-tasks.mjs fetches the same
 *                          endpoints with `Authorization: Bearer $CRON_SECRET`.
 *   - Cloudflare Workers → cron-worker/ is a tiny scheduled worker that fetches
 *                          the endpoints with the same bearer token.
 *   - Anything else      → cron-job.org, GitHub Actions, QStash, UptimeRobot,
 *                          self-hosted crontab… hit the endpoint with
 *                          `Authorization: Bearer $CRON_SECRET` (the legacy
 *                          `?key=` query and `x-cron-secret` header are also
 *                          accepted for schedulers with limited header control).
 *
 * This module is intentionally dependency-free so the `node --test` runner can
 * load it directly (see tests/cron-auth.test.ts).
 */

/**
 * NO HEADER IS TRUSTED AS PROOF OF A SCHEDULER. This used to return true for
 * `x-vercel-cron: 1`, which any client can send: on this deployment
 * (Cloudflare, where nothing strips it) `curl -H "x-vercel-cron: 1"` ran the
 * social-proof tick on production, and the same header authorized both raffle
 * DRAW routes and the recovery emails (verified 2026-09-26, HARDENING in
 * TENANCY.md). Every scheduler authenticates with the secret instead,
 * including Vercel's, which sends the bearer itself when CRON_SECRET is set.
 * Kept (always false) so no caller silently regains the old trust.
 */
export function isPlatformScheduledInvocation(_request: Request): boolean {
  return false;
}

/** Constant-time string comparison (no `node:crypto` import — mirrors
 *  middleware.ts's `timingSafeStringEq`, kept here dependency-free). A plain
 *  `===` on the cron secret would leak how many leading characters an
 *  attacker's guess got right via response timing. */
function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authorize a scheduled-invocation request against the configured secret
 * (`CRON_SECRET` or the admin password — the same fallback every cron route
 * used). Returns true when:
 *
 *   - no secret is configured and `openWhenNoSecret` is true (the historical
 *     behavior of the recovery/social-tick routes, kept for backward
 *     compatibility), OR
 *   - `Authorization: Bearer <secret>` / `?key=<secret>` / `x-cron-secret` matches.
 */
export function isCronAuthorized(
  request: Request,
  secret: string,
  opts?: { openWhenNoSecret?: boolean },
): boolean {
  if (!secret) return opts?.openWhenNoSecret === true;
  const url = new URL(request.url);
  const bearer = request.headers.get('authorization') || '';
  if (bearer.startsWith('Bearer ') && timingSafeStringEq(bearer.slice(7), secret)) return true;
  const keyParam = url.searchParams.get('key');
  if (keyParam && timingSafeStringEq(keyParam, secret)) return true;
  const headerSecret = request.headers.get('x-cron-secret');
  if (headerSecret && timingSafeStringEq(headerSecret, secret)) return true;
  return false;
}
