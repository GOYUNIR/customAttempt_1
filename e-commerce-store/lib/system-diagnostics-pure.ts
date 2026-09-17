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
 * Can anybody actually SIGN IN?
 *
 * The password grant needs SUPABASE_ANON_KEY. Without it `supabaseConfigured()`
 * is false, the whole Supabase branch of /api/admin/login is skipped, and every
 * staff account — including the master super-admin and every invited member —
 * gets "Invalid email or password" for a correct password.
 *
 * That failure is SILENT by construction: the branch does not error, it simply
 * does not run, and the caller sees the same 401 a wrong password produces. A
 * deployment can therefore look completely healthy while nobody can sign in,
 * which is exactly the class of gap this file exists to surface.
 *
 * ERROR, not a warning, when a service key is present without an anon key:
 * that combination means Supabase is genuinely in use (so accounts exist there)
 * while the only way to authenticate against it is missing. The legacy
 * ADMIN_BASIC_AUTH_PASSWORD may still let ONE operator in, which is what makes
 * this so easy to miss — it is reported separately below rather than treated
 * as "fine".
 */
export function checkStaffSignIn(env: Record<string, string | undefined> = process.env): Check {
  const url = String(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const anon = String(env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const service = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const basicAuth = String(env.ADMIN_BASIC_AUTH_PASSWORD || '').trim();
  const id = 'staff_sign_in';
  const label = 'Staff sign-in (Supabase password grant)';

  if (!url && !service) {
    return {
      id, label, status: 'not_configured',
      detail: 'Supabase is not configured on this deployment, so staff sign-in runs on ADMIN_BASIC_AUTH_PASSWORD alone.',
    };
  }
  if (url && anon) {
    return { id, label, status: 'ok', detail: 'SUPABASE_ANON_KEY is present — the password grant can run, so invited staff can sign in.' };
  }
  return {
    id, label, status: 'error',
    detail:
      'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set but SUPABASE_ANON_KEY is MISSING. The password grant cannot run, so the Supabase branch of /api/admin/login never executes and EVERY staff account — including invited members — gets "Invalid email or password" for a correct password.' +
      (basicAuth
        ? ' ADMIN_BASIC_AUTH_PASSWORD is set, so one operator can still get in, which is what makes this easy to miss.'
        : ' No ADMIN_BASIC_AUTH_PASSWORD either, so NOBODY can sign in at all.'),
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

/**
 * Is the tenant's store config actually reachable by the storefront?
 *
 * Exists because SEV-2 ran undetected: tenant_store_config had never had a
 * row, readCatalogFromPostgres turned that into `config: {}`, and the live
 * storefront served built-in defaults while the merchant believed their
 * branding, copy and theme were live. Every existing check passed throughout,
 * because nothing was failing — the wrong answer was simply plausible.
 *
 * The signal is the COMBINATION: products but no config row. A tenant with
 * neither is just new, and a row whose config is empty is a legitimate choice.
 */
export function checkTenantStoreConfig(productCount: number, hasConfigRow: boolean): Check {
  const products = Math.max(0, Math.floor(productCount) || 0);
  if (hasConfigRow) {
    return {
      id: 'tenant_store_config',
      label: 'Store Configuration',
      status: 'ok',
      detail: 'The tenant has a store-config row; the storefront serves its real settings.',
    };
  }
  if (products === 0) {
    return {
      id: 'tenant_store_config',
      label: 'Store Configuration',
      status: 'not_configured',
      detail: 'No store config yet, and no products either — expected for a new tenant.',
    };
  }
  return {
    id: 'tenant_store_config',
    label: 'Store Configuration',
    status: 'error',
    detail:
      `${products} product(s) are live but this tenant has NO store-config row, so the storefront ` +
      'is serving default branding, copy and theme instead of the merchant\'s own (SEV-2). ' +
      'Run scripts/restore-store-config.ts to repair.',
  };
}
