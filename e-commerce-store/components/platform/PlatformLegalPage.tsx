import { MarketingHeader, MarketingFooter, MARKETING_INK as INK } from '@/components/platform/MarketingChrome';
import { legalNotice, type LegalSection } from '@/lib/platform-legal';

/** The platform's own legal pages (never a store's): terms and privacy. */
export default function PlatformLegalPage({ title, sections }: { title: string; sections: LegalSection[] }) {
  const rootDomain = process.env.PLATFORM_ROOT_DOMAIN || null;
  return (
    <div style={{ background: INK.bg, color: INK.text, fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh' }}>
      <MarketingHeader rootDomain={rootDomain} />
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '64px 20px 80px' }}>
        <h1 style={{ fontSize: 36, margin: '0 0 12px', fontWeight: 800 }}>{title}</h1>
        <p role="note" style={{ margin: '0 0 36px', padding: '10px 14px', border: `1px solid ${INK.border}`, borderRadius: 10, color: INK.muted, fontSize: 14 }}>
          Last updated {legalNotice().updated}.{legalNotice().draft ? ' ' + legalNotice().draft : ''}
        </p>
        {sections.map((s) => (
          <section key={s.h} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, margin: '0 0 10px', fontWeight: 700 }}>{s.h}</h2>
            {s.p.map((t, i) => <p key={i} style={{ color: INK.muted, lineHeight: 1.7, margin: '0 0 12px', fontSize: 16 }}>{t}</p>)}
          </section>
        ))}
      </main>
      <MarketingFooter rootDomain={rootDomain} />
    </div>
  );
}
