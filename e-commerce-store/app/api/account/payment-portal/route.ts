import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, findPoolEntriesByEmail } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const PORTAL_CONFIG_CACHE_KEY = 'stripe:billing_portal_config_id';

async function getOrCreatePortalConfigId(stripe: any, redis: any): Promise<string> {
  try {
    const cached = await redis.get(PORTAL_CONFIG_CACHE_KEY);
    if (cached) return String(cached);
  } catch {}

  const configuration = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Update your card for GOYUNIR' },
    features: {
      payment_method_update: { enabled: true },
      customer_update: { enabled: false },
      invoice_history: { enabled: false },
      subscription_cancel: { enabled: false },
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
    const email = String(body?.email || '').trim().toLowerCase();
    const last4 = String(body?.last4 || '').trim();
    if (!email || last4.length !== 4) {
      return NextResponse.json({ error: 'Enter your email and card digits first.' }, { status: 400 });
    }

    const productNames = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.name);
    const matches = await findPoolEntriesByEmail(redis, productNames, email);
    const target = matches.find((m) => String(m.parsed.cardLast4 || '') === last4);
    if (!target) return NextResponse.json({ error: 'No matching entry found.' }, { status: 404 });

    const customerId = target.parsed.customerId || target.parsed.stripeCustomerId;
    if (!customerId) {
      return NextResponse.json({ error: 'No linked payment profile found.' }, { status: 404 });
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