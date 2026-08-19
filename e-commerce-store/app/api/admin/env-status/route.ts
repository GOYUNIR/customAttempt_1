import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * Environment-variable status dashboard for the admin → SetUp tab.
 *
 * Returns ONLY presence + metadata for each variable (never values) so the
 * admin can verify an installation at a glance without leaking secrets.
 * Defense-in-depth: requires admin authorization IN the route (on top of the
 * proxy.ts Basic-Auth + device-cookie gates) so a misconfiguration that ever
 * exposes this handler can never be read unauthenticated.
 */
type EnvStatusItem = {
  key: string;
  label: string;
  required: boolean;
  set: boolean;
  aliases: string[];
  buildTime: boolean;
  sensitive: boolean;
  hint: string;
};

const has = (...names: string[]): boolean =>
  names.some((name) => Boolean(process.env[name] && String(process.env[name]).trim()));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!adminRequestAuthorized(request, password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const items: EnvStatusItem[] = [
    {
      key: 'Redis',
      label: 'Redis (primary data store)',
      required: true,
      set: has('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_URL', 'KV_URL'),
      aliases: ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_URL', 'KV_URL'],
      buildTime: false,
      sensitive: false,
      hint: 'UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_URL / KV_REST_API_TOKEN pair — any platform works, see README).',
    },
    {
      key: 'Redis token',
      label: 'Redis access token',
      required: true,
      set: has('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'REDIS_TOKEN'),
      aliases: ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'REDIS_TOKEN'],
      buildTime: false,
      sensitive: true,
      hint: 'Secret — set in the platform, never paste into a public file.',
    },
    {
      key: 'Stripe secret key',
      label: 'Stripe secret key (sk_…)',
      required: true,
      set: has('STRIPE_SECRET_KEY'),
      aliases: ['STRIPE_SECRET_KEY'],
      buildTime: false,
      sensitive: true,
      hint: 'Secret — set in the platform (Vercel, Netlify, Cloudflare…). The storefront will not charge without it.',
    },
    {
      key: 'Stripe webhook secret',
      label: 'Stripe webhook secret (whsec_…)',
      required: true,
      set: has('STRIPE_WEBHOOK_SECRET'),
      aliases: ['STRIPE_WEBHOOK_SECRET'],
      buildTime: false,
      sensitive: true,
      hint: 'Secret — required for the /api/stripe/webhook signature check. In development ALLOW_UNVERIFIED_WEBHOOKS=true can bypass it, but never in production.',
    },
  ];
  items.push(
    {
      key: 'Stripe product id',
      label: 'Default Stripe price ID',
      required: false,
      set: has('STRIPE_PRODUCT_ID'),
      aliases: ['STRIPE_PRODUCT_ID'],
      buildTime: false,
      sensitive: false,
      hint: 'Optional global fallback price ID. Per-product/per-size IDs set in /admin → Products always win.',
    },
    {
      key: 'Admin auth',
      label: 'Admin portal Basic Auth',
      required: true,
      set: has('ADMIN_BASIC_AUTH_USERNAME', 'ADMIN_BASIC_AUTH_PASSWORD'),
      aliases: ['ADMIN_BASIC_AUTH_USERNAME', 'ADMIN_BASIC_AUTH_PASSWORD'],
      buildTime: false,
      sensitive: false,
      hint: 'Both username AND password must be set, otherwise /admin is disabled.',
    },
    {
      key: 'Admin verify email',
      label: 'Admin two-step inbox',
      required: true,
      set: has('ADMIN_VERIFY_EMAIL', 'SUPPORT_EMAIL', 'REPLY_TO_EMAIL'),
      aliases: ['ADMIN_VERIFY_EMAIL', 'SUPPORT_EMAIL', 'REPLY_TO_EMAIL'],
      buildTime: false,
      sensitive: false,
      hint: 'Inbox that receives the /admin two-step verification code (ADMIN_VERIFY_EMAIL, falling back to SUPPORT_EMAIL). Without one the portal locks behind the code step.',
    },
    {
      key: 'Cron secret',
      label: 'Cron endpoint secret',
      required: true,
      set: has('CRON_SECRET'),
      aliases: ['CRON_SECRET'],
      buildTime: false,
      sensitive: true,
      hint: 'Secret — guards the /api/checkout/cron-draw + /api/cron/* safety net. Schedulers (vercel.json cron, Netlify scheduled function, Cloudflare cron worker, cron-job.org…) authenticate with `Authorization: Bearer $CRON_SECRET`.',
    },
    {
      key: 'Resend',
      label: 'Transactional email (Resend)',
      required: false,
      set: has('RESEND_API_KEY'),
      aliases: ['RESEND_API_KEY', 'RESEND_FROM'],
      buildTime: false,
      sensitive: true,
      hint: 'RESEND_API_KEY enables entry/welcome/winner emails. RESEND_FROM sets the from address (e.g. "Brand <onboarding@resend.dev>").',
    },
    {
      key: 'Site URL',
      label: 'Canonical site URL',
      required: true,
      set: has('NEXT_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL', 'SITE_URL'),
      aliases: ['NEXT_PUBLIC_URL', 'NEXT_PUBLIC_SITE_URL', 'SITE_URL'],
      buildTime: true,
      sensitive: false,
      hint: 'Used in emails, OG/social cards and canonical links. NEXT_PUBLIC_* values are baked at build time — set in the same environment and redeploy. If unset, the platform\'s own URL variables are used automatically (Vercel VERCEL_PROJECT_PRODUCTION_URL/VERCEL_URL, Netlify URL/DEPLOY_URL, Cloudflare CF_PAGES_URL).',
    },
    {
      key: 'Brand name',
      label: 'Email brand name',
      required: false,
      set: has('BRAND_NAME', 'NEXT_PUBLIC_SITE_NAME'),
      aliases: ['BRAND_NAME', 'NEXT_PUBLIC_SITE_NAME'],
      buildTime: false,
      sensitive: false,
      hint: 'Brand shown in emails. The storefront brand itself is set in /admin → Settings → Branding & Share (no env var needed).',
    },
    {
      key: 'Support email',
      label: 'Support inbox',
      required: false,
      set: has('SUPPORT_EMAIL', 'REPLY_TO_EMAIL'),
      aliases: ['SUPPORT_EMAIL', 'REPLY_TO_EMAIL'],
      buildTime: false,
      sensitive: false,
      hint: 'Used in emails and policy pages. Can also be set per-buyer in /admin → Settings → Legal & Policies.',
    },
    {
      key: 'Mapbox token',
      label: 'Mapbox Address Autofill',
      required: false,
      set: has('NEXT_PUBLIC_MAPBOX_TOKEN', 'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'),
      aliases: ['NEXT_PUBLIC_MAPBOX_TOKEN', 'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'],
      buildTime: true,
      sensitive: false,
      hint: 'Public pk.* token that powers the full-address dropdown. Without it customers type addresses manually. NEXT_PUBLIC_* is baked at build time — redeploy after setting.',
    }
  );

  return NextResponse.json({
    ok: true,
    items,
    environment: process.env.NODE_ENV || 'development',
    summary: {
      configured: items.filter((i) => i.set).length,
      total: items.length,
      requiredMissing: items.filter((i) => i.required && !i.set).map((i) => i.key),
    },
  });
}
