/**
 * SECRETS MANIFEST: every secret the platform needs, where it lives, what it
 * is for and how to get it. Values never appear here or in any output of the
 * checker (check-secrets.ts prints names and present/missing only).
 *
 * Where a secret lives:
 *   worker    a Worker secret (`wrangler secret put NAME`, piped from stdin)
 *   database  global_platform_settings, saved through the Setup Wizard or
 *             bootstrap's setup step (the server reads it from there)
 *   local     the operator's own machine (.env.local), for scripts only
 * Plain, non-secret config (name, domain, addresses, public keys) is NOT here:
 * it is generated into wrangler.jsonc by wrangler-config.ts.
 */
export type SecretPlace = 'worker' | 'database' | 'local';
export type SecretSpec = {
  name: string;
  place: SecretPlace;
  required: boolean;
  purpose: string;
  obtain: string;
  /** database secrets: the global_platform_settings column. */
  column?: string;
};

export const SECRETS: SecretSpec[] = [
  { name: 'SUPABASE_URL', place: 'worker', required: true, purpose: 'the database API address', obtain: 'Supabase → Project Settings → API → Project URL' },
  { name: 'SUPABASE_ANON_KEY', place: 'worker', required: true, purpose: 'public client key (customer sign-in)', obtain: 'Supabase → Project Settings → API → anon public' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', place: 'worker', required: true, purpose: 'the server\'s full database access', obtain: 'Supabase → Project Settings → API → service_role (never in a browser)' },
  { name: 'MEDIA_S3_ACCESS_KEY_ID', place: 'worker', required: true, purpose: 'R2 photo storage (S3 API)', obtain: 'Cloudflare → R2 → Manage API tokens → Object Read & Write, this bucket only' },
  { name: 'MEDIA_S3_SECRET_ACCESS_KEY', place: 'worker', required: true, purpose: 'R2 photo storage (S3 API)', obtain: 'shown once when the R2 token is created' },
  { name: 'TURNSTILE_SECRET_KEY', place: 'worker', required: true, purpose: 'signup bot check, server side', obtain: 'Cloudflare → Turnstile → the widget → Secret key (bootstrap step "cloudflare" creates the widget)' },
  { name: 'CRON_SECRET', place: 'worker', required: true, purpose: 'authenticates scheduled jobs', obtain: 'generate: 32+ random bytes (bootstrap generates it)' },
  { name: 'RESEND_FROM', place: 'worker', required: true, purpose: 'sender address for platform mail ("Name <notifications@domain>")', obtain: 'after the sending domain verifies in Resend' },
  { name: 'payment_api_key', column: 'payment_api_key', place: 'database', required: true, purpose: 'Stripe secret key (test sk_test_ until live activation)', obtain: 'Stripe → Developers → API keys' },
  { name: 'payment_webhook_secret', column: 'payment_webhook_secret', place: 'database', required: true, purpose: 'signs the platform webhook', obtain: 'returned when bootstrap step "stripe-webhooks" creates the endpoint' },
  { name: 'payment_connect_webhook_secret', column: 'payment_connect_webhook_secret', place: 'database', required: true, purpose: 'signs the Connect webhook', obtain: 'returned when bootstrap step "stripe-webhooks" creates the Connect endpoint' },
  { name: 'mail_api_key', column: 'mail_api_key', place: 'database', required: true, purpose: 'Resend API key (sending only)', obtain: 'Resend → API Keys → Create (Sending access, this domain)' },
  { name: 'map_api_key', column: 'map_api_key', place: 'database', required: false, purpose: 'address autofill (Mapbox public token, URL-restricted)', obtain: 'Mapbox → Access tokens' },
  { name: 'CLOUDFLARE_API_TOKEN', place: 'worker', required: false, purpose: 'custom domains for stores (Cloudflare for SaaS)', obtain: 'Cloudflare → My Profile → API Tokens: Zone.SSL and Certificates Edit + Zone.DNS Edit, this zone only' },
  { name: 'SUPABASE_ACCESS_TOKEN', place: 'local', required: false, purpose: 'bootstrap applies migrations through the Management API', obtain: 'Supabase → Account → Access Tokens (operator machine only)' },
  { name: 'CLOUDFLARE_BOOTSTRAP_TOKEN', place: 'local', required: false, purpose: 'bootstrap creates DNS records, the R2 bucket and the Turnstile widget', obtain: 'Cloudflare → API Tokens: DNS Edit, R2 Edit, Turnstile Edit, Workers Routes Edit (operator machine only, delete after the move)' },
  { name: 'RESEND_BOOTSTRAP_KEY', place: 'local', required: false, purpose: 'bootstrap adds the sending domain', obtain: 'Resend → API Keys (Full access, operator machine only, delete after the move)' },
  { name: 'STRIPE_BOOTSTRAP_KEY', place: 'local', required: false, purpose: 'bootstrap creates the two webhook endpoints', obtain: 'Stripe → restricted key with Webhook Endpoints write (operator machine only)' },
];

export type SecretCheck = { name: string; place: SecretPlace; required: boolean; present: boolean };

/**
 * Which secrets are present, given the NAMES found in each place (pure; the
 * CLI gathers names from `wrangler secret list`, the settings row's non-empty
 * columns and the local environment, never values).
 */
export function checkSecrets(found: { worker: Set<string>; database: Set<string>; local: Set<string> }, specs: SecretSpec[] = SECRETS): { checks: SecretCheck[]; missingRequired: string[] } {
  const checks = specs.map((s) => ({ name: s.name, place: s.place, required: s.required, present: found[s.place].has(s.column || s.name) }));
  return { checks, missingRequired: checks.filter((c) => c.required && !c.present).map((c) => c.place + ':' + c.name) };
}
