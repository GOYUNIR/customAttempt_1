import { createElement } from 'react';
import { ImageResponse } from 'next/og';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { getSiteUrl } from '@/lib/env';
import { getRequestSiteUrl } from '@/lib/request-url';
import { resolveBrandImageForSatori } from '@/lib/brand-image';
import { cardSiteUrlDisplay, safeCssColor } from '@/lib/share-card-config';
import ShareCard from '@/components/ShareCard';

/**
 * Social share card PNG (1200×630). This route is what `og:image` /
 * `twitter:image` point at, so WhatsApp, iMessage, Discord, X and Facebook
 * fetch the branded card when someone shares a link.
 *
 * Why a plain Route Handler instead of the `opengraph-image.tsx` file
 * convention? The file convention generated a content-hash `?v=…` URL that
 * NEVER changed when the admin edited branding, so social apps (which cache
 * previews aggressively by URL) kept showing a STALE card forever. This route
 * is fully under `generateMetadata`'s control, which appends a `?v=` derived
 * from the CURRENT branding so the URL changes on every save and crawlers are
 * forced to re-fetch.
 *
 * Hardening: the ENTIRE render is wrapped in try/catch — even a broken admin
 * logo/share-image URL (resolved to '' by `resolveBrandImageForSatori`), an
 * unreachable remote image, or an unexpected renderer error can NEVER turn
 * this route into a 500. Link previews always get a card.
 *
 * NOTE: Next.js Route Handlers must be `route.js|ts` (not `.tsx`), so the
 * React element is built with `createElement` here — no JSX syntax.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const DEFAULT_DESCRIPTION = 'Private releases, handled cleanly.';

export async function GET() {
  // Brand fallback for the catch-branch below (read best-effort so a broken
  // renderer still produces a *branded* fallback card, never a generic one).
  let fallbackBrandName = 'Store';
  try {
    const redis = createRedisClient();
    const config = await loadStoreConfigCached(redis);
    const branding = config.branding || {};
    const themeColors = config.themeColors || {};
    fallbackBrandName = String(branding.brandName || branding.shareTitle || 'Store');

    // Fetch logo + share image as data: URLs so satori can never fail on a
    // slow/broken remote image (invalid values resolve to '' → text-only card).
    const [logoUrl, shareImageUrl] = await Promise.all([
      resolveBrandImageForSatori(branding.logoUrl),
      resolveBrandImageForSatori(branding.shareImageUrl),
    ]);

    const brandName = String(branding.brandName || branding.shareTitle || 'Store');
    const title = String(branding.shareTitle || brandName);
    const description = String(branding.shareDescription || DEFAULT_DESCRIPTION);
    const tagline = String(branding.shareTagline || '');
    const background = safeCssColor(
      branding.shareBackground || themeColors.primaryBackground,
      '#0B0B0F',
    );
    const accent = safeCssColor(
      branding.shareAccent || themeColors.checkoutCtaButton || themeColors.accentBlue || themeColors.accentPurple,
      '#D4AF37',
    );
    const text = safeCssColor(branding.shareText || themeColors.textMain, '#F5F2E9');
    // The URL on the card is NEVER hardcoded: platform env → current request
    // host → admin Branding → Share URL → neutral fallback.
    const siteUrl = cardSiteUrlDisplay(
      getSiteUrl() || (await getRequestSiteUrl()) || branding.shareUrl,
      'example.com',
    );

    return new ImageResponse(
      createElement(ShareCard, {
        brandName,
        title,
        description,
        tagline,
        logoUrl,
        shareImageUrl,
        background,
        accent,
        text,
        siteUrl,
      }),
      {
        ...size,
        // Crawlers/messengers + CDNs must revalidate the PNG — the `?v=`
        // cache-buster on the og:image URL changes when branding changes, but
        // this header stops an intermediary from serving a STALE card PNG that
        // predates a branding save.
        headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
      },
    );
  } catch (err) {
    // Never 500: fall back to a minimal branded card so previews always render.
    console.error('[og] share-card render failed, serving fallback', err);
    try {
      return new ImageResponse(
        createElement(
          'div',
          {
            style: {
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0B0B0F',
              color: '#F5F2E9',
              fontFamily: 'system-ui, sans-serif',
            },
          },
          createElement(
            'div',
            { style: { fontSize: 64, fontWeight: 800, letterSpacing: 6, textTransform: 'uppercase' } },
            fallbackBrandName.slice(0, 24),
          ),
        ),
        {
          ...size,
          headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
        },
      );
    } catch {
      return new Response('OG image generation failed', { status: 500 });
    }
  }
}

