import LegacyHomePage from '@/components/storefront/LegacyHomePage';
import ThemeSections from '@/components/storefront/ThemeSections';
import { readActiveTheme } from '@/lib/theme-read';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { storefrontTenantFromHeaders, notFoundOrMoved, redirectToPrimary } from '@/lib/storefront-tenant';
import { notFound } from 'next/navigation';
import { storefrontSsrEnabled } from '@/lib/storefront-ssr';
import { storePayloadFor } from '@/lib/store-payload';
import { homeDisplay, heroCoverOf } from '@/lib/home-display';
import { preload } from 'react-dom';

export const dynamic = 'force-dynamic';

/**
 * Server Component gate: a tenant with an ACTIVE theme row (migration
 * `00017`, set via `/admin` → the Merchant Hub's theme editor) gets the new
 * section-based renderer; everyone else (the default, today) gets the
 * exact same hardcoded homepage as before, unmodified — see
 * `components/storefront/LegacyHomePage.tsx`'s header. This is the same
 * "additive, opt-in, nothing regresses for an existing deployment" pattern
 * every Postgres-backed feature this session uses.
 */
export default async function HomePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  // Whose store (TENANCY.md). Unknown address: 404, never the default store.
  // Themed layouts load products from the DEFAULT catalog, so only the default
  // store gets them until they are tenant-aware; other stores render the
  // standard homepage, which reads the tenant-aware /api/store.
  const who = await storefrontTenantFromHeaders();
  if (who.kind === 'none') return notFoundOrMoved('/');
  await redirectToPrimary(who, '/');
  if (who.kind === 'unavailable') throw new Error('[storefront] store lookup unavailable');
  const tenantId = who.isDefault ? await ensureDefaultTenant().catch(() => null) : null;
  const theme = tenantId ? await readActiveTheme(tenantId) : null;

  if (theme && theme.sections.length > 0) {
    return <ThemeSections sections={theme.sections} />;
  }
  // First screen in the server HTML (flag, lib/storefront-ssr.ts): the same
  // cached payload /api/store serves; the page still refreshes it once running.
  if (storefrontSsrEnabled((await searchParams)?.ssr)) {
    const payload = await storePayloadFor(who, '').catch((err) => {
      console.error('[storefront] first screen not server-rendered', (err as Error)?.message || err);
      return null;
    });
    if (payload) {
      // The hero's cover photo is the page's largest paint, and with the first
      // screen in the HTML it no longer waits for the JS: fetch it first.
      const cover = heroCoverOf(homeDisplay(payload));
      if (cover) preload(cover, { as: 'image', fetchPriority: 'high' });
      return <LegacyHomePage initialStore={{ payload, renderedAt: Date.now() }} />;
    }
  }
  return <LegacyHomePage />;
}
