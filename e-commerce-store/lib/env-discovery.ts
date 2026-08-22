/**
 * ENVIRONMENT AUTO-DISCOVERY — the single source of truth for "what does this
 * install still need before the admin portal can open?"
 *
 * This module scans the runtime `env` object on every request and compiles a
 * grouped checklist of required variables, secrets, and Cloudflare bindings.
 * It is deliberately ZERO-dependency and ZERO-import (no `@/` alias, no Node
 * builtins) so it is:
 *
 *   - EDGE-SAFE  — `middleware.ts` (Vercel Edge / Cloudflare Workers via
 *     OpenNext) can import it directly;
 *   - TESTABLE   — `node --test` loads it with plain
 *     `import … from '../lib/env-discovery.ts'`.
 *
 * Design notes
 * ─────────────────────────────────────────────────────────────────────────────
 * - The `env` object is passed in (defaults to `process.env`) so the SAME
 *   registry works in the Node runtime AND in a Cloudflare Workers `env`
 *   binding if one is ever plumbed through. In Next.js the runtime env object
 *   IS `process.env`.
 * - A check has TWO severity flags:
 *     `required` — needed for full PRODUCTION operation (payments, email,
 *                  cron safety net, canonical URL). Missing ones are shown as
 *                  warnings on the checklist but do NOT block the admin portal.
 *     `blocking` — the admin portal CANNOT open without it. Blocking state is
 *                  computed at the GROUP level (not per variable): the store
 *                  needs ANY ONE storage driver (Supabase / Cloudflare KV-D1 /
 *                  Upstash Redis) AND any one admin method (a Supabase
 *                  super-admin OR the Basic Auth password). No single driver is
 *                  ever mandatory — see detectStorageDrivers() +
 *                  computeAdminReady().
 * - Values are NEVER returned — only presence booleans, names, and copyable
 *   setup commands. A leak of a secret from a setup page would be a bug.
 */

export type EnvCheckKind =
  | 'storage'
  | 'admin'
  | 'payment'
  | 'email'
  | 'maps'
  | 'security'
  | 'site'
  | 'platform'
  | 'binding'
  | 'license'
  | 'ai'
  | 'bootstrap';

export type EnvPlatform = 'all' | 'cloudflare' | 'vercel' | 'netlify' | 'node';

export interface EnvCheck {
  /** Stable id used in tests + `blockingMissing` / `requiredMissing` lists. */
  id: string;
  /** Human label, e.g. "Stripe secret key (sk_…)". */
  name: string;
  /** What this value is FOR — shown verbatim on the checklist. */
  purpose: string;
  /** Primary environment variable name. */
  variable: string;
  /** Accepted alias names (any one satisfies the check). */
  aliases: string[];
  kind: EnvCheckKind;
  /** True when any variable/alias is set and non-empty. */
  present: boolean;
  /** Needed for full production operation (shown as a ⚠ warning). */
  required: boolean;
  /** The admin portal cannot open without it. */
  blocking: boolean;
  /** Value must never be echoed — the UI never receives it anyway. */
  secret: boolean;
  /** NEXT_PUBLIC_* values are inlined at BUILD time (must redeploy). */
  buildTime: boolean;
  /** Which platforms this check is meaningful for. */
  platform: EnvPlatform;
  /** Copyable CLI commands to satisfy the check (wrangler / vercel). */
  commands: string[];
  /** For `kind: 'binding'` — the exact `wrangler.toml` block to paste. */
  wranglerToml?: string;
}

export interface EnvGroup {
  title: string;
  subtitle: string;
  kind: EnvCheckKind;
  checks: EnvCheck[];
}

export interface EnvDiscoverySummary {
  present: number;
  total: number;
  /** Ids of checks where `blocking` is true and `present` is false. */
  blockingMissing: string[];
  /** Ids of checks where `required` is true and `present` is false. */
  requiredMissing: string[];
}

export interface EnvDiscoveryResult {
  groups: EnvGroup[];
  all: EnvCheck[];
  summary: EnvDiscoverySummary;
  /** True when every BLOCKING check is present (env-level readiness). */
  blockingReady: boolean;
  /** True when every REQUIRED check is present. */
  requiredReady: boolean;
}

type EnvObject = Record<string, string | undefined>;

function has(env: EnvObject, ...names: string[]): boolean {
  return names.some((n) => Boolean(env[n] && String(env[n]).trim()));
}

/**
 * Which storage drivers are individually satisfied. This is the single source of
 * truth for "is there at least one data store configured?" — NO driver is ever
 * mandatory on its own. Both middleware.ts and /api/admin/setup-status use this
 * (via computeAdminReady) so they can never drift.
 */
export interface StorageDriverState {
  /** SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY all present. */
  supabase: boolean;
  /** STORAGE_PROVIDER=cloudflare-kv (or D1/KV alias) OR an active KV/D1 binding. */
  cloudflare: boolean;
  /** A REST-usable Redis URL + token pair (see resolveRedisRestUrl in upstash.ts). */
  redis: boolean;
}

/** The canonical storage driver name shown on the setup checklist readout. */
export type StorageProviderName = 'supabase' | 'cloudflare-kv' | 'upstash' | 'none';

function normalizeProviderName(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** REST-usable Redis URL presence — mirrors resolveRedisRestUrl(): `redis://` /
 *  `rediss://` wire-protocol URLs are skipped because the REST client can't use
 *  them. */
function redisRestUrlPresent(env: EnvObject): boolean {
  const candidates = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL', 'REDIS_URL', 'KV_URL'];
  for (const name of candidates) {
    const value = String(env[name] || '').trim();
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) return true;
    if (value.includes('://')) continue; // redis:// / rediss:// — REST client can't use it
    return true;
  }
  return false;
}

/** Detect a Cloudflare KV / D1 binding on `globalThis` (Workers/OpenNext
 *  runtimes surface bindings there, mirroring detectWorkersKvBinding() in
 *  lib/storage/cloudflare-kv.ts). Works for standard `env` Worker bindings. */
function detectCloudflareStorageBinding(glob: unknown): boolean {
  try {
    const g = glob as Record<string, unknown>;
    const looksLikeKv = (v: unknown) =>
      !!v && typeof (v as { get?: unknown }).get === 'function' && typeof (v as { put?: unknown }).put === 'function' &&
      typeof (v as { delete?: unknown }).delete === 'function' && typeof (v as { list?: unknown }).list === 'function';
    const looksLikeD1 = (v: unknown) =>
      !!v && typeof (v as { prepare?: unknown }).prepare === 'function' &&
      (typeof (v as { exec?: unknown }).exec === 'function' || typeof (v as { batch?: unknown }).batch === 'function');
    const named = ['STORE_KV', 'GOYUNIR_KV', 'ALLOCATION_KV', 'KV', 'DB', 'D1_DATABASE', 'D1'];
    for (const name of named) {
      const v = g[name];
      if (looksLikeKv(v) || looksLikeD1(v)) return true;
    }
    for (const key of Object.keys(g)) {
      if (!/^[A-Z_]+$/.test(key)) continue;
      const v = g[key];
      if (/KV/i.test(key) && looksLikeKv(v)) return true;
      if (/D1|DB/i.test(key) && looksLikeD1(v)) return true;
    }
  } catch {
    /* no binding */
  }
  return false;
}

/** Detect which storage drivers are configured from the runtime env + bindings. */
export function detectStorageDrivers(env: EnvObject = process.env): StorageDriverState {
  const provider = normalizeProviderName(env.STORAGE_PROVIDER || '');
  const supabase =
    has(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL') &&
    has(env, 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY') &&
    has(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const cloudflare = provider === 'cloudflare-kv' || provider === 'd1' || detectCloudflareStorageBinding(globalThis);
  const redis =
    redisRestUrlPresent(env) &&
    has(env, 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'REDIS_TOKEN');
  return { supabase, cloudflare, redis };
}

/**
 * Resolve the storage driver name to DISPLAY on the setup checklist. The
 * readout reflects the detected/selected driver and defaults to `supabase`
 * (the default primary store) — never a hardcoded "upstash".
 */
export function detectStorageProvider(env: EnvObject = process.env): StorageProviderName {
  const provider = normalizeProviderName(env.STORAGE_PROVIDER || '');
  if (provider === 'supabase' || provider === 'postgres' || provider === 'pg') return 'supabase';
  if (provider === 'cloudflare-kv' || provider === 'kv' || provider === 'd1' || provider === 'workers-kv') return 'cloudflare-kv';
  if (provider === 'upstash' || provider === 'redis') return 'upstash';
  const drivers = detectStorageDrivers(env);
  if (drivers.supabase) return 'supabase';
  if (drivers.cloudflare) return 'cloudflare-kv';
  if (drivers.redis) return 'upstash';
  return 'supabase';
}

const WRANGLER_SECRET = (name: string) => `npx wrangler secret put ${name}`;

/** The exact Cloudflare dashboard browser path where operators set variables +
 *  secrets manually — surfaced verbatim on the setup checklist per the spec. */
export const CLOUDFLARE_VARS_PATH =
  'Workers & Pages -> [Your Project Name] -> Settings -> Variables and Secrets -> Production';

/**
 * Build the full registry against a given env object. Called fresh each time so
 * `present` always reflects the CURRENT environment (the middleware re-runs it
 * per request; the /api/admin/setup route calls it once per GET).
 */
export function discoverEnvironment(env: EnvObject = process.env): EnvDiscoveryResult {
  const checks: EnvCheck[] = [];

  const add = (check: Omit<EnvCheck, 'present'>): void => {
    checks.push({ ...check, present: has(env, check.variable, ...check.aliases) });
  };

  // ── Storage (any ONE driver unlocks the store — none is mandatory) ──────────
  add({
    id: 'supabase-storage',
    name: 'Supabase data store',
    purpose:
      'The DEFAULT primary store. Satisfied when SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY are all set (or entered in the Setup Wizard). Backs store_kv + global_platform_settings.',
    variable: 'SUPABASE_URL',
    aliases: ['NEXT_PUBLIC_SUPABASE_URL'],
    kind: 'storage',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('SUPABASE_URL'),
      WRANGLER_SECRET('SUPABASE_ANON_KEY'),
      WRANGLER_SECRET('SUPABASE_SERVICE_ROLE_KEY'),
    ],
  });

  add({
    id: 'storage-provider',
    name: 'Storage provider',
    purpose: 'Selects the data backend. Set STORAGE_PROVIDER=cloudflare-kv (or =supabase / =upstash) to force a driver. When unset the store auto-detects: Supabase first, then Cloudflare KV/D1 bindings, then Upstash Redis.',
    variable: 'STORAGE_PROVIDER',
    aliases: [],
    kind: 'storage',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('STORAGE_PROVIDER')],
  });

  add({
    id: 'cloudflare-storage',
    name: 'Cloudflare KV / D1 storage',
    purpose: 'Zero third-party storage. Satisfied when STORAGE_PROVIDER=cloudflare-kv is set or an active KV / D1 binding is detected on the Worker.',
    variable: 'STORAGE_PROVIDER',
    aliases: [],
    kind: 'storage',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'cloudflare',
    commands: [WRANGLER_SECRET('STORAGE_PROVIDER')],
    wranglerToml: `[[kv_namespaces]]
binding = "KV"
id = "<paste from: npx wrangler kv namespace create KV>"`,
  });

  add({
    id: 'redis-url',
    name: 'Redis REST URL (optional)',
    purpose: 'Optional Upstash Redis URL — one of three supported drivers. Use this only when you want Redis instead of Supabase / Cloudflare.',
    variable: 'UPSTASH_REDIS_REST_URL',
    aliases: ['KV_REST_API_URL', 'REDIS_REST_URL', 'REDIS_URL', 'KV_URL'],
    kind: 'storage',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('UPSTASH_REDIS_REST_URL')],
  });

  add({
    id: 'redis-token',
    name: 'Redis REST token (optional)',
    purpose: 'The access token paired with the Redis REST URL. Stored as a secret — never commit it.',
    variable: 'UPSTASH_REDIS_REST_TOKEN',
    aliases: ['KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'REDIS_TOKEN'],
    kind: 'storage',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('UPSTASH_REDIS_REST_TOKEN')],
  });

  // ── Admin access (any ONE method unlocks the portal — password OR master admin) ─
  add({
    id: 'admin-password',
    name: 'Admin Basic Auth password',
    purpose: 'One way to gate /admin. Either set this password OR create a master admin account in the Setup Wizard — only ONE admin method is required.',
    variable: 'ADMIN_BASIC_AUTH_PASSWORD',
    aliases: [],
    kind: 'admin',
    required: true,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('ADMIN_BASIC_AUTH_PASSWORD')],
  });

  add({
    id: 'admin-verify-email',
    name: 'Admin two-step inbox',
    purpose: 'Inbox that receives the 6-digit /admin two-step verification code (falls back to SUPPORT_EMAIL / REPLY_TO_EMAIL).',
    variable: 'ADMIN_VERIFY_EMAIL',
    aliases: ['SUPPORT_EMAIL', 'REPLY_TO_EMAIL'],
    kind: 'admin',
    required: true,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('ADMIN_VERIFY_EMAIL')],
  });

  // ── Payments ────────────────────────────────────────────────────────────────
  add({
    id: 'stripe-secret',
    name: 'Stripe secret key (sk_…)',
    purpose: 'Processes raffle card-saves and instant-buy checkouts. Checkout fails loudly without it.',
    variable: 'STRIPE_SECRET_KEY',
    aliases: [],
    kind: 'payment',
    required: true,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('STRIPE_SECRET_KEY')],
  });

  add({
    id: 'stripe-webhook',
    name: 'Stripe webhook secret (whsec_…)',
    purpose: 'Verifies /api/stripe/webhook signatures so only real Stripe events write ledger rows and award entries.',
    variable: 'STRIPE_WEBHOOK_SECRET',
    aliases: [],
    kind: 'payment',
    required: true,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('STRIPE_WEBHOOK_SECRET')],
  });

  add({
    id: 'stripe-product-id',
    name: 'Default Stripe price ID',
    purpose: 'Optional global fallback price. Per-product/per-size price IDs set in /admin → Products always win.',
    variable: 'STRIPE_PRODUCT_ID',
    aliases: [],
    kind: 'payment',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('STRIPE_PRODUCT_ID')],
  });

  // ── Email ───────────────────────────────────────────────────────────────────
  add({
    id: 'resend',
    name: 'Transactional email (Resend)',
    purpose: 'Sends entry confirmations, winner notices, 2FA codes and waitlist emails.',
    variable: 'RESEND_API_KEY',
    aliases: ['RESEND_FROM'],
    kind: 'email',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('RESEND_API_KEY'),
      WRANGLER_SECRET('RESEND_FROM'),
    ],
  });

  // ── Maps ────────────────────────────────────────────────────────────────────
  add({
    id: 'mapbox',
    name: 'Mapbox address autofill token',
    purpose: 'Powers the full-address dropdown at checkout. Without it customers type addresses manually.',
    variable: 'NEXT_PUBLIC_MAPBOX_TOKEN',
    aliases: ['NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN'],
    kind: 'maps',
    required: false,
    blocking: false,
    secret: false,
    buildTime: true,
    platform: 'all',
    commands: ['npx wrangler secret put NEXT_PUBLIC_MAPBOX_TOKEN   # then rebuild (NEXT_PUBLIC_* is build-time)'],
  });

  // ── Security ────────────────────────────────────────────────────────────────
  add({
    id: 'cron-secret',
    name: 'Cron endpoint secret',
    purpose: 'Guards the scheduled draw safety net (/api/checkout/cron-draw, /api/cron/*). Schedulers authenticate with `Authorization: Bearer $CRON_SECRET`.',
    variable: 'CRON_SECRET',
    aliases: [],
    kind: 'security',
    required: true,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('CRON_SECRET')],
  });

  // ── Site identity ───────────────────────────────────────────────────────────
  add({
    id: 'site-url',
    name: 'Canonical site URL',
    purpose: 'Used in emails, OG/social cards and canonical links. If unset, the platform system vars are used automatically (Cloudflare CF_PAGES_URL, Netlify URL, Vercel VERCEL_URL).',
    variable: 'NEXT_PUBLIC_URL',
    aliases: ['NEXT_PUBLIC_SITE_URL', 'SITE_URL'],
    kind: 'site',
    required: true,
    blocking: false,
    secret: false,
    buildTime: true,
    platform: 'all',
    commands: ['npx wrangler secret put NEXT_PUBLIC_URL   # then rebuild (NEXT_PUBLIC_* is build-time)'],
  });

  add({
    id: 'brand-name',
    name: 'Email brand name',
    purpose: 'Brand shown in emails. The storefront brand itself is set in /admin → Settings → Branding & Share.',
    variable: 'BRAND_NAME',
    aliases: ['NEXT_PUBLIC_SITE_NAME'],
    kind: 'site',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('BRAND_NAME')],
  });

  add({
    id: 'support-email',
    name: 'Support inbox',
    purpose: 'Used in emails and policy pages. Can also be set per-buyer in /admin → Settings → Legal & Policies.',
    variable: 'SUPPORT_EMAIL',
    aliases: ['REPLY_TO_EMAIL'],
    kind: 'site',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('SUPPORT_EMAIL')],
  });

  // ── Platform configuration (optional Supabase) ───────────────────────────────
  add({
    id: 'supabase-url',
    name: 'Supabase project URL',
    purpose: 'Optional source of truth for global_platform_settings (the provider keys + the Setup Wizard gate).',
    variable: 'SUPABASE_URL',
    aliases: ['NEXT_PUBLIC_SUPABASE_URL'],
    kind: 'platform',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('SUPABASE_URL')],
  });

  add({
    id: 'supabase-anon',
    name: 'Supabase anon key',
    purpose: 'Public anon key for the is_platform_configured RPC + admin sign-in.',
    variable: 'SUPABASE_ANON_KEY',
    aliases: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    kind: 'platform',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('SUPABASE_ANON_KEY')],
  });

  add({
    id: 'supabase-service',
    name: 'Supabase service role key',
    purpose: 'Server-only trusted writer — the Setup Wizard uses it to persist provider keys + create the master admin account.',
    variable: 'SUPABASE_SERVICE_ROLE_KEY',
    aliases: [],
    kind: 'platform',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('SUPABASE_SERVICE_ROLE_KEY')],
  });

  // ── Cloudflare bindings (detected, but NOT used by this build) ───────────────
  add({
    id: 'binding-d1',
    name: 'D1 Database binding',
    purpose: 'Cloudflare D1 SQL database. Not used by this storefront build (Upstash Redis is the data store) — shown for completeness on Cloudflare deployments.',
    variable: 'DB',
    aliases: ['D1_DATABASE'],
    kind: 'binding',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'cloudflare',
    commands: ['npx wrangler d1 create my-store-db'],
    wranglerToml: `[[d1_databases]]
binding = "DB"
database_name = "my-store-db"
database_id = "<paste from: npx wrangler d1 create my-store-db>"`,
  });

  add({
    id: 'binding-r2',
    name: 'R2 Bucket binding',
    purpose: 'Cloudflare R2 object storage. Not used by this build (media is stored in Redis) — shown for completeness.',
    variable: 'BUCKET',
    aliases: ['R2_BUCKET'],
    kind: 'binding',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'cloudflare',
    commands: ['npx wrangler r2 bucket create my-store-bucket'],
    wranglerToml: `[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-store-bucket"`,
  });

  add({
    id: 'binding-kv',
    name: 'KV Namespace binding',
    purpose: 'Cloudflare Workers KV. Used only when STORAGE_PROVIDER=cloudflare-kv (the zero-third-party storage adapter).',
    variable: 'KV',
    aliases: ['KV_NAMESPACE'],
    kind: 'binding',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'cloudflare',
    commands: ['npx wrangler kv namespace create KV'],
    wranglerToml: `[[kv_namespaces]]
binding = "KV"
id = "<paste from: npx wrangler kv namespace create KV>"`,
  });

  add({
    id: 'binding-ai',
    name: 'Workers AI binding',
    purpose: 'Cloudflare Workers AI. Not used by this build — shown for completeness.',
    variable: 'AI',
    aliases: ['WORKERS_AI'],
    kind: 'binding',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'cloudflare',
    commands: [],
    wranglerToml: `[ai]
binding = "AI"`,
  });

  // ── Licensing (enforced when a key/server is configured — lib/license.ts) ──
  add({
    id: 'license-key',
    name: 'License key',
    purpose: 'White-label license key. When set (or LICENSE_SERVER_URL is), the store enforces Demo Mode on MISSING/EXPIRED keys (write routes blocked).',
    variable: 'CLIENT_LICENSE_KEY',
    aliases: ['LICENSE_KEY'],
    kind: 'license',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('CLIENT_LICENSE_KEY')],
  });

  add({
    id: 'license-server',
    name: 'License server URL',
    purpose: 'Optional endpoint that validates CLIENT_LICENSE_KEY asynchronously (cached).',
    variable: 'LICENSE_SERVER_URL',
    aliases: [],
    kind: 'license',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('LICENSE_SERVER_URL')],
  });

  // ── AI providers (universal AI engine — services/ai) ───────────────────────
  add({
    id: 'ai-deepseek',
    name: 'DeepSeek Pro API key',
    purpose: 'DeepSeek Pro (OpenAI-compatible) — the default AI provider for image-to-animation + SVG generation.',
    variable: 'DEEPSEEK_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('DEEPSEEK_API_KEY')],
  });
  add({
    id: 'ai-openai',
    name: 'OpenAI API key',
    purpose: 'OpenAI GPT-4o-mini chat completions.',
    variable: 'OPENAI_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('OPENAI_API_KEY')],
  });
  add({
    id: 'ai-anthropic',
    name: 'Anthropic API key',
    purpose: 'Anthropic Claude Messages API.',
    variable: 'ANTHROPIC_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('ANTHROPIC_API_KEY')],
  });
  add({
    id: 'ai-replicate',
    name: 'Replicate API token',
    purpose: 'Replicate hosted models (async predictions).',
    variable: 'REPLICATE_API_TOKEN',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('REPLICATE_API_TOKEN')],
  });
  add({
    id: 'ai-openrouter',
    name: 'OpenRouter API key',
    purpose: 'OpenRouter (OpenAI-compatible) — one key for hundreds of models.',
    variable: 'OPENROUTER_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('OPENROUTER_API_KEY')],
  });
  add({
    id: 'ai-groq',
    name: 'Groq API key',
    purpose: 'Groq (OpenAI-compatible) — fast Llama inference.',
    variable: 'GROQ_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('GROQ_API_KEY')],
  });
  add({
    id: 'ai-mistral',
    name: 'Mistral API key',
    purpose: 'Mistral (OpenAI-compatible) — Mistral models.',
    variable: 'MISTRAL_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('MISTRAL_API_KEY')],
  });
  add({
    id: 'ai-google-gemini',
    name: 'Google Gemini API key',
    purpose: 'Google Gemini — Gemini 1.5 Flash text generation.',
    variable: 'GEMINI_API_KEY',
    aliases: [],
    kind: 'ai',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('GEMINI_API_KEY')],
  });

  // ── First-run bootstrap ─────────────────────────────────────────────────────
  add({
    id: 'initial-admin-email',
    name: 'Initial admin email',
    purpose:
      'Optional bootstrap hint. In this build the master admin is created by the Setup Wizard (Supabase admin) or by setting the Basic Auth credentials above — there is no automatic "first registration claims admin" flow. Set this to keep the operator informed of the intended admin inbox.',
    variable: 'INITIAL_ADMIN_EMAIL',
    aliases: [],
    kind: 'bootstrap',
    required: false,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('INITIAL_ADMIN_EMAIL')],
  });

  // ── Group the checks ────────────────────────────────────────────────────────
  const byKind = (kind: EnvCheckKind): EnvCheck[] => checks.filter((c) => c.kind === kind);
  const groups: EnvGroup[] = [
    { title: 'Data store', subtitle: 'Any ONE of these unlocks the store — Supabase (default), Cloudflare KV/D1, or Upstash Redis.', kind: 'storage', checks: byKind('storage') },
    { title: 'Admin access', subtitle: 'Any ONE admin method — a master admin account (Setup Wizard) OR the Basic Auth password.', kind: 'admin', checks: byKind('admin') },
    { title: 'Payments', subtitle: 'Needed to charge cards and run raffles.', kind: 'payment', checks: byKind('payment') },
    { title: 'Email', subtitle: 'Transactional + verification emails.', kind: 'email', checks: byKind('email') },
    { title: 'Maps', subtitle: 'Address autofill at checkout.', kind: 'maps', checks: byKind('maps') },
    { title: 'Security', subtitle: 'Scheduled-draw safety net auth.', kind: 'security', checks: byKind('security') },
    { title: 'Site identity', subtitle: 'Branding, URLs and support inbox.', kind: 'site', checks: byKind('site') },
    { title: 'Platform configuration', subtitle: 'Supabase-backed provider settings (Setup Wizard) — also the default data store when configured.', kind: 'platform', checks: byKind('platform') },
    { title: 'Cloudflare bindings', subtitle: 'Detected for Cloudflare deployments — not used by this storefront build.', kind: 'binding', checks: byKind('binding') },
    { title: 'Licensing', subtitle: 'Optional — enforced when a key/server is configured.', kind: 'license', checks: byKind('license') },
    { title: 'AI providers', subtitle: 'Universal AI engine (image-to-animation + SVG).', kind: 'ai', checks: byKind('ai') },
    { title: 'First-run bootstrap', subtitle: 'Optional hints for the initial operator.', kind: 'bootstrap', checks: byKind('bootstrap') },
  ];

  // Blocking state is GROUP-level: the store needs ANY ONE storage driver and
  // ANY ONE admin method. No individual variable is ever mandatory on its own.
  const drivers = detectStorageDrivers(env);
  const storageOk = drivers.supabase || drivers.cloudflare || drivers.redis;
  const supabaseFull =
    has(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL') &&
    has(env, 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY') &&
    has(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const adminEnvOk = has(env, 'ADMIN_BASIC_AUTH_PASSWORD') || supabaseFull;

  const blockingMissing: string[] = [];
  if (!storageOk) blockingMissing.push('storage');
  if (!adminEnvOk) blockingMissing.push('admin');
  const requiredMissing = checks.filter((c) => c.required && !c.present).map((c) => c.id);

  return {
    groups,
    all: checks,
    summary: {
      present: checks.filter((c) => c.present).length,
      total: checks.length,
      blockingMissing,
      requiredMissing,
    },
    blockingReady: blockingMissing.length === 0,
    requiredReady: requiredMissing.length === 0,
  };
}

export interface AdminReadinessInput {
  /** Which storage drivers are individually satisfied (see detectStorageDrivers()). */
  storage: StorageDriverState;
  /** A resolvable Basic Auth password (username defaults to "admin"). */
  legacyAdminOk: boolean;
  /** Supabase `is_configured` — true when a master super-admin exists. Null when unknown. */
  platformConfigured: boolean | null;
}

/**
 * The ONE place that decides whether the admin portal is ready to open. Used by
 * BOTH middleware.ts (edge) and /api/admin/setup so they can never drift.
 *
 * Ready = AT LEAST ONE storage driver is satisfied (Supabase / Cloudflare KV-D1 /
 * Redis — or Supabase already configured via the wizard) AND at least one admin
 * method exists (a Supabase super-admin OR the legacy Basic Auth password).
 */
export function computeAdminReady(input: AdminReadinessInput): boolean {
  const storageOk =
    input.storage.supabase ||
    input.storage.cloudflare ||
    input.storage.redis ||
    input.platformConfigured === true;
  const adminOk = input.platformConfigured === true || input.legacyAdminOk;
  return storageOk && adminOk;
}
