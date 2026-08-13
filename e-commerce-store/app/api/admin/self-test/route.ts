import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  loadProducts,
  getAdminPassword,
  safeParseRedisItem,
  PROMOS_KEY,
  listLiveStates,
} from '@/lib/server-config';
import { isConfiguredPrice } from '@/lib/storefront-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const REQUIRED_THEME_KEYS = [
  'primaryBackground',
  'cardBackground',
  'cardBorder',
  'accentPurple',
  'accentBlue',
  'textMain',
  'textMuted',
  'cardTextMain',
  'cardTextMuted',
  'checkoutCtaButton',
];

// Keys that once held duplicate product data. They should NOT exist — if they
// do, the store is serving stale copies and the admin → Developer → "Clean Up
// Redis" button removes them.
const LEGACY_DUPLICATE_KEYS = [
  'store:active_products',
  'store:archived_products',
  'store:upcoming_products',
];

function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim());
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  const master = getAdminPassword() || '';
  if (!master || password !== master) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const results: any[] = [];
  const push = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // ------------------------------------------------------------------
  // Environment variables
  // ------------------------------------------------------------------
  const envVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'ADMIN_BASIC_AUTH_USERNAME',
    'ADMIN_BASIC_AUTH_PASSWORD',
    'CRON_SECRET',
  ];
  for (const key of envVars) {
    push(`Env: ${key}`, Boolean(process.env[key]), process.env[key] ? 'set' : 'MISSING');
  }
  push('Env: RESEND_API_KEY', Boolean(process.env.RESEND_API_KEY), process.env.RESEND_API_KEY ? 'set' : 'optional (emails disabled)');
  push('Env: RESEND_FROM', Boolean(process.env.RESEND_FROM), process.env.RESEND_FROM || 'default (no custom from-address)');
  const mapboxToken = String(
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    ''
  ).trim();
  push(
    'Env: NEXT_PUBLIC_MAPBOX_TOKEN',
    mapboxToken ? /^pk\./.test(mapboxToken) : false,
    mapboxToken
      ? (/^pk\./.test(mapboxToken) ? `set (${mapboxToken.slice(0, 7)}…)` : 'set but NOT a public pk.* token — autofill will be rejected in the browser')
      : 'not set — address autofill dropdowns will be OFF'
  );

  // ------------------------------------------------------------------
  // Redis + Stripe connectivity
  // ------------------------------------------------------------------
  const redis = createRedisClient();
  const stripe = createStripeClient();
  push('Redis client', Boolean(redis), redis ? 'ok' : 'failed');

  if (redis) {
    try {
      await redis.ping();
      push('Redis ping', true, 'pong');
    } catch (e: any) {
      push('Redis ping', false, e.message || 'ping failed');
    }
  }
  push('Stripe client', Boolean(stripe), stripe ? 'ok' : 'failed');
  if (stripe) {
    try {
      await stripe.balance.retrieve();
      push('Stripe API', true, 'ok');
    } catch (e: any) {
      push('Stripe API', false, e.message || 'balance.retrieve() failed');
    }
  }

  if (redis) {
    // ------------------------------------------------------------------
    // store:config integrity
    // ------------------------------------------------------------------
    const configRaw = await redis.get('store:config');
    const config = safeParseRedisItem<any>(configRaw);
    push('store:config parseable', Boolean(config), config ? 'ok' : 'missing or invalid JSON');

    let availableSizes: string[] = [];
    if (config) {
      const storedTheme = config.themeColors || {};
      // The storefront merges stored themeColors over the build-time defaults
      // (GOYUNIR_STORE_SUITE.themeColors), so the effective palette is what
      // customers actually see. A missing stored key is harmless as long as the
      // merged result has it — but flag it so the operator knows a "Save
      // Settings" would persist the new tokens.
      const effectiveTheme = { ...(GOYUNIR_STORE_SUITE as any).themeColors, ...storedTheme };
      const missingStored = REQUIRED_THEME_KEYS.filter((key) => !storedTheme[key]);
      const missingEffective = REQUIRED_THEME_KEYS.filter((key) => !effectiveTheme[key]);
      const badHex = REQUIRED_THEME_KEYS.filter((key) => effectiveTheme[key] && !isHexColor(effectiveTheme[key]));
      push(
        'Theme colors complete',
        missingEffective.length === 0,
        missingEffective.length === 0
          ? (missingStored.length === 0 ? 'all theme keys present' : `present via defaults (not yet persisted — press Save Settings): ${missingStored.join(', ')}`)
          : `missing: ${missingEffective.join(', ')}`
      );
      push(
        'Theme colors valid hex',
        badHex.length === 0,
        badHex.length === 0 ? 'ok' : `non-hex values: ${badHex.join(', ')} (admin color pickers need #rrggbb)`
      );
      const radius = Number(storedTheme.borderRadius ?? config.borderRadius ?? GOYUNIR_STORE_SUITE.themeColors.borderRadius);
      push(
        'Border radius configured',
        Number.isFinite(radius) && radius >= 0,
        Number.isFinite(radius) ? `${radius}px` : 'not a valid number'
      );
      const ds = config.dropSchedule;
      push(
        'Drop schedule configured',
        Boolean(ds?.mode && ds?.timezone),
        ds ? `mode=${ds.mode} tz=${ds.timezone}` : 'dropSchedule missing in store:config'
      );
      availableSizes = Array.isArray(config.availableSizes) ? config.availableSizes : [];
      push(
        'Available sizes configured',
        availableSizes.length > 0,
        availableSizes.length > 0 ? availableSizes.join(', ') : 'MISSING — set in /admin → Settings → Available Sizes'
      );
    }

    // ------------------------------------------------------------------
    // Legacy duplicate keys (should be gone after "Clean Up Redis")
    // ------------------------------------------------------------------
    const legacyFound: string[] = [];
    for (const key of LEGACY_DUPLICATE_KEYS) {
      try {
        if ((await redis.exists(key)) > 0) legacyFound.push(key);
      } catch {
        /* ignore errors on individual keys */
      }
    }
    push(
      'No legacy duplicate product keys',
      legacyFound.length === 0,
      legacyFound.length === 0
        ? 'clean (single source of truth in store:products)'
        : `found: ${legacyFound.join(', ')} — run Clean Up Redis in /admin → Developer`
    );

    // ------------------------------------------------------------------
    // Promos presence
    // ------------------------------------------------------------------
    try {
      const promosRaw = await redis.get(PROMOS_KEY);
      push('Promos key readable', true, promosRaw ? 'configured' : 'empty (no promos yet)');
    } catch (e: any) {
      push('Promos key readable', false, e.message || 'read failed');
    }

    // ------------------------------------------------------------------
    // Product catalog
    // ------------------------------------------------------------------
    const allProducts = await loadProducts(redis);
    const productList = Object.values(allProducts);
    push('Products in Redis', productList.length > 0, productList.length > 0 ? `${productList.length} product(s)` : '0 — click Seed Defaults or Add Product in /admin');

    // Slug uniqueness
    const slugMap = new Map<string, string>();
    const duplicateSlugs: string[] = [];
    for (const product of productList) {
      const slug = String(product?.slug || '').trim();
      if (!slug) continue;
      if (slugMap.has(slug) && slugMap.get(slug) !== product.id) {
        duplicateSlugs.push(slug);
      } else {
        slugMap.set(slug, String(product?.id || ''));
      }
    }
    push(
      'Product slugs unique',
      duplicateSlugs.length === 0,
      duplicateSlugs.length === 0 ? 'ok' : `duplicates: ${duplicateSlugs.join(', ')}`
    );

    let badPriceCount = 0;
    let badStripeCount = 0;
    let activeNoInventory = 0;
    for (const product of productList) {
      const name = String(product?.name || product?.id || '?');
      const isActive = product?.isActive === true || product?.isActive === 'true';
      const categories = Array.isArray(product?.priceCategories) ? product.priceCategories : [];
      for (const cat of categories) {
        const price = Number(cat?.price || 0);
        const stripeId = String(cat?.stripeId || '');
        if (!isConfiguredPrice(price)) badPriceCount += 1;
        if (!stripeId || stripeId.startsWith('price_placeholder')) badStripeCount += 1;
        push(
          `${name} · ${cat?.size || 'Standard'}: price`,
          isConfiguredPrice(price),
          `$${price}${isConfiguredPrice(price) ? '' : ' (not configured — sentinel/unset)'}`
        );
        push(
          `${name} · ${cat?.size || 'Standard'}: Stripe ID`,
          Boolean(stripeId) && !stripeId.startsWith('price_placeholder'),
          stripeId && !stripeId.startsWith('price_placeholder') ? stripeId : 'MISSING/placeholder'
        );
      }
      const totalInventory = Math.max(0, Number(product?.totalInventory || 0));
      if (isActive && totalInventory === 0) activeNoInventory += 1;
      const images = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
      push(
        `${name}: images`,
        images.length > 0,
        images.length > 0 ? `${images.length} image(s)` : 'no images (product card will be blank)'
      );
    }
    push(
      'Active products have inventory',
      activeNoInventory === 0,
      activeNoInventory === 0 ? 'ok' : `${activeNoInventory} active product(s) have 0 totalInventory`
    );
    push(
      'All category prices configured',
      badPriceCount === 0,
      badPriceCount === 0 ? 'ok' : `${badPriceCount} category/ies missing a configured price`
    );
    push(
      'All category Stripe IDs configured',
      badStripeCount === 0,
      badStripeCount === 0 ? 'ok' : `${badStripeCount} category/ies missing a Stripe price ID (set in /admin → Products)`
    );

    // Winner tiers sanity for raffle products
    const raffleWithBadTiers = productList.filter((product: any) => {
      const isRaffle = product?.isRaffle !== false && String(product?.checkoutMode || 'raffle').toUpperCase() !== 'FCFS';
      if (!isRaffle) return false;
      const cats = Array.isArray(product?.priceCategories) ? product.priceCategories : [];
      return cats.some((cat: any) => {
        const tiers = typeof cat?.winnerTiers === 'string' ? cat.winnerTiers : Array.isArray(cat?.winnerTiers) ? cat.winnerTiers.join(',') : '0';
        const parsed = String(tiers).split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n));
        return parsed.length === 0 || parsed.every((n) => n === 0);
      });
    });
    push(
      'Raffle winner tiers set',
      raffleWithBadTiers.length === 0,
      raffleWithBadTiers.length === 0 ? 'ok' : `${raffleWithBadTiers.map((p: any) => p?.name || p?.id).join(', ')} have empty/zero winner tiers`
    );

    // Live states + drop pools (entry health)
    try {
      const liveStates = await listLiveStates(redis);
      const activeCount = productList.filter((p: any) => p?.isActive === true || p?.isActive === 'true').length;
      push(
        'Live states seeded',
        activeCount === 0 || liveStates.length > 0,
        activeCount === 0 ? 'no active products to seed' : `${liveStates.length} live state(s) for ${activeCount} active product(s)`
      );
    } catch (e: any) {
      push('Live states seeded', false, e.message || 'read failed');
    }
    try {
      const poolKeys = await redis.keys('drop_pool:*');
      push('Drop pool keys readable', true, poolKeys.length > 0 ? `${poolKeys.length} pool(s) present` : 'no pools yet (no entries)');
    } catch {
      push('Drop pool keys readable', true, 'read skipped (SCAN not supported)');
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  return NextResponse.json({
    summary: `${passCount}/${results.length} checks passed`,
    allPassed: passCount === results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}
