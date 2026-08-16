import { headers } from 'next/headers';

/**
 * Server-only site-URL resolver for the CURRENT request (imports next/headers,
 * so this module must never be imported by a client component).
 *
 * Used by `generateMetadata` / the OG-image route so canonical, og:url and
 * og:image tags always point at the real deployed domain — even when the buyer
 * never set NEXT_PUBLIC_URL / NEXT_PUBLIC_SITE_URL / SITE_URL and left the
 * admin Branding → Share URL empty. Without this, link previews fell back to a
 * stock "https://example.com" placeholder and messengers showed a broken
 * generic card. Returns '' when called outside a request context (never throws).
 */
export async function getRequestSiteUrl(): Promise<string> {
  try {
    const h = await headers();
    const forwardedHost = h.get('x-forwarded-host');
    const host = String(forwardedHost || h.get('host') || '')
      .split(',')[0]
      .trim();
    // A `$` in the host is an unresolved Vercel placeholder (never a real
    // domain) — reject it so metadata/OG URLs can't point at a nonexistent host.
    if (!host || host.includes('$')) return '';
    const forwardedProto = h.get('x-forwarded-proto');
    const proto = String(forwardedProto || 'https').split(',')[0].trim() || 'https';
    return `${proto}://${host}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
