import MerchantSignupForm from '@/components/platform/MerchantSignupForm';
import { MarketingHeader, MarketingFooter, MARKETING_INK as INK } from '@/components/platform/MarketingChrome';
import CheckoutModeShowcase from '@/components/platform/CheckoutModeShowcase';
import { CAPABILITIES, COMPARISON, PLANS, FAQS } from '@/lib/platform-marketing';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * /platform — the platform's own marketing site.
 *
 * Served at the bare root once PLATFORM_MARKETING_ROOT is set, and always
 * reachable here so it can be reviewed before that switch is thrown.
 *
 * Copy, prices, the comparison and the FAQ come from lib/platform-marketing.ts,
 * because positioning changes far more often than layout and a wording fix
 * should not be a component edit. This file is the arrangement; that file is
 * the argument.
 */

const SHELL: React.CSSProperties = { maxWidth: 1100, margin: '0 auto', padding: '0 20px' };
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11.5, letterSpacing: '2.4px', textTransform: 'uppercase',
  color: INK.muted, fontWeight: 700, margin: '0 0 18px',
};

export default function PlatformPage() {
  const rootDomain = process.env.PLATFORM_ROOT_DOMAIN || null;

  return (
    <div style={{ background: INK.bg, color: INK.text, fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh' }}>
      <MarketingHeader rootDomain={rootDomain} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      {/* One headline, one sentence, one button. Everything else on this page
          is second-visit content — the comparison table and the full
          methodology are real substance, deliberately placed lower and behind
          a "learn more" rather than led with, so a first-time visitor can
          understand the pitch and act on it in seconds, not read a brochure. */}
      <section style={{ ...SHELL, padding: '104px 20px 76px', maxWidth: 720 }}>
        <h1 style={{ fontSize: 52, lineHeight: 1.08, margin: '0 0 22px', fontWeight: 800, letterSpacing: '-1.4px' }}>
          Sell the way your brand actually sells.
        </h1>
        <p style={{ fontSize: 19, lineHeight: 1.6, color: INK.muted, margin: '0 0 34px', maxWidth: 560 }}>
          Drops, waitlists, everyday retail and trade orders — one catalog, one customer record,
          your own domain.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <a href="#start" style={{ background: INK.text, color: INK.bg, borderRadius: 999, padding: '16px 32px', fontWeight: 800, fontSize: 16, textDecoration: 'none' }}>
            Create your store
          </a>
          <span style={{ color: INK.muted, fontSize: 13.5 }}>No card required</span>
        </div>
      </section>

      {/* ── The product, shown rather than described ─────────────────────── */}
      <section style={{ ...SHELL, paddingBottom: 20 }}>
        <CheckoutModeShowcase />
      </section>

      {/* ── Capabilities: outcome first, mechanism second ────────────────── */}
      <section id="platform" style={{ ...SHELL, padding: '70px 20px 10px' }}>
        <h2 style={SECTION_LABEL}>What you get</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 18 }}>
          {CAPABILITIES.map((c) => (
            <div key={c.outcome} style={{ background: INK.panel, border: `1px solid ${INK.border}`, borderRadius: 16, padding: '24px 22px' }}>
              {/* The outcome is the heading; the mechanism follows in muted text.
                  It is the proof, not the pitch. */}
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 9px', lineHeight: 1.35 }}>{c.outcome}</h3>
              <p style={{ fontSize: 14, lineHeight: 1.65, color: INK.muted, margin: 0 }}>{c.proof}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How our numbers differ from everyone else's ──────────────────── */}
      <section style={{ ...SHELL, padding: '70px 20px 0' }}>
        <div style={{ background: INK.panel, border: `1px solid ${INK.border}`, borderRadius: 18, padding: '30px 28px' }}>
          <h2 style={{ ...SECTION_LABEL, margin: '0 0 14px' }}>Honest numbers</h2>
          <p style={{ fontSize: 20, fontWeight: 700, margin: '0 0 20px', lineHeight: 1.4, maxWidth: 720 }}>
            Your marketing report will show a smaller number than the tool you use today. That is
            the point.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
            <div style={{ border: `1px solid ${INK.border}`, borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, color: INK.muted, marginBottom: 6 }}>What everyone else reports</div>
              <div style={{ fontSize: 21, fontWeight: 800, color: INK.muted }}>Gross attributed</div>
              <div style={{ fontSize: 12.5, color: INK.muted, marginTop: 6 }}>Every sale that touched a campaign</div>
            </div>
            <div style={{ border: `1px solid ${INK.text}`, borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, color: INK.muted, marginBottom: 6 }}>What we report</div>
              <div style={{ fontSize: 21, fontWeight: 800 }}>Proven incremental</div>
              <div style={{ fontSize: 12.5, color: INK.muted, marginTop: 6 }}>Measured against a held-back control group</div>
            </div>
          </div>
          {/* The full explanation is real substance, not filler — kept, not cut,
              just not LED with. A native <details> disclosure costs zero JS and
              stays honest: nothing here is hidden, it's just not the first
              thing a visitor has to read to understand the pitch. */}
          <details style={{ marginTop: 18 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, color: INK.text, padding: '12px 0' }}>
              How we measure this
            </summary>
            <p style={{ fontSize: 14.5, lineHeight: 1.7, color: INK.muted, margin: '12px 0 0', maxWidth: 720 }}>
              Most tools count every sale that touched a campaign — including the customers who were
              going to buy anyway. We hold back a small control group and report the difference: what
              the campaign actually <em>added</em>. You see both figures side by side, with the method
              written out, so you can check it and so can your accountant.
            </p>
          </details>
        </div>
      </section>

      {/* ── Comparison ───────────────────────────────────────────────────── */}
      {/* Real substance, second-visit content: collapsed by default so it
          doesn't compete with the first-impression sections above it. The
          header's "Comparison" nav link still works — modern browsers
          auto-expand a <details> when it (or its contents) is the anchor
          target, a standardized behavior, not a hack. */}
      <section style={{ ...SHELL, padding: '70px 20px 0' }}>
        <details id="comparison">
          <summary style={{ ...SECTION_LABEL, cursor: 'pointer', listStyle: 'none', paddingBlock: 12 }}>
            Against what you use today <span style={{ color: INK.text, textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>— see the full comparison</span>
          </summary>
          <div style={{ border: `1px solid ${INK.border}`, borderRadius: 16, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', background: INK.panel, padding: '13px 18px', fontSize: 11.5, letterSpacing: '1.4px', textTransform: 'uppercase', color: INK.muted, fontWeight: 700 }}>
              <div />
              <div>Typical setup</div>
              <div style={{ color: INK.text }}>Here</div>
            </div>
            {COMPARISON.map((row, i) => (
              <div
                key={row.question}
                style={{
                  display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr',
                  padding: '18px', borderTop: `1px solid ${INK.border}`,
                  background: i % 2 ? 'transparent' : 'rgba(255,255,255,0.012)',
                  fontSize: 14, lineHeight: 1.6,
                }}
              >
                <div style={{ fontWeight: 600, paddingRight: 16 }}>{row.question}</div>
                <div style={{ color: INK.muted, paddingRight: 16 }}>{row.today}</div>
                <div>{row.here}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12.5, color: INK.muted, margin: '12px 2px 0' }}>
            Compared against common setups rather than a named product: a competitor&apos;s feature
            list changes weekly, and an out-of-date comparison is worse than none.
          </p>
        </details>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" style={{ ...SHELL, padding: '70px 20px 0' }}>
        <h2 style={SECTION_LABEL}>Pricing</h2>
        {/* 240px min so four tiers fit one row inside the 1100px shell; below
            that they wrap in pairs rather than stranding a single card. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
          {PLANS.map((plan) => {
            // 'Contact us' used to point at #start — the self-signup form. A buyer
            // asking for a conversation was handed a create-your-own-store wizard.
            // Until the lead form ships this at least opens a real email; with no
            // inbox configured the button says where it actually goes instead of
            // promising a conversation nobody receives.
            const quoteTier = plan.monthlyUsd === null;
            const inbox = getSupportEmail();
            const ctaHref = quoteTier && inbox
              ? 'mailto:' + inbox + '?subject=' + encodeURIComponent('Scale plan enquiry')
              : '#start';
            // The label is the plan's own promise (lib/platform-marketing.ts).
            // Only the quote tier overrides it, and only to stay honest about
            // where the button actually goes when no inbox is configured.
            const ctaLabel = quoteTier && !inbox
              ? 'Start a store'
              : (plan.ctaLabel || 'Start here');
            return (
            <div
              key={plan.id}
              style={{
                background: INK.panel,
                border: `1px solid ${plan.featured ? INK.text : INK.border}`,
                borderRadius: 18, padding: '26px 24px', display: 'flex', flexDirection: 'column', gap: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '1.2px', textTransform: 'uppercase', color: plan.featured ? INK.text : INK.muted }}>
                  {plan.name}
                </div>
                <div style={{ fontSize: 34, fontWeight: 800, marginTop: 10, letterSpacing: '-1px' }}>
                  {plan.monthlyUsd === null ? 'Let’s talk' : plan.monthlyUsd === 0 ? 'Free' : `$${plan.monthlyUsd}`}
                  {plan.monthlyUsd !== null && plan.monthlyUsd > 0 && (
                    <span style={{ fontSize: 14, fontWeight: 600, color: INK.muted }}> /month</span>
                  )}
                </div>
                {plan.priceNote && (
                  <p style={{ fontSize: 12.5, lineHeight: 1.5, color: INK.text, margin: '7px 0 0', fontWeight: 600 }}>
                    {plan.priceNote}
                  </p>
                )}
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: INK.muted, margin: '10px 0 0' }}>{plan.tagline}</p>
                {plan.limitNote && (
                  <p style={{ fontSize: 12.5, lineHeight: 1.55, color: INK.muted, margin: '8px 0 0' }}>
                    {plan.limitNote}
                  </p>
                )}
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9, flex: '1 1 auto' }}>
                {plan.points.map((point) => (
                  <li key={point} style={{ fontSize: 13.5, lineHeight: 1.55, display: 'flex', gap: 9 }}>
                    <span style={{ color: INK.muted }}>—</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <a
                href={ctaHref}
                style={{
                  textAlign: 'center', textDecoration: 'none', borderRadius: 999, padding: '12px 18px',
                  fontWeight: 800, fontSize: 14,
                  background: plan.featured ? INK.text : 'transparent',
                  color: plan.featured ? INK.bg : INK.text,
                  border: plan.featured ? 'none' : `1px solid ${INK.border}`,
                }}
              >
                {ctaLabel}
              </a>
            </div>
            );
          })}
        </div>
        <p style={{ fontSize: 12.5, color: INK.muted, margin: '14px 2px 0', maxWidth: 760, lineHeight: 1.6 }}>
          Start free and stay free until the limit starts costing you sales. Paid plans are flat and
          monthly, billed through Stripe. We do not charge a percentage of the revenue our own tools
          claim to have generated — that is only fair once the measurement has been proven over
          time, and we would rather earn it than assume it.
        </p>
      </section>

      {/* ── Signup ───────────────────────────────────────────────────────── */}
      <section id="start" style={{ ...SHELL, padding: '76px 20px 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 34, alignItems: 'start' }}>
          <div>
            <h2 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 14px', letterSpacing: '-0.6px' }}>Start your store</h2>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: INK.muted, margin: '0 0 14px' }}>
              Tell us the name and we will create it. You will get an email to set your password —
              that link is what proves the address is yours, so nobody can claim a store they cannot
              receive mail for.
            </p>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: INK.muted, margin: 0 }}>
              No card required. Nothing is charged until you choose a plan.
            </p>
          </div>
          <MerchantSignupForm />
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section id="faq" style={{ ...SHELL, padding: '76px 20px 0' }}>
        <h2 style={SECTION_LABEL}>Questions</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          {FAQS.map((item) => (
            <details key={item.q} style={{ background: INK.panel, border: `1px solid ${INK.border}`, borderRadius: 14, padding: '0 19px' }}>
              <summary style={{ fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: '15px 0' }}>{item.q}</summary>
              <p style={{ fontSize: 14, lineHeight: 1.7, color: INK.muted, margin: '0 0 15px' }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <MarketingFooter rootDomain={rootDomain} />
    </div>
  );
}
