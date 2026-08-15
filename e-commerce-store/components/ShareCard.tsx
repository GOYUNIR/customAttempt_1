import { cardBackgroundStyle, hexToRgba, safeCssColor } from '@/lib/share-card-config';

/**
 * The 1200×630 social share card (OG / link preview), rendered by BOTH:
 *   - `app/og/route.ts` (server, via satori/ImageResponse), and
 *   - the /admin → Settings → Branding & Share live preview (browser).
 *
 * It is a pure presentational component (no hooks, no server-only imports), so
 * it can be imported from a server route AND a client component. The markup and
 * styles are shared so the admin preview is pixel-faithful to the actual PNG.
 *
 * Satori note: keep the server path (`preview={false}`) byte-for-byte the same
 * layout the previous route used — width/height 100% + padding — so the
 * generated PNG does not change. The `preview` variant uses fixed 1200×630 +
 * border-box for correct browser rendering inside the scaled admin preview.
 */

export type ShareCardProps = {
  brandName: string;
  title: string;
  description: string;
  tagline?: string;
  /** Resolved image source (data: URL on the server; absolute/data in browser). */
  logoUrl?: string;
  shareImageUrl?: string;
  background: string;
  accent: string;
  text: string;
  /** Host displayed on the card, e.g. `yourstore.com`. */
  siteUrl: string;
  /** Renders the browser preview variant (fixed 1200×630, border-box). */
  preview?: boolean;
  /** Scale factor for the preview (default 1). */
  scale?: number;
};

export default function ShareCard({
  brandName,
  title,
  description,
  tagline = '',
  logoUrl = '',
  shareImageUrl = '',
  background,
  accent,
  text,
  siteUrl,
  preview = false,
  scale = 1,
}: ShareCardProps) {
  const s = (n: number) => Math.round(n * scale);
  const safeBg = safeCssColor(background, '#0B0B0F');
  const safeAccent = safeCssColor(accent, '#D4AF37');
  const safeText = safeCssColor(text, '#F5F2E9');
  const name = String(brandName || 'Store');
  const cardTitle = String(title || name);
  const cardDescription = String(description || 'Private releases, handled cleanly.');
  const cardSite = String(siteUrl || 'example.com');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: `${s(56)}px ${s(68)}px`,
        background: cardBackgroundStyle(safeBg, safeAccent, shareImageUrl || undefined),
        color: safeText,
        fontFamily: 'system-ui, sans-serif',
        ...(preview
          ? { width: 1200, height: 630, boxSizing: 'border-box' as const }
          : { width: '100%', height: '100%' }),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: s(16) }}>
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={name}
              style={{
                width: s(68),
                height: s(68),
                borderRadius: s(16),
                objectFit: 'cover',
                border: `1px solid ${hexToRgba(safeAccent, 0.33)}`,
              }}
            />
          ) : (
            <div style={{ width: s(68), height: s(68), borderRadius: s(16), background: safeAccent }} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ letterSpacing: s(6), fontSize: s(24), fontWeight: 700 }}>{name.toUpperCase()}</div>
            {tagline ? <div style={{ fontSize: s(16), opacity: 0.8, marginTop: s(4) }}>{tagline}</div> : null}
          </div>
        </div>
        <div style={{ fontSize: s(20), color: safeAccent }}>{cardSite}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: s(900) }}>
        <div style={{ fontSize: s(74), lineHeight: 0.98, fontWeight: 800, marginBottom: s(18) }}>{cardTitle}</div>
        <div style={{ fontSize: s(30), lineHeight: 1.35, color: 'rgba(255,255,255,0.9)' }}>{cardDescription}</div>
      </div>
    </div>
  );
}
