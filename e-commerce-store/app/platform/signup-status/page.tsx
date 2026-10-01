import { MarketingHeader, MarketingFooter, MARKETING_INK as INK } from '@/components/platform/MarketingChrome';
import { getSupportEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Open your store' };

// Where the signup email's link lands when it cannot go straight on: one plain
// sentence and one obvious next step for each case, plus the support address.
const STATES: Record<string, { title: string; body: string; cta: 'start' | 'signin' | 'none' }> = {
  expired: { title: 'This link has expired', body: 'Signup links last a limited time, and a newer request replaces an older link. Start again: it takes a minute.', cta: 'start' },
  invalid: { title: 'This link is not valid', body: 'It may be incomplete or already replaced by a newer one. Start again: it takes a minute.', cta: 'start' },
  taken: { title: 'That store name was taken', body: 'Someone else opened a store with that name first. Start again with another name.', cta: 'start' },
  has_account: { title: 'You already have an account', body: 'This email already has an account, so no new store was created. Sign in to reach it.', cta: 'signin' },
  paused: { title: 'Signups are paused for a moment', body: 'Please try your link again a little later; it stays valid for a while.', cta: 'none' },
  error: { title: 'Something went wrong on our side', body: 'Your store name is safe. Please open the link again in a minute, or email us and we will finish it with you.', cta: 'none' },
};

export default async function SignupStatus({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  const s = STATES[String(state || '')] || STATES.invalid;
  const root = process.env.PLATFORM_ROOT_DOMAIN || null;
  const support = getSupportEmail();
  return (
    <div style={{ background: INK.bg, color: INK.text, fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh' }}>
      <MarketingHeader rootDomain={root} />
      <main style={{ maxWidth: 560, margin: '0 auto', padding: '80px 20px' }}>
        <h1 style={{ fontSize: 30, margin: '0 0 12px' }}>{s.title}</h1>
        <p style={{ color: INK.muted, lineHeight: 1.7, fontSize: 16, margin: '0 0 24px' }}>{s.body}</p>
        {s.cta === 'start' && <a href="/#start" style={{ display: 'inline-block', background: INK.text, color: INK.bg, borderRadius: 999, padding: '14px 26px', fontWeight: 800, textDecoration: 'none' }}>Start again</a>}
        {s.cta === 'signin' && root && <a href={'https://app.' + root + '/app/login'} style={{ display: 'inline-block', background: INK.text, color: INK.bg, borderRadius: 999, padding: '14px 26px', fontWeight: 800, textDecoration: 'none' }}>Sign in</a>}
        {support && <p style={{ color: INK.muted, fontSize: 14, marginTop: 28 }}>Need a hand? <a href={'mailto:' + support} style={{ color: INK.text }}>{support}</a></p>}
      </main>
      <MarketingFooter rootDomain={root} />
    </div>
  );
}
