import Link from 'next/link';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { DEFAULT_LEGAL, parseLegalContent, type LegalPageKey } from '@/lib/legal-config';
import { getSupportEmail } from '@/lib/env';

/**
 * Server-rendered policy page (/terms, /privacy, /shipping).
 *
 * 100% driven by the admin portal: page title, company name, support email and
 * the policy body all come from store:config.legal (Settings → Legal &
 * Policies). The live theme colors are baked in per-request by the root layout
 * and merged here so the pages match the storefront palette exactly. Buyers
 * never need a code change to update their policies.
 */
export default async function LegalPage({ page }: { page: LegalPageKey }) {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const colors = { ...GOYUNIR_STORE_SUITE.themeColors, ...(config.themeColors || {}) };
  const legal = { ...DEFAULT_LEGAL, ...(config.legal || {}) };
  const branding = config.branding || {};
  const brandName = String(branding.brandName || branding.shareTitle || legal.companyName || DEFAULT_LEGAL.companyName);
  const companyName = String(legal.companyName || brandName);
  const supportEmail = String(legal.supportEmail || getSupportEmail() || GOYUNIR_STORE_SUITE.brandFooterData.supportEmail || 'support');
  const blocks = parseLegalContent(String(legal[page] || DEFAULT_LEGAL[page] || ''), { companyName, supportEmail });

  const titles: Record<LegalPageKey, string> = {
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    shipping: 'Shipping & Sales Policy',
  };

  const backLinkStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '0 18px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    color: colors.textMain,
    textDecoration: 'none',
    background: 'rgba(255,255,255,0.06)',
    border: `1px solid ${colors.cardBorder}`,
    marginBottom: 24,
  } as const;

  return (
    <main
      style={{
        maxWidth: 680,
        margin: '0 auto',
        padding: '80px 20px 60px',
        color: colors.cardTextMain,
        background: colors.primaryBackground,
        minHeight: 'calc(100vh - 56px)',
        fontFamily: colors.fontFamily || 'system-ui,sans-serif',
        lineHeight: 1.7,
        fontSize: 14,
      }}
    >
      <Link href="/" prefetch={false} style={backLinkStyle}>
        ← Back to store
      </Link>
      <h1 style={{ fontSize: 28, margin: '24px 0 8px' }}>{titles[page]}</h1>
      <p style={{ color: colors.textMuted, fontSize: 12 }}>
        {companyName} · Last updated: {new Date().toISOString().slice(0, 10)}
      </p>
      <div>
        {blocks.map((block, index) => {
          if (block.kind === 'heading') {
            return (
              <h2 key={index} style={{ fontSize: 16, marginTop: 28, color: colors.cardTextMain }}>
                {block.text}
              </h2>
            );
          }
          if (block.kind === 'bullet') {
            return (
              <ul key={index} style={{ margin: '4px 0', paddingLeft: 18 }}>
                <li style={{ marginBottom: 6, color: colors.cardTextMuted }}>{block.text}</li>
              </ul>
            );
          }
          return (
            <p key={index} style={{ margin: '10px 0', color: colors.cardTextMuted }}>
              {block.text}
            </p>
          );
        })}
      </div>
    </main>
  );
}
