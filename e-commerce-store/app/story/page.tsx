import Link from 'next/link';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { isLegacyHeroContent } from '@/lib/storefront-config';
import { DEFAULT_LEGAL } from '@/lib/legal-config';

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
  const supportEmail = String(legal.supportEmail || GOYUNIR_STORE_SUITE.brandFooterData.supportEmail || 'support@example.com');

  return (
    <main style={{
      maxWidth: 560,
      margin: '0 auto',
      padding: '80px 20px 60px',
      color: configPalette.cardTextMain,
      background: configPalette.primaryBackground,
      minHeight: 'calc(100vh - 56px)',
      fontFamily: configPalette.fontFamily || 'system-ui,sans-serif',
      lineHeight: 1.7,
      fontSize: 15,
    }}>
      <Link
        href="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          padding: '0 18px',
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 600,
          color: configPalette.textMain,
          textDecoration: 'none',
          background: 'rgba(255,255,255,0.06)',
          border: `1px solid ${configPalette.cardBorder}`,
          marginBottom: 24,
        }}
      >
        ← Back to store
      </Link>
      <div style={{ display: 'flex', gap: 16, marginBottom: 32, fontSize: 12, letterSpacing: 2 }}>
        <Link href="/catalog" style={{ color: configPalette.textMuted, textDecoration: 'none' }}>CATALOG</Link>
        <span style={{ color: configPalette.cardTextMain }}>STORY</span>
      </div>
      <h1 style={{ fontFamily: 'serif', fontSize: 32, margin: '0 0 16px' }}>{hero.storyHeadline || 'Our Story'}</h1>
      <p style={{ color: configPalette.cardTextMuted }}>{hero.storyBody || 'Low supply. Fast conversion. Quiet exclusivity.'}</p>
      <p style={{ color: configPalette.cardTextMuted }}>
        {companyName} runs limited allocations. Enter once per scent. Your card is saved; you are charged only if selected. When a drop returns, existing entries stay in the pool so you do not start over.
      </p>
      <p style={{ marginTop: 48, fontSize: 11, color: configPalette.textMuted }}>
        Support: <a href={`mailto:${supportEmail}`} style={{ color: configPalette.accentBlue, textDecoration: 'none' }}>{supportEmail}</a>
      </p>
    </main>
  );
}