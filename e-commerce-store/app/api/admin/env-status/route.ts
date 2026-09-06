import { NextResponse } from 'next/server';
import { adminAuthorized } from '@/lib/admin-verify';
import { detectStorageProvider, discoverEnvironment, CLOUDFLARE_VARS_PATH } from '@/lib/env-discovery';
import { supabaseEnvSummary } from '@/services/config/edge';
import { getPlatformSettings, isPlatformConfigured } from '@/services/config/platform-settings';
import { toPublicSummary } from '@/services/config/types';

export const dynamic = 'force-dynamic';

/**
 * Environment-variable status dashboard for the admin → SetUp tab.
 *
 * Returns EVERY variable the storefront can read — with ONLY presence +
 * metadata (never values), plus a realistic EXAMPLE value and the exact
 * Cloudflare location to set each one — so an operator can wire up a deployment
 * without guessing. Defense-in-depth: requires admin authorization IN the route
 * (on top of the proxy.ts Basic-Auth + device-cookie gates) so a
 * misconfiguration that ever exposes this handler can never be read
 * unauthenticated.
 */
type EnvStatusItem = {
  key: string;
  label: string;
  name: string;
  purpose: string;
  variable: string;
  aliases: string[];
  kind: string;
  required: boolean;
  set: boolean;
  buildTime: boolean;
  sensitive: boolean;
  example: string;
  where: string;
  commands: string[];
  hint: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  // The pure env registry (process.env only) can never throw, so it is the safe
  // fallback payload whenever Supabase/Redis is unreachable — the SetUp tab still
  // renders a full, useful list instead of cascading 503s.
  const buildPayload = () => {
    const discovery = discoverEnvironment();
    const toItem = (c: any): EnvStatusItem => ({
      key: c.id,
      label: c.name,
      name: c.name,
      purpose: c.purpose,
      variable: c.variable,
      aliases: c.aliases,
      kind: c.kind,
      required: c.required,
      set: c.present,
      buildTime: c.buildTime,
      sensitive: c.secret,
      example: c.example,
      where: c.where,
      commands: c.commands,
      hint: c.purpose,
    });
    const items: EnvStatusItem[] = discovery.all.map(toItem);
    // The necessary CLOUDFLARE environment variables — a dedicated list so the
    // SetUp tab can show exactly which values must live in the Cloudflare
    // dashboard / `wrangler secret put` (not the Setup Wizard).
    const cloudflare: EnvStatusItem[] = discovery.all
      .filter((c: any) => c.cloudflareEnvVar === true)
      .map(toItem);
    return {
      items,
      cloudflare,
      groups: discovery.groups.map((g: any) => ({
        title: g.title,
        subtitle: g.subtitle,
        kind: g.kind,
        checks: g.checks.map((c: any) => c.id),
      })),
    };
  };

  try {
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const provider = detectStorageProvider();
    const supabase = supabaseEnvSummary();
    const configured = (await isPlatformConfigured()) === true;
    const platformSettings = await getPlatformSettings();
    const platformProviders = toPublicSummary(platformSettings);
    const { items, cloudflare, groups } = buildPayload();

    return NextResponse.json({
      ok: true,
      items,
      cloudflare,
      groups,
      storageProvider: provider,
      supabase,
      platformConfigured: configured,
      platformProviders,
      cloudflareVarsPath: CLOUDFLARE_VARS_PATH,
      environment: process.env.NODE_ENV || 'development',
      summary: {
        configured: items.filter((i) => i.set).length,
        total: items.length,
        requiredMissing: items.filter((i) => i.required && !i.set).map((i) => i.key),
      },
    });
  } catch (err: any) {
    // Fail-soft: return the env registry (never secrets) so the SetUp tab stays
    // usable even when Supabase/Redis is down or the device check throws.
    const { items, cloudflare, groups } = buildPayload();
    return NextResponse.json({
      ok: false,
      error: err?.message || 'env-status unavailable',
      items,
      cloudflare,
      groups,
      storageProvider: detectStorageProvider(),
      supabase: supabaseEnvSummary(),
      platformConfigured: false,
      platformProviders: toPublicSummary(null),
      cloudflareVarsPath: CLOUDFLARE_VARS_PATH,
      environment: process.env.NODE_ENV || 'development',
      summary: {
        configured: items.filter((i) => i.set).length,
        total: items.length,
        requiredMissing: items.filter((i) => i.required && !i.set).map((i) => i.key),
      },
    });
  }
}