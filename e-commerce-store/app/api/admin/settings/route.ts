import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, STORE_CONFIG_KEY } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const SETTINGS_KEY = STORE_CONFIG_KEY;

export async function GET(request: Request) {
  try {
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
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const { 
      theme, hero, form, footer, branding,
      productNotes,
      animationMechanics, dropSchedule,
      socialProof, homeRedirectSlug, catalogPreview
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
      productNotes: productNotes || current.productNotes || {},
      animationMechanics: animationMechanics || current.animationMechanics || {},
      dropSchedule: dropSchedule || current.dropSchedule || {},
      socialProof: socialProof || current.socialProof || {},
      homeRedirectSlug: homeRedirectSlug || current.homeRedirectSlug || undefined,
      catalogPreview: catalogPreview || current.catalogPreview || { upcomingDrops: [], archiveScents: [] },
      updatedAt: new Date().toISOString(),
    };

    await redis.set(SETTINGS_KEY, JSON.stringify(settings));
    
    // Also update the store config for the frontend
    await redis.set('store:config', JSON.stringify(settings));
    
    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    console.error('[Settings API] POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}