/**
 * Central environment-variable accessors.
 *
 * The template is white-label: every brand-facing value (site URL, brand
 * name, support inbox) must come from the platform environment or the admin
 * portal — NEVER from a hardcoded string in code. These helpers also accept
 * several common aliases so a template buyer can use whichever env-var naming
 * convention their platform gives them:
 *
 *   Site URL:      NEXT_PUBLIC_URL → NEXT_PUBLIC_SITE_URL → SITE_URL
 *                  → VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL
 *   Brand name:    BRAND_NAME → NEXT_PUBLIC_SITE_NAME
 *   Support inbox: SUPPORT_EMAIL → REPLY_TO_EMAIL
 *
 * The Vercel system variables are appended so a store deployed on Vercel gets
 * its REAL production domain baked into metadata/OG/email URLs even when the
 * buyer never configured an explicit site URL (Vercel injects these at request
 * time server-side; `VERCEL_PROJECT_PRODUCTION_URL` is the alias domain, e.g.
 * `goyunir.com`, and `VERCEL_URL` is the per-deployment URL). They are bare
 * hostnames, so they are normalized to `https://host` here.
 *
 * The storefront/admin brand lives in the admin portal (store:config →
 * branding); these helpers are only the *fallback chain* for places that
 * cannot read the portal config (e.g. emails, OG metadata, cron jobs).
 */

function readEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

/** Canonical public site URL (no trailing slash). Empty when unset OR when the
 * configured value is malformed (e.g. a bare `https:` / `https://` from a
 * partial env paste) so callers never build broken links like `https:///…`. */
export function getSiteUrl(): string {
  const raw = readEnv('NEXT_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL', 'SITE_URL').replace(/\/+$/, '');
  if (raw) {
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      const parsed = new URL(raw);
      if (!parsed.host) return '';
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '';
    }
  }
  // No explicit site URL configured. Vercel injects these system variables at
  // request time (server-side only): `VERCEL_PROJECT_PRODUCTION_URL` is the
  // production alias domain (e.g. `goyunir.com`), `VERCEL_URL` the per-deploy
  // URL. Both are bare hostnames → normalize to `https://host`.
  const vercelHost = readEnv('VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL').replace(/\/+$/, '');
  if (vercelHost && !/\s/.test(vercelHost) && !vercelHost.includes('/')) {
    return `https://${vercelHost}`;
  }
  return '';
}

/** Brand name used in emails/metadata. Empty when unset — callers decide the neutral fallback. */
export function getBrandName(): string {
  return readEnv('BRAND_NAME', 'NEXT_PUBLIC_SITE_NAME');
}

/** Support inbox used in emails and policy pages. Empty when unset. */
export function getSupportEmail(): string {
  return readEnv('SUPPORT_EMAIL', 'REPLY_TO_EMAIL');
}

/** Reply-to / support inbox (fallback alias for getSupportEmail). */
export function getReplyToEmail(): string {
  return readEnv('REPLY_TO_EMAIL', 'SUPPORT_EMAIL');
}

/** Neutral brand display string used when no env or admin config exists. */
export function neutralBrandName(): string {
  return getBrandName() || 'Store';
}

/** Neutral site-URL string used in emails/OG when nothing is configured. */
export function fallbackSiteUrl(): string {
  return getSiteUrl() || 'https://example.com';
}
