/**
 * PLATFORM IDENTITY — what platform-level surfaces call themselves.
 *
 * The platform (marketing site, sign-in portals, staff invites, system email)
 * speaks with ITS name from config, never with a store's: GOYUNIR is a tenant
 * that happens to share the placeholder domain. All of it is config:
 *   PLATFORM_NAME          the name (falls back to the root domain)
 *   PLATFORM_DESCRIPTION   one line for link previews (optional)
 * Which PAGES are platform pages is lib/platform-surface.ts.
 */
import { getPlatformName } from '@/lib/env';

export function platformName(): string {
  return getPlatformName() || 'Platform';
}

export function platformDescription(): string {
  return String(process.env.PLATFORM_DESCRIPTION || '').trim();
}
