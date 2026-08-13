import { ImageResponse } from 'next/og';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default async function Icon() {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  const logoUrl = String(branding.logoUrl || '').trim();
  const brandName = String(branding.brandName || branding.shareTitle || 'GOYUNIR');
  const background = String(branding.iconBackground || branding.shareBackground || '#0B0B0F');
  const textColor = String(branding.iconText || branding.shareText || '#D4AF37');

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
}