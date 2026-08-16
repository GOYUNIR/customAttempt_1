import {
  cardBackgroundStyle,
  hexToRgba,
  normalizeShareCardOptions,
  safeCssColor,
  type ShareCardOptions,
} from '@/lib/share-card-config';

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
 *
 * Layouts (options.shareLayout):
 *   - 'classic' — current layout: top row (logo + brand + tagline, site top
 *     right) above a big title + description block.
 *   - 'split'   — share image full-bleed on the LEFT half, padded text column
 *     (brand, title, description, site) on the RIGHT half. Falls back to
 *     'classic' when no share image is present.
 *   - 'minimal' — centered brand mark (logo circle or accent dot), brand name,
 *     smaller title and description. No tagline, no site URL.
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
  /** Buyer-editable card knobs; when absent the defaults are used (classic). */
  options?: ShareCardOptions;
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
  options: optionsProp,
}: ShareCardProps) {
  const s = (n: number) => Math.round(n * scale);
  const safeBg = safeCssColor(background, '#0B0B0F');
  const safeAccent = safeCssColor(accent, '#D4AF37');
  const safeText = safeCssColor(text, '#F5F2E9');
  const name = String(brandName || 'Store');
  const cardTitle = String(title || name);
  const cardDescription = String(description || 'Private releases, handled cleanly.');
  const cardSite = String(siteUrl || 'example.com');
  const opts = normalizeShareCardOptions(optionsProp);

  const rootSize = preview
    ? { width: 1200, height: 630, boxSizing: 'border-box' as const }
    : { width: '100%' as const, height: '100%' as const };
  const fontFamily = opts.shareFontFamily === 'serif' ? 'Georgia, Times New Roman, serif' : 'system-ui, sans-serif';
  const glowOpts = { shareGlowIntensity: opts.shareGlowIntensity, shareImageOverlay: opts.shareImageOverlay };
  const backgroundCss = cardBackgroundStyle(safeBg, safeAccent, shareImageUrl || undefined, glowOpts);
  const rootCommon = {
    background: backgroundCss,
    color: safeText,
    fontFamily,
    borderRadius: opts.shareCornerRadius,
    ...rootSize,
  };

  const brandMark = opts.shareLogoVisible ? (
    logoUrl ? (
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
    )
  ) : null;

  const brandBlock = (
    <div style={{ display: 'flex', alignItems: 'center', gap: s(16) }}>
      {brandMark}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ letterSpacing: s(6), fontSize: s(24), fontWeight: 700 }}>{name.toUpperCase()}</div>
        {opts.shareTaglineVisible && tagline ? (
          <div style={{ fontSize: s(16), opacity: 0.8, marginTop: s(4) }}>{tagline}</div>
        ) : null}
      </div>
    </div>
  );

  const titleBlock = (
    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: s(900) }}>
      <div style={{ fontSize: s(opts.shareTitleSize), lineHeight: 0.98, fontWeight: 800, marginBottom: s(18) }}>
        {cardTitle}
      </div>
      <div style={{ fontSize: s(opts.shareDescriptionSize), lineHeight: 1.35, color: 'rgba(255,255,255,0.9)' }}>
        {cardDescription}
      </div>
    </div>
  );

  const siteBlock = opts.shareSiteVisible ? (
    <div style={{ fontSize: s(20), color: safeAccent }}>{cardSite}</div>
  ) : null;

  // ---- minimal: centered brand mark + name, title, description; no tagline/site ----
  if (opts.shareLayout === 'minimal') {
    return (
      <div
        style={{
          ...rootCommon,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: `${s(48)}px ${s(64)}px`,
        }}
      >
        {opts.shareLogoVisible && logoUrl ? (
          <img
            src={logoUrl}
            alt={name}
            style={{ width: s(96), height: s(96), borderRadius: '50%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ width: s(56), height: s(56), borderRadius: '50%', background: safeAccent }} />
        )}
        <div style={{ letterSpacing: s(5), fontSize: s(20), fontWeight: 700, marginTop: s(20), opacity: 0.85 }}>
          {name.toUpperCase()}
        </div>
        <div
          style={{
            fontSize: s(Math.round(opts.shareTitleSize * 0.72)),
            lineHeight: 1.05,
            fontWeight: 800,
            marginTop: s(16),
            maxWidth: s(980),
          }}
        >
          {cardTitle}
        </div>
        <div
          style={{
            fontSize: s(opts.shareDescriptionSize),
            lineHeight: 1.4,
            color: 'rgba(255,255,255,0.9)',
            marginTop: s(16),
            maxWidth: s(860),
          }}
        >
          {cardDescription}
        </div>
      </div>
    );
  }

  // ---- split: image full-bleed on the left half, text column on the right ----
  if (opts.shareLayout === 'split' && shareImageUrl) {
    const leftBg = cardBackgroundStyle(safeBg, safeAccent, shareImageUrl, glowOpts);
    return (
      <div style={{ ...rootCommon, display: 'flex', flexDirection: 'row', background: safeBg }}>
        <div style={{ width: '50%', height: '100%', background: leftBg }} />
        <div
          style={{
            width: '50%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: `${s(56)}px ${s(48)}px`,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {brandBlock}
            {siteBlock}
          </div>
          {titleBlock}
        </div>
      </div>
    );
  }

  // ---- classic (default) ----
  return (
    <div
      style={{
        ...rootCommon,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: `${s(56)}px ${s(68)}px`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {brandBlock}
        {siteBlock}
      </div>
      {titleBlock}
    </div>
  );
}
