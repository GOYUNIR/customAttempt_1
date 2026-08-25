import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
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
  if (!adminRequestAuthorized(request, password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const provider = detectStorageProvider();
  const supabase = supabaseEnvSummary();
  const configured = (await isPlatformConfigured()) === true;
  const platformSettings = await getPlatformSettings();
  const platformProviders = toPublicSummary(platformSettings);

  // Single source of truth — the full env registry (every variable, with a
  // realistic EXAMPLE value + where to set it on Cloudflare), so the SetUp tab
  // can never drift from middleware.ts / the Setup Wizard.
  const discovery = discoverEnvironment();

  const items: EnvStatusItem[] = discovery.all.map((c) => ({
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
  }));

  return NextResponse.json({
    ok: true,
    items,
    groups: discovery.groups.map((g) => ({
      title: g.title,
      subtitle: g.subtitle,
      kind: g.kind,
      checks: g.checks.map((c) => c.id),
    })),
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
}