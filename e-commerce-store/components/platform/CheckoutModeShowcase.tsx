import { STARTER_TEMPLATES } from '@/lib/theme-templates';
import { MARKETING_INK as INK } from '@/components/platform/MarketingChrome';

/**
 * The product visual: what a buy box looks like under each way of selling.
 *
 * DERIVED FROM THE REAL TEMPLATES rather than drawn as a mockup. Each panel
 * below reads its call-to-action and its badges out of
 * `lib/theme-templates.ts` — the same data that renders an actual storefront.
 * A hand-drawn screenshot would look better for a week and then quietly stop
 * being true the first time a template changed; this cannot drift, because if
 * the template changes, this changes with it.
 *
 * It is also the clearest way to make the central claim concrete. "One catalog,
 * several ways of selling" is abstract until you see that the drop has a
 * countdown and scarcity, retail has neither, and the trade panel shows no
 * price at all.
 */

type Panel = {
  templateId: string;
  label: string;
  /** The one-line reason a merchant would pick this mode. */
  note: string;
};

const PANELS: Panel[] = [
  { templateId: 'drop-release', label: 'Timed drop', note: 'Limited allocation, decided by a fair draw' },
  { templateId: 'instant-retail', label: 'Everyday retail', note: 'In stock, buy it now' },
  { templateId: 'b2b-quote', label: 'Trade order', note: 'Contract pricing, quoted not listed' },
];

/** Read a product_summary setting straight out of the starter template. */
function summaryConfig(templateId: string): Record<string, unknown> {
  const template = STARTER_TEMPLATES.find((t) => t.id === templateId);
  const section = template?.pages.product.find((s) => s.type === 'product_summary');
  return section?.config ?? {};
}

export default function CheckoutModeShowcase() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        {PANELS.map((panel) => {
          const config = summaryConfig(panel.templateId);
          const showsPrice = config.showPrice !== false;
          const showsUrgency = config.showUrgency === true;
          const showsStock = config.showStock !== false;
          const cta = String(config.ctaLabel || 'Add to cart');

          return (
            <div
              key={panel.templateId}
              style={{ background: INK.panel, border: `1px solid ${INK.border}`, borderRadius: 16, padding: '18px 18px 20px' }}
            >
              <div style={{ fontSize: 11, letterSpacing: '1.6px', textTransform: 'uppercase', color: INK.muted, fontWeight: 700 }}>
                {panel.label}
              </div>

              {/* A stand-in for the product image. Deliberately plain: the point
                  of this panel is the buy box underneath it. */}
              <div style={{ marginTop: 12, height: 104, borderRadius: 10, background: 'linear-gradient(135deg,#1c1c22,#111116)', border: `1px solid ${INK.border}` }} />

              <div style={{ marginTop: 13, fontSize: 15, fontWeight: 650 }}>Midnight Oud</div>

              <div style={{ marginTop: 5, minHeight: 21, fontSize: 14, color: INK.text }}>
                {showsPrice ? (
                  '$140.00'
                ) : (
                  <span style={{ color: INK.muted, fontSize: 13.5 }}>Price on your contract</span>
                )}
              </div>

              <div style={{ marginTop: 6, minHeight: 34, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {showsStock && <span style={{ fontSize: 12.5, color: INK.muted }}>12 available</span>}
                {showsUrgency && <span style={{ fontSize: 12.5, color: '#fbbf24' }}>Only 12 left in this release</span>}
              </div>

              <div
                style={{
                  marginTop: 12, textAlign: 'center', borderRadius: 999, padding: '10px 14px',
                  background: INK.text, color: INK.bg, fontWeight: 800, fontSize: 13.5,
                }}
              >
                {cta}
              </div>

              <p style={{ fontSize: 12.5, color: INK.muted, lineHeight: 1.55, margin: '12px 0 0' }}>{panel.note}</p>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 12.5, color: INK.muted, margin: '14px 2px 0', maxWidth: 760, lineHeight: 1.6 }}>
        Same catalog, same stock, same customer record. Notice what changes and what does not: the
        drop shows scarcity because the allocation really is limited, everyday retail does not
        because it would not be true, and the trade panel shows no list price at all because that
        buyer pays their contract rate.
      </p>
    </div>
  );
}
