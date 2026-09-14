/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SYSTEM DIAGNOSTICS — the pure (no I/O) checks, split out from
 * lib/system-diagnostics.ts for the same reason lib/admin-actor.ts /
 * lib/b2b/* / lib/raffle-draw.ts are their own files: the `@/` path alias
 * lib/system-diagnostics.ts needs for its I/O checks (Redis, Supabase)
 * only resolves through Next.js's own bundler, so a check that needs
 * direct `node --test` coverage can't live in that file, even indirectly.
 *
 * Only relative imports here (never `@/`) — `lib/csrf.ts` is itself a
 * zero-import pure module, so importing it by relative path keeps this
 * file fully `node --test`-loadable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CSRF_AUTH_COOKIES, CSRF_EXEMPT_PREFIXES } from './csrf.ts';

export type CheckStatus = 'ok' | 'warning' | 'error' | 'not_configured';
export type Check = { id: string; label: string; status: CheckStatus; detail: string };

/** CSRF is unconditionally enforced in middleware — not a runtime toggle —
 *  so this always reports 'ok'; it exists to SHOW the coverage (which
 *  cookies, which paths are exempt and why), not to detect a failure mode. */
export function checkCsrf(): Check {
  return {
    id: 'csrf',
    label: 'Anti-CSRF (Origin verification)',
    status: 'ok',
    detail: `Enforced in middleware for ${CSRF_AUTH_COOKIES.length} cookie-authenticated session type(s); ${CSRF_EXEMPT_PREFIXES.length} signature/secret-authenticated path(s) exempted.`,
  };
}

/** In production, destructive admin actions (wipe, seed) must be
 *  hard-blocked unless explicitly opted in for THIS deployment right now
 *  (see app/api/admin/wipe/route.ts) — a readiness check should fail loud
 *  if that opt-in was left on from a previous one-off operation. */
export function checkNoDestructiveActionsAllowed(env: Record<string, string | undefined> = process.env): Check {
  const inProduction = env.NODE_ENV === 'production';
  const flagOn = env.ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN === 'true';
  if (!inProduction) {
    return { id: 'destructive_actions', label: 'Destructive Admin Actions', status: 'ok', detail: 'Not running in production — check does not apply.' };
  }
  if (flagOn) {
    return {
      id: 'destructive_actions',
      label: 'Destructive Admin Actions',
      status: 'error',
      detail: 'ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN=true is set in a production environment — wipe/seed are unlocked. Unset it unless a destructive action is intentionally in progress right now.',
    };
  }
  return { id: 'destructive_actions', label: 'Destructive Admin Actions', status: 'ok', detail: 'Hard-blocked (ALLOW_PRODUCTION_DESTRUCTIVE_ADMIN is not set to true).' };
}

export function checkCloudflareConfigured(env: Record<string, string | undefined> = process.env): Check {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
    return { id: 'cloudflare', label: 'Cloudflare for SaaS', status: 'not_configured', detail: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set — custom domains disabled.' };
  }
  return { id: 'cloudflare', label: 'Cloudflare for SaaS', status: 'ok', detail: 'API token and zone configured.' };
}
