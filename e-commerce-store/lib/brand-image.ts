import { getSiteUrl } from '@/lib/env';
import { getRequestSiteUrl } from '@/lib/request-url';

/**
 * Server-only image-source resolver for the ImageResponse routes
 * (`app/opengraph-image.tsx`, `app/icon.tsx`).
 *
 * `next/og`'s ImageResponse only accepts ABSOLUTE image sources — an
 * `http(s)://` URL or a `data:` URL. The admin Branding → Logo URL and Share
 * image fields are free text, so a broken placeholder (e.g. the string
 * `"a image url"`) used to crash the ENTIRE social share card with
 * `Image source must be an absolute URL` (a 500 on `/opengraph-image` — which
 * is exactly why link previews showed nothing).
 *
 * Returns '' (callers then fall back to text-only rendering) unless:
 *   - the value is an absolute `http(s)://` or `data:image/…` URL, or
 *   - the value is a root-relative path (`/images/…`, `/uploads/…`) that can
 *     be resolved against the real deployed site URL (env → request host).
 * Anything else is dropped so the card / favicon ALWAYS renders.
 */
export async function resolveBrandImageSource(raw: unknown): Promise<string> {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  if (!value.startsWith('/')) return '';
  const base = String(getSiteUrl() || (await getRequestSiteUrl()) || '').replace(/\/+$/, '');
  return base ? `${base}${value}` : '';
}
