import Link from 'next/link';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { isLegacyHeroContent, surfaceBackground } from '@/lib/storefront-config';
import { DEFAULT_LEGAL } from '@/lib/legal-config';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function StoryPage() {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const configPalette = { ...GOYUNIR_STORE_SUITE.themeColors, ...(config.themeColors || {}) };
  const legal = { ...DEFAULT_LEGAL, ...(config.legal || {}) };
  const branding = config.branding || {};
  const hero = isLegacyHeroContent(config.heroContent)
    ? GOYUNIR_STORE_SUITE.heroContent
    : { ...GOYUNIR_STORE_SUITE.heroContent, ...(config.heroContent || {}) };
  const companyName = String(legal.companyName || branding.brandName || branding.shareTitle || DEFAULT_LEGAL.companyName);
  const supportEmail = String(legal.supportEmail || getSupportEmail() || GOYUNIR_STORE_SUITE.brandFooterData.supportEmail || 'support@example.com');

  // Follow the admin border-radius token so the page matches the storefront.
  const radius = (fallback: number) => {
    const r = Number(configPalette.borderRadius);
    return Number.isFinite(r) && r >= 0 ? `${r}px` : `${fallback}px`;
  };

  const storyHeadline = String(hero.storyHeadline || 'Our Story');
  const storyBody = String(hero.storyBody || 'Low supply. Fast conversion. Quiet exclusivity.');

  // Same surface every card on the site uses, so cardTextMain/cardTextMuted are
  // guaranteed readable on ANY design preset (light or dark).
  const contentCard = {
    borderRadius: radius(22),
    border: `1px solid ${configPalette.cardBorder}`,
    background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency),
    padding: '20px 18px',
    color: configPalette.cardTextMain,
  } as const;

  return (
    <main
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '80px 20px 60px',
        boxSizing: 'border-box',
        color: configPalette.textMain,
        background: configPalette.primaryBackground,
        minHeight: 'calc(100vh - 56px)',
        fontFamily: configPalette.fontFamily || 'system-ui,sans-serif',
        lineHeight: 1.7,
        fontSize: 15,
      }}
    >
      <Link
        href="/"
        prefetch={false}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          padding: '0 18px',
          borderRadius: radius(999),
          fontSize: 13,
          fontWeight: 600,
          color: configPalette.cardTextMain,
          textDecoration: 'none',
          background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency),
          border: `1px solid ${configPalette.cardBorder}`,
          marginBottom: 28,
        }}
      >
        ← Back to store
      </Link>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 24 }}>
        <Link
          href="/catalog"
          prefetch={false}
          style={{
            padding: '7px 14px',
            borderRadius: radius(999),
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '1.5px',
            color: configPalette.textMuted,
            textDecoration: 'none',
            border: `1px solid ${configPalette.cardBorder}`,
          }}
        >
          CATALOG
        </Link>
        <span style={{ color: configPalette.textMuted }}>/</span>
        <span
          style={{
            padding: '7px 14px',
            borderRadius: radius(999),
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '1.5px',
            color: configPalette.cardTextMain,
            background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency),
            border: `1px solid ${configPalette.cardBorder}`,
          }}
        >
          STORY
        </span>
      </div>

      <h1 style={{ fontFamily: 'serif', fontSize: 32, margin: '0 0 16px', color: configPalette.textMain }}>{storyHeadline}</h1>

      <div style={contentCard}>
        <p style={{ color: configPalette.cardTextMuted, margin: 0 }}>{storyBody}</p>
        <p style={{ color: configPalette.cardTextMuted, margin: '16px 0 0', fontSize: 14 }}>
          {companyName} runs limited allocations. Enter once per scent. Your card is saved; you are charged only if selected. When a drop returns, existing entries stay in the pool so you do not start over.
        </p>
      </div>

      <p style={{ marginTop: 32, fontSize: 11, color: configPalette.textMuted }}>
        Support: <a href={`mailto:${supportEmail}`} style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>{supportEmail}</a>
      </p>
    </main>
  );
}
