/**
 * Cross-platform scheduled-invocation authentication.
 *
 * The store's safety-net jobs (auto-draw, recovery emails, social tick) are
 * plain HTTP endpoints so ANY scheduler can run them:
 *
 *   - Vercel cron        → vercel.json. Vercel signs the request with the
 *                          `x-vercel-cron: 1` header (trusted directly).
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

/** True when the request carries a platform-issued scheduler signature that is
 * trusted WITHOUT a secret. Vercel Cron sets `x-vercel-cron: 1`; other
 * platforms' scheduled jobs reach these endpoints as plain HTTP calls and are
 * authenticated by secret instead. */
export function isPlatformScheduledInvocation(request: Request): boolean {
  return request.headers.get('x-vercel-cron') === '1';
}

/**
 * Authorize a scheduled-invocation request against the configured secret
 * (`CRON_SECRET` or the admin password — the same fallback every cron route
 * used). Returns true when:
 *
 *   - no secret is configured and `openWhenNoSecret` is true (the historical
 *     behavior of the recovery/social-tick routes, kept for backward
 *     compatibility), OR
 *   - the request is a trusted platform scheduler invocation, OR
 *   - `Authorization: Bearer <secret>` / `?key=<secret>` / `x-cron-secret` matches.
 */
export function isCronAuthorized(
  request: Request,
  secret: string,
  opts?: { openWhenNoSecret?: boolean },
): boolean {
  if (!secret) return opts?.openWhenNoSecret === true;
  if (isPlatformScheduledInvocation(request)) return true;
  const url = new URL(request.url);
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (url.searchParams.get('key') === secret) return true;
  if (request.headers.get('x-cron-secret') === secret) return true;
  return false;
}
