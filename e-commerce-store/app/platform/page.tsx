import Link from 'next/link';
import MerchantSignupForm from '@/components/platform/MerchantSignupForm';
import { staffLoginUrl } from '@/lib/staff-realms';

export const dynamic = 'force-dynamic';

/**
 * /platform — the PLATFORM's own marketing site.
 *
 * The bare root domain has always classified as the 'marketing' portal
 * (lib/edge-router.ts) and nothing ever consumed it: `app/page.tsx` renders the
 * tenant storefront, so a test shop occupied the address a prospect would type
 * and the platform had no site of its own anywhere.
 *
 * Reachable at /platform on every host, and served AT the root once
 * PLATFORM_MARKETING_ROOT is set — so this can be built and reviewed before the
 * apex is switched over.
 *
 * WHAT THIS PAGE CLAIMS, deliberately: what the system does, not what it will
 * earn anyone. Every number a merchant is shown elsewhere in this product is
 * measured against a holdout; nothing on a marketing page should undercut that
 * by quoting an industry average as if it were their result.
 */

const PALETTE = {
  bg: '#0a0a0c',
  panel: '#131317',
  border: '#26262d',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  accent: '#f4f4f5',
};

const CAPABILITIES: Array<{ title: string; body: string }> = [
  {
    title: 'Sell how you actually sell',
    body:
      'First-come-first-served, timed drops with a fair draw, waitlists, and B2B quotes with net terms — in one catalog, not four plugins. Each product picks its own checkout mode.',
  },
  {
    title: 'Inventory that refuses to oversell',
    body:
      'Stock is decremented under a compare-and-swap, so concurrent buyers cannot both take the last unit. Shared pools let one stock level back several listings.',
  },
  {
    title: 'A real customer record',
    body:
      'One durable record per person across drops, orders and subscriptions — loyalty balance, consent and marketing status included. Not a blob keyed by an internal id.',
  },
  {
    title: 'Staff access that survives an audit',
    body:
      'Invite-based onboarding, per-person identities, roles from platform admin down to sales rep, two-step verification, and an append-only audit trail the database itself refuses to edit.',
  },
  {
    title: 'Your own storefront domain',
    body:
      'Every store runs on its own domain or subdomain with isolated portals for staff, merchants and sales — not a shared admin panel behind one shared password.',
  },
  {
    title: 'Portable by construction',
    body:
      'Postgres for data, S3-compatible object storage for media, Stripe for payments, all behind interfaces. Swapping a vendor is implementing one adapter, not a rewrite.',
  },
];

export default function PlatformPage() {
  // Sign-in links must name the portal HOST. A relative /app/login from the
  // marketing root 404s — consumer-facing hosts get no staff-auth exemption,
  // deliberately — so a link that looks right would dead-end. Found by
  // requesting it rather than by reading the fence.
  const rootDomain = process.env.PLATFORM_ROOT_DOMAIN || null;
  const merchantLogin = staffLoginUrl('merchant', rootDomain);
  const salesLogin = staffLoginUrl('sales', rootDomain);

  return (
    <main style={{ minHeight: '100vh', background: PALETTE.bg, color: PALETTE.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '0 20px' }}>

        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 0' }}>
          <span style={{ fontWeight: 800, letterSpacing: '3px', fontSize: 12, textTransform: 'uppercase' }}>GOYUNIR</span>
          <nav style={{ display: 'flex', gap: 22, alignItems: 'center', fontSize: 13 }}>
            <a href="#capabilities" style={{ color: PALETTE.muted, textDecoration: 'none' }}>Platform</a>
            <a href="#start" style={{ color: PALETTE.muted, textDecoration: 'none' }}>Get started</a>
            <a href={merchantLogin} style={{ color: PALETTE.text, textDecoration: 'none', fontWeight: 700 }}>Sign in</a>
          </nav>
        </header>

        <section style={{ padding: '72px 0 56px', maxWidth: 760 }}>
          <h1 style={{ fontSize: 46, lineHeight: 1.1, margin: '0 0 20px', fontWeight: 800, letterSpacing: '-1px' }}>
            Commerce infrastructure for brands that sell in drops, not just in carts.
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.65, color: PALETTE.muted, margin: '0 0 28px' }}>
            Timed releases, fair draws, waitlists, first-come-first-served and B2B quoting — with the
            inventory, identity and audit guarantees that usually take a year of plugins to
            approximate. Bring your own domain. Own your data.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <a href="#start" style={{ background: PALETTE.accent, color: '#0a0a0c', borderRadius: 999, padding: '14px 26px', fontWeight: 800, fontSize: 15, textDecoration: 'none' }}>
              Create your store
            </a>
            <a href="#capabilities" style={{ border: `1px solid ${PALETTE.border}`, color: PALETTE.text, borderRadius: 999, padding: '14px 26px', fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
              See what it does
            </a>
          </div>
        </section>

        <section id="capabilities" style={{ padding: '32px 0 8px' }}>
          <h2 style={{ fontSize: 13, letterSpacing: '2.5px', textTransform: 'uppercase', color: PALETTE.muted, fontWeight: 700, margin: '0 0 24px' }}>
            What you get
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 16 }}>
            {CAPABILITIES.map((c) => (
              <div key={c.title} style={{ background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 16, padding: '22px 20px' }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{c.title}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, color: PALETTE.muted, margin: 0 }}>{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="start" style={{ padding: '64px 0 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 32, alignItems: 'start' }}>
            <div>
              <h2 style={{ fontSize: 30, fontWeight: 800, margin: '0 0 14px', letterSpacing: '-0.5px' }}>Start your store</h2>
              <p style={{ fontSize: 15, lineHeight: 1.65, color: PALETTE.muted, margin: '0 0 16px' }}>
                Tell us the name and we will create it. You will get an email to set your password —
                that link is what proves the address is yours, so nobody can claim a store they
                cannot receive mail for.
              </p>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: PALETTE.muted, margin: 0 }}>
                Already have an account? <a href={merchantLogin} style={{ color: PALETTE.text }}>Sign in to your store</a>.
                Sales team: <a href={salesLogin} style={{ color: PALETTE.text }}>sales portal</a>.
              </p>
            </div>
            <MerchantSignupForm />
          </div>
        </section>

        <footer style={{ borderTop: `1px solid ${PALETTE.border}`, marginTop: 56, padding: '26px 0 44px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, fontSize: 12.5, color: PALETTE.muted }}>
          <span>© {new Date().getFullYear()} GOYUNIR</span>
          <span style={{ display: 'flex', gap: 18 }}>
            <Link href="/terms" prefetch={false} style={{ color: PALETTE.muted }}>Terms</Link>
            <Link href="/privacy" prefetch={false} style={{ color: PALETTE.muted }}>Privacy</Link>
          </span>
        </footer>
      </div>
    </main>
  );
}
