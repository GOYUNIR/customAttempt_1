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
 *     `blocking` — the admin portal CANNOT open without it: the data store
 *                  (Redis URL + token) and admin credentials. Missing blocking
 *                  checks (plus a missing admin account) are what middleware.ts
 *                  uses to intercept `/admin` and show the setup checklist.
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

const WRANGLER_SECRET = (name: string) => `npx wrangler secret put ${name}`;

/**
 * Build the full registry against a given env object. Called fresh each time so
 * `present` always reflects the CURRENT environment (the middleware re-runs it
 * per request; the setup-status route calls it once per GET).
 */
export function discoverEnvironment(env: EnvObject = process.env): EnvDiscoveryResult {
  const checks: EnvCheck[] = [];

  const add = (check: Omit<EnvCheck, 'present'>): void => {
    checks.push({ ...check, present: has(env, check.variable, ...check.aliases) });
  };

  // ── Storage (blocking) ──────────────────────────────────────────────────────
  add({
    id: 'redis-url',
    name: 'Redis REST URL',
    purpose: 'The data store URL — every product, order, entry and setting lives here. The admin portal is unusable without it.',
    variable: 'UPSTASH_REDIS_REST_URL',
    aliases: ['KV_REST_API_URL', 'REDIS_REST_URL', 'REDIS_URL', 'KV_URL'],
    kind: 'storage',
    required: true,
    blocking: true,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('UPSTASH_REDIS_REST_URL'),
      'vercel env add UPSTASH_REDIS_REST_URL production',
    ],
  });

  add({
    id: 'redis-token',
    name: 'Redis REST token',
    purpose: 'The data store access token paired with the URL. Stored as a secret — never commit it.',
    variable: 'UPSTASH_REDIS_REST_TOKEN',
    aliases: ['KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'REDIS_TOKEN'],
    kind: 'storage',
    required: true,
    blocking: true,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('UPSTASH_REDIS_REST_TOKEN'),
      'vercel env add UPSTASH_REDIS_REST_TOKEN production',
    ],
  });

  add({
    id: 'storage-provider',
    name: 'Storage provider',
    purpose: 'Which data backend is used. Default (unset) is Upstash Redis. Set STORAGE_PROVIDER=cloudflare-kv to run on the Workers-KV adapter instead of a Redis URL/token.',
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

  // ── Admin access (blocking) ─────────────────────────────────────────────────
  add({
    id: 'admin-username',
    name: 'Admin Basic Auth username',
    purpose: 'The username for the /admin HTTP Basic Auth login. Defaults to "admin" when unset.',
    variable: 'ADMIN_BASIC_AUTH_USERNAME',
    aliases: [],
    kind: 'admin',
    required: true,
    blocking: false,
    secret: false,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('ADMIN_BASIC_AUTH_USERNAME'),
      'vercel env add ADMIN_BASIC_AUTH_USERNAME production',
    ],
  });

  add({
    id: 'admin-password',
    name: 'Admin Basic Auth password',
    purpose: 'The password that gates /admin. In production this MUST be set — the admin portal cannot open without it (unless a Supabase super-admin account is configured).',
    variable: 'ADMIN_BASIC_AUTH_PASSWORD',
    aliases: [],
    kind: 'admin',
    required: true,
    blocking: true,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [
      WRANGLER_SECRET('ADMIN_BASIC_AUTH_PASSWORD'),
      'vercel env add ADMIN_BASIC_AUTH_PASSWORD production',
    ],
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
    commands: [
      WRANGLER_SECRET('STRIPE_SECRET_KEY'),
      'vercel env add STRIPE_SECRET_KEY production',
    ],
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
    commands: [
      WRANGLER_SECRET('STRIPE_WEBHOOK_SECRET'),
      'vercel env add STRIPE_WEBHOOK_SECRET production',
    ],
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
    commands: [
      'npx wrangler secret put NEXT_PUBLIC_MAPBOX_TOKEN   # then rebuild (NEXT_PUBLIC_* is build-time)',
      'vercel env add NEXT_PUBLIC_MAPBOX_TOKEN production',
    ],
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
    commands: [
      WRANGLER_SECRET('CRON_SECRET'),
      'vercel env add CRON_SECRET production',
    ],
  });

  // ── Site identity ───────────────────────────────────────────────────────────
  add({
    id: 'site-url',
    name: 'Canonical site URL',
    purpose: 'Used in emails, OG/social cards and canonical links. If unset, the platform system vars are used automatically (Vercel VERCEL_URL, Netlify URL, Cloudflare CF_PAGES_URL).',
    variable: 'NEXT_PUBLIC_URL',
    aliases: ['NEXT_PUBLIC_SITE_URL', 'SITE_URL'],
    kind: 'site',
    required: true,
    blocking: false,
    secret: false,
    buildTime: true,
    platform: 'all',
    commands: ['vercel env add NEXT_PUBLIC_URL production   # then redeploy'],
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
    purpose: 'Public anon key for the is_platform_configured RPC + super-admin sign-in.',
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
    purpose: 'Server-only trusted writer — the Setup Wizard uses it to persist provider keys + create the master super-admin.',
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

  // ── Licensing (optional — not enforced by this build) ───────────────────────
  add({
    id: 'license-key',
    name: 'License key',
    purpose: 'Optional license key for gated/white-label deployments. Not enforced by the storefront runtime — shown for completeness.',
    variable: 'LICENSE_KEY',
    aliases: [],
    kind: 'license',
    required: false,
    blocking: false,
    secret: true,
    buildTime: false,
    platform: 'all',
    commands: [WRANGLER_SECRET('LICENSE_KEY')],
  });

  add({
    id: 'license-server',
    name: 'License server URL',
    purpose: 'Optional endpoint that validates LICENSE_KEY. Not enforced by this build — shown for completeness.',
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

  // ── First-run bootstrap ─────────────────────────────────────────────────────
  add({
    id: 'initial-admin-email',
    name: 'Initial admin email',
    purpose:
      'Optional bootstrap hint. In this build the master admin is created by the Setup Wizard (Supabase super-admin) or by setting the Basic Auth credentials above — there is no automatic "first registration claims admin" flow. Set this to keep the operator informed of the intended admin inbox.',
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
    { title: 'Data store', subtitle: 'Required before the admin portal can open.', kind: 'storage', checks: byKind('storage') },
    { title: 'Admin access', subtitle: 'Required before the admin portal can open (or a Supabase super-admin).', kind: 'admin', checks: byKind('admin') },
    { title: 'Payments', subtitle: 'Needed to charge cards and run raffles.', kind: 'payment', checks: byKind('payment') },
    { title: 'Email', subtitle: 'Transactional + verification emails.', kind: 'email', checks: byKind('email') },
    { title: 'Maps', subtitle: 'Address autofill at checkout.', kind: 'maps', checks: byKind('maps') },
    { title: 'Security', subtitle: 'Scheduled-draw safety net auth.', kind: 'security', checks: byKind('security') },
    { title: 'Site identity', subtitle: 'Branding, URLs and support inbox.', kind: 'site', checks: byKind('site') },
    { title: 'Platform configuration', subtitle: 'Optional Supabase-backed provider settings (Setup Wizard).', kind: 'platform', checks: byKind('platform') },
    { title: 'Cloudflare bindings', subtitle: 'Detected for Cloudflare deployments — not used by this storefront build.', kind: 'binding', checks: byKind('binding') },
    { title: 'Licensing', subtitle: 'Optional — not enforced by the storefront runtime.', kind: 'license', checks: byKind('license') },
    { title: 'First-run bootstrap', subtitle: 'Optional hints for the initial operator.', kind: 'bootstrap', checks: byKind('bootstrap') },
  ];

  const blockingMissing = checks.filter((c) => c.blocking && !c.present).map((c) => c.id);
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
  /** `createStorageClient() !== null` — the data backend is reachable. */
  storageOk: boolean;
  /** A resolvable Basic Auth password (username defaults to "admin"). */
  legacyAdminOk: boolean;
  /** Supabase `is_configured` — true when a master super-admin exists. Null when unknown. */
  platformConfigured: boolean | null;
}

/**
 * The ONE place that decides whether the admin portal is ready to open. Used by
 * BOTH middleware.ts (edge) and /api/admin/setup-status so they can never drift.
 *
 * Ready = the data store is configured AND an admin account exists (either a
 * Supabase super-admin OR the legacy Basic Auth password).
 */
export function computeAdminReady(input: AdminReadinessInput): boolean {
  const adminAccountOk = input.platformConfigured === true || input.legacyAdminOk;
  return input.storageOk && adminAccountOk;
}
