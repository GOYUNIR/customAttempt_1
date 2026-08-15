import { ImageResponse } from 'next/og';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { resolveBrandImageForSatori } from '@/lib/brand-image';
import { safeCssColor } from '@/lib/share-card-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default async function Icon() {
  try {
    const redis = createRedisClient();
    const config = await loadStoreConfigCached(redis);
    const branding = config.branding || {};
    // ImageResponse requires ABSOLUTE image URLs AND fetches remote images
    // itself (any failure 500s the route). resolveBrandImageForSatori converts
    // remote/relative logos to data URLs and drops invalid/broken values so the
    // favicon ALWAYS renders — falling back to the brand letter.
    const logoUrl = await resolveBrandImageForSatori(branding.logoUrl);
    const brandName = String(branding.brandName || branding.shareTitle || 'Store');
    const background = safeCssColor(branding.iconBackground || branding.shareBackground, '#0B0B0F');
    const textColor = safeCssColor(branding.iconText || branding.shareText, '#D4AF37');

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background,
            color: textColor,
            fontSize: 16,
            fontWeight: 800,
            letterSpacing: 1,
            overflow: 'hidden',
          }}
        >
          {logoUrl ? (
            <div style={{ display: 'flex', width: '100%', height: '100%' }}>
              <img src={logoUrl} alt={brandName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          ) : (
            <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>{String(brandName).trim().charAt(0).toUpperCase() || 'G'}</div>
          )}
        </div>
      ),
      size,
    );
  } catch (err) {
    console.error('[icon] favicon render failed, serving fallback', err);
    try {
      return new ImageResponse(
        (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0B0B0F',
              color: '#D4AF37',
              fontSize: 16,
              fontWeight: 800,
            }}
          >
            S
          </div>
        ),
        size,
      );
    } catch {
      return new Response('Favicon generation failed', { status: 500 });
    }
  }
}