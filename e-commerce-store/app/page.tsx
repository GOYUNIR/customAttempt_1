import LegacyHomePage from '@/components/storefront/LegacyHomePage';
import ThemeSections from '@/components/storefront/ThemeSections';
import { readActiveTheme } from '@/lib/theme-read';
import { ensureDefaultTenant } from '@/lib/tenant-context';

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
export default async function HomePage() {
  const tenantId = await ensureDefaultTenant().catch(() => null);
  const theme = tenantId ? await readActiveTheme(tenantId) : null;

  if (theme && theme.sections.length > 0) {
    return <ThemeSections sections={theme.sections} />;
  }
  return <LegacyHomePage />;
}
