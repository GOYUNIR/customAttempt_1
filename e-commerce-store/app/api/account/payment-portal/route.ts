import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
  loadProducts,
  loadStoreConfig,
  STRIPE_PORTAL_CACHE_KEY,
} from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';

export const dynamic = 'force-dynamic';

async function getOrCreatePortalConfigId(stripe: any, redis: any) {
  try {
    const cached = await redis.get(STRIPE_PORTAL_CACHE_KEY);
    if (cached) return String(cached);
  } catch {}

  // Brand the portal headline with the admin-set store name (never a hardcoded
  // template brand). Falls back to a neutral label when branding is unset.
  let brandName = '';
  try {
    const config = await loadStoreConfig(redis);
    const branding = config?.branding || {};
    brandName = String(branding.brandName || branding.shareTitle || '').trim();
  } catch {}

  const configuration = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: brandName ? `Update your ${brandName} payment method` : 'Update your payment method',
    },
    features: {
      payment_method_update: { enabled: true },
      customer_update: {
        enabled: false,
        allowed_updates: [],
      },
      invoice_history: { enabled: false },
      subscription_cancel: { enabled: false },
      subscription_pause: { enabled: false },
      subscription_update: { enabled: false },
    },
  });

  try {
    await redis.set(STRIPE_PORTAL_CACHE_KEY, configuration.id);
  } catch {}

  return configuration.id;
}

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Login required.' }, { status: 401 });
    }

    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    const body = await request.json();
    const email = sessionUser.email;
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();

    if (!email) {
      return NextResponse.json({ error: 'Missing account email.' }, { status: 400 });
    }

    const liveProducts = await loadProducts(redis);
    const productNames = Object.values(liveProducts).map((p: any) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    
    // Filter by variant/size if provided
    let targetMatches = matches;
    if (variant && size) {
      targetMatches = matches.filter((m) => m.variant === variant && m.size === size);
    }
    
    const target = last4
      ? targetMatches.find((m) => String(m.parsed.cardLast4 || '') === last4) ||
        matches.find((m) => String(m.parsed.cardLast4 || '') === last4)
      : targetMatches[0] || matches[0];

    let customerId = target?.parsed?.customerId || target?.parsed?.stripeCustomerId || '';

    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 5 });
      for (const c of list.data) {
        const pms = await stripe.paymentMethods.list({ customer: c.id, type: 'card' });
        if (!last4 || pms.data.some((pm: any) => pm.card?.last4 === last4)) {
          customerId = c.id;
          break;
        }
      }
    }

    if (!customerId) {
      return NextResponse.json({ error: 'No matching payment profile found.' }, { status: 404 });
    }

    const hostHeader = request.headers.get('host') || 'localhost:3000';
    const protocol = hostHeader.includes('localhost') ? 'http' : 'https';
    const configurationId = await getOrCreatePortalConfigId(stripe, redis);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${protocol}://${hostHeader}/account`,
      configuration: configurationId,
    });

    return NextResponse.json({ success: true, url: portalSession.url });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}