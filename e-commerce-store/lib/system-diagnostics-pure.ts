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
import { portalIsolationStatus } from './edge-router.ts';

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

/** Portal isolation must never be OFF by accident in production — see
 *  `portalIsolationStatus()` in lib/edge-router.ts for why this fails closed
 *  at the deploy gate rather than at runtime. */
export function checkPortalIsolation(env: Record<string, string | undefined> = process.env): Check {
  const status = portalIsolationStatus(env);
  if (status === 'active') {
    return {
      id: 'portal_isolation',
      label: 'Portal Isolation (subdomain tiers)',
      status: 'ok',
      detail: `Enforced against PLATFORM_ROOT_DOMAIN=${env.PLATFORM_ROOT_DOMAIN} — /admin and /sales are reachable only from their own hosts.`,
    };
  }
  if (status === 'single-domain') {
    return {
      id: 'portal_isolation',
      label: 'Portal Isolation (subdomain tiers)',
      status: 'not_configured',
      detail: 'Single-domain mode — every portal shares one host. Set PLATFORM_ROOT_DOMAIN to enable per-subdomain isolation.',
    };
  }
  return {
    id: 'portal_isolation',
    label: 'Portal Isolation (subdomain tiers)',
    status: 'error',
    detail:
      'PLATFORM_ROOT_DOMAIN is unset in production, so /admin and /sales are reachable from ANY host (including merchant custom domains) and the per-portal role split is off. Set PLATFORM_ROOT_DOMAIN, or set PLATFORM_SINGLE_DOMAIN_MODE=true to declare single-domain operation deliberately.',
  };
}

/**
 * Dead-lettered notifications = customers charged but never told.
 *
 * Pure so it is directly testable: the caller reads the dead-letter list and
 * passes its size. Anything above zero is an ERROR, not a warning — someone
 * paid and received no confirmation, and the only way that gets noticed is if
 * something says so out loud.
 */
export function checkNotificationDeadLetter(deadLetterCount: number): Check {
  const n = Math.max(0, Math.floor(deadLetterCount) || 0);
  if (n === 0) {
    return {
      id: 'notification_dead_letter',
      label: 'Notification Delivery',
      status: 'ok',
      detail: 'No undelivered transactional notifications.',
    };
  }
  return {
    id: 'notification_dead_letter',
    label: 'Notification Delivery',
    status: 'error',
    detail:
      `${n} notification(s) exhausted every retry — these customers were charged and never told. ` +
      'Inspect the dead-letter list and contact them manually.',
  };
}
