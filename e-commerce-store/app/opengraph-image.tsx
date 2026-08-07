import { ImageResponse } from 'next/og';
import { createRedisClient, loadStoreConfig } from '@/lib/server-config';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

export default async function OpenGraphImage() {
  const redis = createRedisClient();
  const config = await loadStoreConfig(redis);
  const branding = config.branding || {};
  const logoUrl = String(branding.logoUrl || '').trim();
  const title = String(branding.shareTitle || 'GOYUNIR');
  const description = String(branding.shareDescription || 'Luxury raffle drops and direct releases built for high-intent mobile traffic.');
  const background = String(branding.shareBackground || '#050505');
  const accent = String(branding.shareAccent || '#3b82f6');
  const text = String(branding.shareText || '#ffffff');

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px 68px',
          background: `radial-gradient(circle at 18% 18%, ${accent}55, transparent 32%), radial-gradient(circle at 82% 12%, rgba(168,85,247,0.28), transparent 30%), ${background}`,
          color: text,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {logoUrl ? <img src={logoUrl} alt={title} style={{ width: 68, height: 68, borderRadius: 16, objectFit: 'cover', border: `1px solid ${accent}55` }} /> : null}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ letterSpacing: 6, fontSize: 24, fontWeight: 700 }}>{title}</div>
              <div style={{ fontSize: 16, opacity: 0.8, marginTop: 4 }}>Luxury releases, handled cleanly.</div>
            </div>
          </div>
          <div style={{ fontSize: 20, color: accent }}>goyunir.com</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 900 }}>
          <div style={{ fontSize: 84, lineHeight: 0.95, fontWeight: 800, marginBottom: 20 }}>{title}</div>
          <div style={{ fontSize: 32, lineHeight: 1.35, color: 'rgba(255,255,255,0.88)' }}>{description}</div>
        </div>
      </div>
    ),
    size,
  );
}