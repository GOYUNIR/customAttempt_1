import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  findPoolEntriesByEmail,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const PORTAL_CONFIG_CACHE_KEY = 'stripe:portal_config_id';

async function getOrCreatePortalConfigId(stripe: any, redis: any) {
  try {
    const cached = await redis.get(PORTAL_CONFIG_CACHE_KEY);
    if (cached) return String(cached);
  } catch {}

  const configuration = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: 'Update your GOYUNIR payment method',
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
    await redis.set(PORTAL_CONFIG_CACHE_KEY, configuration.id);
  } catch {}

  return configuration.id;
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    const body = await request.json();
    const email = String(body?.email || '')
      .trim()
      .toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    const variant = String(body?.variant || '').trim();
    const size = String(body?.size || '').trim();

    if (!email || last4.length !== 4) {
      return NextResponse.json({ error: 'Enter your email and card digits first.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    
    // Filter by variant/size if provided
    let targetMatches = matches;
    if (variant && size) {
      targetMatches = matches.filter((m) => m.variant === variant && m.size === size);
    }
    
    const target = targetMatches.find((m) => String(m.parsed.cardLast4 || '') === last4) || 
                   matches.find((m) => String(m.parsed.cardLast4 || '') === last4);

    let customerId = target?.parsed?.customerId || target?.parsed?.stripeCustomerId || '';

    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 5 });
      for (const c of list.data) {
        const pms = await stripe.paymentMethods.list({ customer: c.id, type: 'card' });
        if (pms.data.some((pm: any) => pm.card?.last4 === last4)) {
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