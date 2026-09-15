/**
 * THEME READ — Postgres read for the active `tenant_themes` row (migration
 * `00017`). Same fallback contract as every other Postgres reader this
 * session: `null` on any miss/error, so the caller falls back to the
 * existing hardcoded homepage (`app/page.tsx`'s legacy component).
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { validateThemeSections, type ThemeSection } from '@/lib/theme-schema';

export type TenantTheme = { id: string; name: string; sections: ThemeSection[] };

export async function readActiveTheme(tenantId: string): Promise<TenantTheme | null> {
  if (!supabaseServiceConfigured()) return null;
  try {
    const { serviceRoleKey } = readSupabaseEnv();
    const rows = (await supabaseRestFetch(
      `/tenant_themes?tenant_id=eq.${encodeURIComponent(tenantId)}&is_active=eq.true&select=id,name,sections&limit=1`,
      { key: serviceRoleKey },
    )) as Array<{ id: string; name: string; sections: unknown }>;
    const row = rows?.[0];
    if (!row) return null;
    const { ok } = validateThemeSections(row.sections);
    if (!ok) return null; // a corrupted/hand-edited row must never crash the storefront
    return { id: row.id, name: row.name, sections: row.sections as ThemeSection[] };
  } catch (err) {
    console.error('[theme-read] failed, falling back to the legacy homepage', (err as Error)?.message || err);
    return null;
  }
}
