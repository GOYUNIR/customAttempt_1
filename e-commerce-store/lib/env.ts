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
 *                  → platform system variables (see getSiteUrl below)
 *   Brand name:    BRAND_NAME → NEXT_PUBLIC_SITE_NAME
 *   Support inbox: SUPPORT_EMAIL → REPLY_TO_EMAIL
 *
 * When no explicit site URL is configured, the PLATFORM system variables are
 * appended so a deployed store gets its REAL production domain baked into
 * metadata/OG/email URLs even when the buyer never configured one. Every major
 * host injects these at request time (server-side only):
 *
 *   - Vercel:      VERCEL_PROJECT_PRODUCTION_URL (alias domain, e.g. goyunir.com)
 *                  → VERCEL_URL (per-deployment URL)
 *   - Netlify:     URL (production) → DEPLOY_URL (deploy-specific)
 *   - Cloudflare:  CF_PAGES_URL (Pages production URL)
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

/** Normalize a platform-injected host into a clean `https://host` base.
 * Accepts bare hostnames (VERCEL_URL, DEPLOY_URL, CF_PAGES_URL) or full
 * `https://host` values (Netlify's URL). Rejects anything with whitespace,
 * a `$` placeholder, a path, or a non-http scheme. */
function normalizePlatformBase(value: string): string {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v || /\s/.test(v) || v.includes('$')) return '';
  if (/^https?:\/\//i.test(v)) {
    try {
      const parsed = new URL(v);
      if (!parsed.host) return '';
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '';
    }
  }
  if (v.includes('/') || v.includes('://')) return '';
  return `https://${v}`;
}

/** Canonical public site URL (no trailing slash). Empty when unset OR when the
 * configured value is malformed (e.g. a bare `https:` / `https://` from a
 * partial env paste) so callers never build broken links like `https:///…`. */
export function getSiteUrl(): string {
  const raw = readEnv('NEXT_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL', 'SITE_URL').replace(/\/+$/, '');
  if (raw) {
    // A value like `$vercel_project_production_url` (or `https://$…`) is a
    // platform dashboard's env-var placeholder text that leaked into a
    // configured variable — it is never expanded at runtime, and the URL
    // parser happily accepts `$` inside a hostname, so every og:image /
    // canonical / email URL would point at a NONEXISTENT domain (link previews
    // silently never load). Treat any value containing `$` as unset so callers
    // fall back to the real request host instead of building a broken URL.
    if (raw.includes('$')) return '';
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      const parsed = new URL(raw);
      if (!parsed.host) return '';
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '';
    }
  }
  // No explicit site URL configured. Platforms inject system variables at
  // request time (server-side only) — prefer the production alias over the
  // per-deployment URL so emails/metadata always tag the real domain:
  //   Vercel:      VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL
  //   Netlify:     URL (production) → DEPLOY_URL (deploy-specific)
  //   Cloudflare:  CF_PAGES_URL (Pages production)
  const platformHost = readEnv(
    'VERCEL_PROJECT_PRODUCTION_URL',
    'VERCEL_URL',
    'URL',
    'DEPLOY_URL',
    'CF_PAGES_URL',
  ).replace(/\/+$/, '');
  if (platformHost) {
    const normalized = normalizePlatformBase(platformHost);
    if (normalized) return normalized;
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
