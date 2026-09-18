/**
 * READING A MULTI-PAGE THEME for one page of the storefront.
 *
 * `lib/theme-read.ts` returns a tenant's active theme as a flat section array —
 * the homepage-only shape the system started with. `lib/theme-templates.ts`
 * added three-page templates stored as `{ version: 2, pages: {...} }` in the
 * same jsonb column. This is the one place that reads either shape and hands a
 * page its sections.
 *
 * RETURNS AN EMPTY ARRAY FOR "USE THE BUILT-IN LAYOUT", which is what a caller
 * must treat as the fallback. Three different situations produce it, and all
 * three mean the same thing to the page:
 *
 *   - the tenant has no active theme at all (the common case today)
 *   - the theme is a legacy flat array, which is home-only
 *   - the theme is multi-page but this page has no sections
 *
 * Never throws. A malformed theme row must not take a storefront page down —
 * it falls back to the hardcoded layout, which is the behaviour every page had
 * before themes existed.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { normalizeTheme } from '@/lib/theme-templates';
import { validateThemeSections } from '@/lib/theme-schema';
import type { ThemePage } from '@/lib/theme-schema';
import type { ThemeSection } from '@/lib/theme-schema';

export async function readThemePage(tenantId: string, page: ThemePage): Promise<ThemeSection[]> {
  if (!tenantId) return [];
  const db = getDb();
  if (!db.configured) return [];
  try {
    const rows = (await db.select<{ sections: unknown }>('tenant_themes', {
      where: { tenant_id: eq(tenantId), is_active: eq(true) },
      select: ['sections'],
      limit: 1,
    })) as Array<{ sections: unknown }>;
    const row = rows?.[0];
    if (!row) return [];

    const sections = normalizeTheme(row.sections).pages[page] || [];
    if (sections.length === 0) return [];

    // Validated before rendering, not after: a section with an unknown type or
    // a missing id would otherwise reach the renderer and silently disappear,
    // leaving a merchant with a page that is missing a block they can see in
    // the editor.
    const check = validateThemeSections(sections);
    if (!check.ok) {
      console.error('[theme-page-read] active theme is invalid on the ' + page + ' page; falling back to the built-in layout: ' + check.errors.join('; '));
      return [];
    }
    return sections;
  } catch (err) {
    console.error('[theme-page-read] read failed for ' + page, (err as Error)?.message || err);
    return [];
  }
}
