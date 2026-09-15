import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasMerchantAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { validateThemeSections, DEFAULT_THEME_SECTIONS } from '@/lib/theme-schema';
import { recordPlatformAudit } from '@/lib/platform-audit';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/theme — the Merchant Hub's "layout customization controls"
 * (Goal 2's Merchant Hub spec) backing `components/admin/ThemeEditor.tsx`.
 * Gated by `actorHasMerchantAccess` (owner/staff/super_admin) — theme
 * layout is a day-to-day merchant action, not a platform-admin-only one.
 *
 *   GET — the tenant's active theme, or DEFAULT_THEME_SECTIONS if none exists yet.
 *   PUT { name?, sections } — validate + upsert as the (only) active theme.
 */
export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasMerchantAccess(actor)) {
      return NextResponse.json({ error: 'Merchant Hub access required.' }, { status: 403 });
    }
    if (!supabaseServiceConfigured()) {
      return NextResponse.json({ ok: true, theme: { id: null, name: 'Default Theme', sections: DEFAULT_THEME_SECTIONS }, isDefault: true });
    }

    const tenantId = await resolveActingTenantId(actor);
    const { serviceRoleKey } = readSupabaseEnv();
    const rows = (await supabaseRestFetch(
      `/tenant_themes?tenant_id=eq.${encodeURIComponent(tenantId)}&is_active=eq.true&select=id,name,sections&limit=1`,
      { key: serviceRoleKey },
    ).catch(() => [])) as Array<{ id: string; name: string; sections: unknown }>;
    const row = rows?.[0];
    if (!row) {
      return NextResponse.json({ ok: true, theme: { id: null, name: 'Default Theme', sections: DEFAULT_THEME_SECTIONS }, isDefault: true });
    }
    return NextResponse.json({ ok: true, theme: row, isDefault: false });
  } catch (err: any) {
    console.error('[admin/theme] load failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load theme.' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasMerchantAccess(actor)) {
      return NextResponse.json({ error: 'Merchant Hub access required.' }, { status: 403 });
    }
    if (!supabaseServiceConfigured()) {
      return NextResponse.json({ error: 'The theme customizer requires Supabase.' }, { status: 503 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : 'Default Theme';
    const { ok, errors } = validateThemeSections(body?.sections);
    if (!ok) {
      return NextResponse.json({ error: 'Invalid sections.', details: errors }, { status: 400 });
    }

    const tenantId = await resolveActingTenantId(actor);
    const { serviceRoleKey } = readSupabaseEnv();

    // Deactivate any existing active theme, then upsert this one as active.
    // Two statements (not a transaction — PostgREST has none over plain
    // fetch) is an acceptable tradeoff here: worst case a brief moment with
    // zero active themes, which readActiveTheme already treats as "fall
    // back to the legacy homepage", never a crash.
    await supabaseRestFetch(`/tenant_themes?tenant_id=eq.${encodeURIComponent(tenantId)}&is_active=eq.true`, {
      key: serviceRoleKey,
      method: 'PATCH',
      body: { is_active: false },
    });

    const existing = (await supabaseRestFetch(
      `/tenant_themes?tenant_id=eq.${encodeURIComponent(tenantId)}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`,
      { key: serviceRoleKey },
    ).catch(() => [])) as Array<{ id: string }>;

    let saved: Array<{ id: string; name: string; sections: unknown }>;
    if (existing?.[0]?.id) {
      saved = (await supabaseRestFetch(`/tenant_themes?id=eq.${encodeURIComponent(existing[0].id)}`, {
        key: serviceRoleKey,
        method: 'PATCH',
        body: { sections: body.sections, is_active: true, updated_at: new Date().toISOString() },
        prefer: 'return=representation',
      })) as Array<{ id: string; name: string; sections: unknown }>;
    } else {
      saved = (await supabaseRestFetch('/tenant_themes', {
        key: serviceRoleKey,
        method: 'POST',
        body: { tenant_id: tenantId, name, sections: body.sections, is_active: true },
        prefer: 'return=representation',
      })) as Array<{ id: string; name: string; sections: unknown }>;
    }
    if (!saved?.[0]) {
      return NextResponse.json({ error: 'Could not save theme.' }, { status: 500 });
    }

    await recordPlatformAudit({
      action: 'theme_updated',
      actor: actor?.email || undefined,
      tenantId,
      detail: { themeId: saved[0].id, sectionCount: Array.isArray(body.sections) ? body.sections.length : 0 },
    });

    return NextResponse.json({ ok: true, theme: saved[0] });
  } catch (err: any) {
    console.error('[admin/theme] save failed', err?.message || err);
    return NextResponse.json({ error: 'Could not save theme.' }, { status: 500 });
  }
}
