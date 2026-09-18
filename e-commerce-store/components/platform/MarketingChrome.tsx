import Link from 'next/link';
import { staffLoginUrl } from '@/lib/staff-realms';

/**
 * The platform's own header and footer.
 *
 * These exist because the storefront's chrome was bleeding onto this page: a
 * "MORE" link into a tenant's catalog, a second brand mark stacked under ours,
 * and a shopper's footer offering Shipping and "Manage My Entry" to a business
 * evaluating software. Nothing here links into a shop.
 *
 * Sign-in links name the portal HOST rather than a relative path. A relative
 * /app/login from the marketing root returns 404 — consumer-facing hosts get no
 * staff-auth exemption, on purpose — so a link that looks right would dead-end.
 */

const INK = {
  bg: '#0a0a0c',
  panel: '#131317',
  border: '#26262d',
  text: '#f4f4f5',
  muted: '#a1a1aa',
} as const;

const NAV = [
  { label: 'Platform', href: '#platform' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Comparison', href: '#comparison' },
  { label: 'FAQ', href: '#faq' },
] as const;

export function MarketingHeader({ rootDomain }: { rootDomain: string | null }) {
  const signIn = staffLoginUrl('merchant', rootDomain);
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        borderBottom: `1px solid ${INK.border}`,
        background: 'rgba(10,10,12,0.82)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px', height: 64, display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* The ONE brand mark on the page. */}
        <Link
          href="/platform"
          prefetch={false}
          style={{ color: INK.text, textDecoration: 'none', fontWeight: 800, letterSpacing: '3px', fontSize: 13, textTransform: 'uppercase', flex: '0 0 auto' }}
        >
          GOYUNIR
        </Link>

        <nav style={{ display: 'flex', gap: 22, marginLeft: 12, flex: '1 1 auto' }}>
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              style={{ color: INK.muted, textDecoration: 'none', fontSize: 13.5, whiteSpace: 'nowrap' }}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <a href={signIn} style={{ color: INK.text, textDecoration: 'none', fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
          Sign in
        </a>
        <a
          href="#start"
          style={{ background: INK.text, color: INK.bg, textDecoration: 'none', borderRadius: 999, padding: '9px 18px', fontSize: 13.5, fontWeight: 800, whiteSpace: 'nowrap' }}
        >
          Create your store
        </a>
      </div>
    </header>
  );
}

type FooterColumn = { heading: string; links: Array<{ label: string; href: string; external?: boolean }> };

export function MarketingFooter({ rootDomain }: { rootDomain: string | null }) {
  // Structured for someone evaluating software — what it does, who builds it,
  // what the terms are, how to reach a human. The storefront footer answered a
  // shopper's questions ("Shipping", "Manage My Entry"), which is the wrong
  // audience entirely.
  const columns: FooterColumn[] = [
    {
      heading: 'Product',
      links: [
        { label: 'Platform', href: '#platform' },
        { label: 'Pricing', href: '#pricing' },
        { label: 'Comparison', href: '#comparison' },
        { label: 'FAQ', href: '#faq' },
      ],
    },
    {
      heading: 'Get started',
      links: [
        { label: 'Create your store', href: '#start' },
        { label: 'Merchant sign-in', href: staffLoginUrl('merchant', rootDomain), external: true },
        { label: 'Sales portal', href: staffLoginUrl('sales', rootDomain), external: true },
      ],
    },
    {
      heading: 'Legal',
      links: [
        { label: 'Terms', href: '/terms' },
        { label: 'Privacy', href: '/privacy' },
      ],
    },
  ];

  return (
    <footer style={{ borderTop: `1px solid ${INK.border}`, marginTop: 88, background: INK.bg }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '44px 20px 40px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 32 }}>
          <div>
            <div style={{ fontWeight: 800, letterSpacing: '3px', fontSize: 12, textTransform: 'uppercase', color: INK.text }}>
              GOYUNIR
            </div>
            <p style={{ color: INK.muted, fontSize: 13, lineHeight: 1.6, margin: '10px 0 0', maxWidth: 260 }}>
              Commerce infrastructure for brands that sell in drops, waitlists and trade orders —
              not just carts.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.heading}>
              <div style={{ fontSize: 11.5, letterSpacing: '1.6px', textTransform: 'uppercase', color: INK.muted, fontWeight: 700, marginBottom: 12 }}>
                {col.heading}
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 9 }}>
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external || link.href.startsWith('#') ? (
                      <a href={link.href} style={{ color: INK.text, textDecoration: 'none', fontSize: 13.5 }}>{link.label}</a>
                    ) : (
                      <Link href={link.href} prefetch={false} style={{ color: INK.text, textDecoration: 'none', fontSize: 13.5 }}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div style={{ borderTop: `1px solid ${INK.border}`, marginTop: 34, paddingTop: 20, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ color: INK.muted, fontSize: 12.5 }}>© {new Date().getFullYear()} GOYUNIR</span>
          <span style={{ color: INK.muted, fontSize: 12.5 }}>Built on Postgres, Stripe and object storage you can walk away with.</span>
        </div>
      </div>
    </footer>
  );
}

export const MARKETING_INK = INK;
