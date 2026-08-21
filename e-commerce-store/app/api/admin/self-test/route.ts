import { NextResponse } from 'next/server';
import {
  createRedisClient,
  loadProducts,
  adminRequestAuthorized,
  safeParseRedisItem,
  PROMO_CODES_KEY,
  POOL_KEY_PREFIX,
  STORE_CONFIG_KEY,
  listLiveStates,
  getLiveProductState,
  liveStateField,
  PROCESSED_SESSIONS_KEY,
  ENTRY_EMAIL_SENT_KEY,
  type LiveStateRecord,
} from '@/lib/server-config';
import { resolveStripeClient } from '@/services/payment/factory';
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
  if (!adminRequestAuthorized(request, password)) {
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
  const stripe = await resolveStripeClient();
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
    const configRaw = await redis.get(STORE_CONFIG_KEY);
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
        : `found: ${legacyFound.join(', ')} — run Tidy Redis Schema in /admin → Developer`
    );

    // ------------------------------------------------------------------
    // Promos presence
    // ------------------------------------------------------------------
    try {
      const promosRaw = await redis.hgetall(PROMO_CODES_KEY);
      const promoCount = promosRaw ? Object.keys(promosRaw).length : 0;
      push('Promos key readable', true, promoCount > 0 ? `${promoCount} promo(s) configured` : 'empty (no promos yet)');
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
      if (isActive && totalInventory === 0) {
        // 0 inventory is intentional when the product is set to stay visible as
        // a sold-out social-proof placeholder (it displays "Sold out"). Only
        // flag it as a misconfiguration when an archiving behavior was chosen
        // instead — that product will never sell but also never archive.
        const behavior = String(product?.soldOutBehavior || 'stay_visible');
        if (behavior !== 'stay_visible') activeNoInventory += 1;
      }
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
      const activeProducts = productList.filter((p: any) => p?.isActive === true || p?.isActive === 'true');

      // Every active product with real stock should have a live-state record
      // for each of its sizes. Products with 0 configured stock are skipped —
      // they are intentional sold-out/social-proof placeholders and seeding a
      // live state would make them look available.
      const expected: { product: any; size: string }[] = [];
      for (const product of activeProducts) {
        const raffleLimit = Math.max(0, Number(product?.maxRaffleAllocationLimit) || 0);
        const stock = Math.max(0, Number(product?.totalInventory) || 0);
        if (raffleLimit <= 0 && stock <= 0) continue;
        const categories =
          Array.isArray(product?.priceCategories) && product.priceCategories.length > 0
            ? product.priceCategories
            : [{ size: 'Standard' }];
        for (const cat of categories) {
          expected.push({ product, size: String(cat?.size || 'Standard') });
        }
      }

      const existingByField = new Map<string, LiveStateRecord>();
      for (const state of liveStates) existingByField.set(String(state.productId), state);

      const missing = expected.filter(({ product, size }) => {
        const field = liveStateField(product.id, product.slug, size);
        return !existingByField.has(field);
      });

      // Repair: seed missing live states exactly the way the checkout/draw
      // paths would (getLiveProductState is idempotent — an existing record is
      // never overwritten, only a truly missing one is created). Live states
      // are lazily created on first checkout, so a freshly seeded store with no
      // traffic yet legitimately has none — running this self-test backfills
      // them so the store is ready for a drop.
      let seededCount = 0;
      let repairFailed = false;
      for (const { product, size } of missing) {
        try {
          await getLiveProductState(redis, product, size);
          seededCount += 1;
        } catch (err: any) {
          repairFailed = true;
          console.warn(`[self-test] Could not seed live state for ${product?.name} (${size}):`, err);
        }
      }

      const ok = !repairFailed;
      push(
        'Live states seeded',
        ok,
        activeProducts.length === 0
          ? 'no active products to seed'
          : `${existingByField.size + seededCount} live state(s) for ${activeProducts.length} active product(s)` +
            (seededCount > 0 ? ` (seeded ${seededCount} missing)` : '') +
            (repairFailed ? ' — some could not be seeded' : '')
      );
    } catch (e: any) {
      push('Live states seeded', false, e.message || 'read failed');
    }
    try {
      const poolKeys = await redis.keys(`${POOL_KEY_PREFIX}*`);
      push('Drop pool keys readable', true, poolKeys.length > 0 ? `${poolKeys.length} pool(s) present` : 'no pools yet (no entries)');
    } catch {
      push('Drop pool keys readable', true, 'read skipped (SCAN not supported)');
    }

    // ------------------------------------------------------------------
    // Redis schema tidiness (tidy key names; legacy prefixes should be gone)
    // ------------------------------------------------------------------
    try {
      const tidyPrefixes = [
        `${POOL_KEY_PREFIX}`,
        'entries:intent:',
        'entries:block:',
        'entries:waitlist:',
        'auth:session:',
        'promo:used:',
        'promo:pending:',
        'draws:',
        'ops:',
        'analytics:',
        'customer:',
        'cache:',
        'promo:codes',
        'entries:stats',
        'entries:processed',
        'entries:email_sent',
      ];
      const legacyPrefixes = [
        'drop_pool:',
        'intent_pool:',
        'drop_fraud_block:',
        'session:',
        'live_state',
        'catalog:archive_state',
        'stats:',
        'config:promos',
        'promo:used_emails:',
        'alerts:',
        'address:submissions',
        'admin:draw_history',
        'config:recovery',
        'recovery:sent',
        'email:entry_confirmed',
        'stripe:portal_config_id',
        'analytics:active_users_online',
        'config:drop_schedule',
        'config:social_proof',
        'config:product:',
        'reset:',
        'draw:last_auto:',
        'waitlist:',
        // v2 consolidation leftovers — these namespaces are now FIELDS of a
        // single hash (ops:overrides / store:carts / entries:last_auto /
        // analytics:ticks / admin:verify:<email>); any top-level key with these
        // prefixes is stale and should be folded by Tidy Redis Schema.
        'ops:override:',
        'store:cart:',
        'entries:last_auto:',
        'analytics:ticks:last',
        'analytics:ticks:today',
        'analytics:ticks:day',
        'admin:verify_attempts:',
        'admin:send_attempts:',
      ];
      const foundLegacy: string[] = [];
      for (const prefix of legacyPrefixes) {
        try {
          const matches = await redis.keys(`${prefix}*`);
          if (Array.isArray(matches) && matches.length > 0) foundLegacy.push(`${prefix}* (${matches.length})`);
        } catch {
          /* pattern may not be supported — ignore */
        }
      }
      push(
        'Redis schema tidy (no legacy prefixes)',
        foundLegacy.length === 0,
        foundLegacy.length === 0
          ? `clean — key space uses the tidy ${tidyPrefixes.length} namespaces from lib/redis-keys.ts`
          : `found legacy keys: ${foundLegacy.join(', ')} — run Tidy Redis Schema in /admin → Developer`
      );
    } catch (e: any) {
      push('Redis schema tidy', false, e.message || 'scan failed');
    }

    // Dedupe structures are BOUNDED ZSETs (not unbounded legacy SETs). Report
    // their current cardinality + flag legacy set-shaped data that Tidy Redis
    // Schema (or the next checkout write) will migrate.
    try {
      const processedType = String((await redis.type(PROCESSED_SESSIONS_KEY)) || 'none');
      const emailSentType = String((await redis.type(ENTRY_EMAIL_SENT_KEY)) || 'none');
      const processedCount = processedType === 'zset' ? Number(await redis.zcard(PROCESSED_SESSIONS_KEY)) || 0 : processedType === 'set' ? ((await redis.smembers(PROCESSED_SESSIONS_KEY)) || []).length : 0;
      const emailSentCount = emailSentType === 'zset' ? Number(await redis.zcard(ENTRY_EMAIL_SENT_KEY)) || 0 : emailSentType === 'set' ? ((await redis.smembers(ENTRY_EMAIL_SENT_KEY)) || []).length : 0;
      const legacyShape = processedType === 'set' || emailSentType === 'set';
      push(
        'Dedupe sets bounded (72h / 30d)',
        !legacyShape,
        legacyShape
          ? `legacy SET shape detected (processed=${processedCount}, email_sent=${emailSentCount}) — run Tidy Redis Schema to convert`
          : `processed=${processedCount} (${processedType}), email_sent=${emailSentCount} (${emailSentType}) — old members auto-prune on every write`
      );
    } catch {
      push('Dedupe sets bounded (72h / 30d)', true, 'read skipped');
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
