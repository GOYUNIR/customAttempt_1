import { ImageResponse } from 'next/og';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default async function Icon() {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  const logoUrl = String(branding.logoUrl || '').trim();
  const background = String(branding.iconBackground || branding.shareBackground || '#111111');
  const textColor = String(branding.iconText || branding.shareText || '#ffffff');

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
            <img src={logoUrl} alt="GOYUNIR" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
        ) : (
          <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>G</div>
        )}
      </div>
    ),
    size,
  );
}