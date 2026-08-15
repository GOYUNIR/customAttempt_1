import { fallbackSiteUrl, getSiteUrl } from './env.ts';

/**
 * Normalize any site-URL value into a clean absolute base (no trailing slash)
 * that can be safely concatenated with a path. Accepts `http(s)://` values and
 * bare domains (`store.example.com` → `https://store.example.com`). Anything
 * malformed (free text, `https:` with no host, `https://`) falls back through
 * getSiteUrl() → fallbackSiteUrl() so email / metadata links can NEVER render
 * as the broken `https:///auth/signup` seen in the wild.
 *
 * This module is intentionally dependency-light (no `@/` alias imports, no
 * server-only packages) so it can be imported by the node --test runner AND by
 * any route/email template.
 */
export function normalizeSiteBase(raw: string | undefined): string {
  let value = String(raw || '').trim();
  if (!value) value = getSiteUrl();
  if (!value) return fallbackSiteUrl();

  if (/^https?:\/\//i.test(value)) {
    // Scheme present — strip trailing slashes. If only `https:` is left the
    // URL parse below rejects it (no host) and we fall back.
    value = value.replace(/\/+$/, '');
    if (/^https?:$/i.test(value)) return fallbackSiteUrl();
  } else if (/^https?:/i.test(value)) {
    // Scheme-only (`https:`) is a broken partial paste, never a domain.
    return fallbackSiteUrl();
  } else if (!/\s/.test(value) && !value.includes('/') && value.includes('.')) {
    // Bare domain (`store.example.com`, optionally with a port) → https.
    value = `https://${value}`;
  } else {
    return fallbackSiteUrl();
  }

  try {
    const parsed = new URL(value);
    if (!parsed.hostname) throw new Error('no host');
    // URL() happily parses `https://https:` as host "https" — reject scheme-only.
    if (/^https?$/i.test(parsed.host)) throw new Error('scheme only');
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallbackSiteUrl();
  }
}
