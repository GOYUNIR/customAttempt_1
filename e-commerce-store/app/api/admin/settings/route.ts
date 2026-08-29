import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, STORE_CONFIG_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { normalizeCategories } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

const SETTINGS_KEY = STORE_CONFIG_KEY;

export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const raw = await redis.get(SETTINGS_KEY);
    const settings = safeParseRedisItem<any>(raw) || {};
    return NextResponse.json({ settings });
  } catch (err: any) {
    console.error('[Settings API] GET Error:', err);
    return NextResponse.json({ error: err.message, settings: {} }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const { 
      theme, hero, form, footer, branding, rewards, gallery,
      productNotes,
      animationMechanics, dropSchedule,
      socialProof, homeRedirectSlug, catalogPreview, orbs,
      copy, legal, catalog, behavior, checkout, refPrefix, layout
    } = body;
    
    // Get current config to merge
    const currentRaw = await redis.get(SETTINGS_KEY);
    const current = safeParseRedisItem<any>(currentRaw) || {};
    
    const settings = {
      ...current,
      themeColors: theme || current.themeColors || {},
      heroContent: hero || current.heroContent || {},
      raffleRegistrationForm: form || current.raffleRegistrationForm || {},
      brandFooterData: footer || current.brandFooterData || {},
      branding: branding || current.branding || {},
      rewards: rewards || current.rewards || {},
      gallery: gallery || current.gallery || {},
      productNotes: productNotes || current.productNotes || {},
      animationMechanics: animationMechanics || current.animationMechanics || {},
      dropSchedule: dropSchedule || current.dropSchedule || {},
      socialProof: socialProof || current.socialProof || {},
      homeRedirectSlug: homeRedirectSlug || current.homeRedirectSlug || undefined,
      catalogPreview: catalogPreview || current.catalogPreview || { upcomingDrops: [], archiveScents: [] },
      orbs: orbs || current.orbs || {},
      copy: copy || current.copy || {},
      legal: legal || current.legal || {},
      catalog: {
        sectionOrder: Array.isArray(catalog?.sectionOrder) && catalog.sectionOrder.length > 0
          ? catalog.sectionOrder
          : (current.catalog?.sectionOrder || ['upcoming', 'archive', 'live']),
        categories: normalizeCategories(catalog?.categories ?? current.catalog?.categories),
      },
      checkout: {
        requireAddressAutofill: checkout?.requireAddressAutofill !== false,
      },
      // Home-page layout (admin → Settings → Home Layout): how many featured
      // products share a row on the home page (1 = full width, 2 = side by side).
      layout: {
        productsPerRow: layout?.productsPerRow === 1 ? 1 : 2,
      },
      // Configurable order/entry reference prefix (default GU). Letters/numbers,
      // up to 4 chars — legacy GY-/GOY- refs are normalized to it at read time.
      refPrefix: (() => {
        const raw = String(refPrefix ?? current.refPrefix ?? 'GU').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        return raw || 'GU';
      })(),
      behavior: {
        scrollToTopOnLoad: behavior?.scrollToTopOnLoad !== false,
      },
      updatedAt: new Date().toISOString(),
    };

    await redis.set(SETTINGS_KEY, JSON.stringify(settings));

    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    console.error('[Settings API] POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}