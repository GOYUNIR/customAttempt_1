/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PRODUCTION ENV GUARDRAILS — Zod format validation for secrets.
 *
 * This template is white-label and every credential is OPTIONAL at the env
 * level (Stripe/Supabase/storage/mail keys can all be entered later through
 * the admin Setup Wizard instead — see services/config/platform-settings.ts).
 * So this schema does NOT require any variable to be set; a missing value is
 * the store's normal "not configured yet" state, already handled by the
 * readiness gates in lib/env-discovery.ts.
 *
 * What it DOES catch: a variable that IS set but is malformed — a truncated
 * copy-paste, the wrong key pasted into the wrong field, a literal
 * "your-key-here" placeholder left in .env, or an unresolved platform
 * template token. A malformed-but-present secret is a strictly worse failure
 * mode than an absent one: the app doesn't gracefully fall back to "not
 * configured," it fails in whatever confusing way that specific bad value
 * causes downstream (a Stripe client that 401s on every request, a Supabase
 * client that can't parse its own key, …).
 *
 * `validateProductionEnv()` returns `errors` (hard-block production writes —
 * see middleware.ts) and `warnings` (logged, surfaced in the admin panel,
 * never blocking — e.g. a short-but-technically-valid admin password).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';

const placeholderTokens = ['your-key-here', 'your_key_here', 'xxxxx', 'changeme', 'REPLACE_ME', 'sk_test_xxx'];

function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return placeholderTokens.some((tok) => v === tok.toLowerCase()) || /^\$\{?[a-z_]+\}?$/i.test(value.trim());
}

/** A field that's fine when absent, but must match `pattern` when present. */
function optionalFormat(pattern: RegExp, message: string) {
  return z
    .string()
    .optional()
    .refine((v) => !v || !looksLikePlaceholder(v), { message: 'looks like a placeholder value, not a real key' })
    .refine((v) => !v || pattern.test(v.trim()), { message });
}

const ProductionEnvSchema = z.object({
  ADMIN_BASIC_AUTH_PASSWORD: z.string().optional(),
  STRIPE_SECRET_KEY: optionalFormat(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'must be a real Stripe secret/restricted key (sk_live_… / sk_test_…)'),
  STRIPE_WEBHOOK_SECRET: optionalFormat(/^whsec_[A-Za-z0-9]+$/, 'must start with whsec_'),
  STRIPE_PRODUCT_ID: optionalFormat(/^price_[A-Za-z0-9]+$/, 'must be a Stripe Price ID (price_…), not a Product ID (prod_…) or raw amount'),
  RESEND_API_KEY: optionalFormat(/^re_[A-Za-z0-9_]+$/, 'must start with re_'),
  SUPABASE_URL: optionalFormat(/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i, 'must be a full https://<project>.supabase.co URL'),
  NEXT_PUBLIC_SUPABASE_URL: optionalFormat(/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i, 'must be a full https://<project>.supabase.co URL'),
  // TWO KEY FORMATS, both current. Legacy Supabase keys are JWTs; projects
  // created or rotated since the API-key change use sb_secret_/sb_publishable_,
  // which are not JWTs at all. A JWT-only rule called a working key malformed
  // and failed the production readiness gate -- found exactly that way.
  SUPABASE_SERVICE_ROLE_KEY: optionalFormat(/^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+)$/, 'must be a Supabase key: a JWT (three dot-separated segments) or the newer sb_secret_/sb_publishable_ form -- check for a truncated copy-paste'),
  SUPABASE_ANON_KEY: optionalFormat(/^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+)$/, 'must be a Supabase key: a JWT (three dot-separated segments) or the newer sb_secret_/sb_publishable_ form -- check for a truncated copy-paste'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalFormat(/^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+)$/, 'must be a Supabase key: a JWT (three dot-separated segments) or the newer sb_secret_/sb_publishable_ form -- check for a truncated copy-paste'),
  UPSTASH_REDIS_REST_URL: optionalFormat(/^https:\/\/.+\.upstash\.io\/?$/i, 'must be a full https://….upstash.io REST URL'),
  KV_REST_API_URL: optionalFormat(/^https:\/\/.+\.upstash\.io\/?$/i, 'must be a full https://….upstash.io REST URL'),
  UPSTASH_REDIS_REST_TOKEN: optionalFormat(/^\S+$/, 'must not contain whitespace (check for a copy-paste including a trailing newline/space)'),
  KV_REST_API_TOKEN: optionalFormat(/^\S+$/, 'must not contain whitespace'),
  NEXT_PUBLIC_MAPBOX_TOKEN: optionalFormat(/^pk\.[A-Za-z0-9._-]+$/, 'must be a Mapbox PUBLIC token (pk.…) — never paste a secret (sk.…) token here, it is exposed to every browser'),
  CRON_SECRET: z.string().optional(),
  // Parsed by lib/feature-flags.ts's isPostgresPrimaryEnabled() as exactly
  // the string 'true' (case-insensitive) or anything else (falsy) — so a
  // typo like 'TRUE ' or 'yes'/'1' would silently evaluate to off/on in a
  // way that doesn't match what was typed. Catch that here rather than let
  // it fail silently in a way the operator won't notice until cutover.
  USE_POSTGRES_PRIMARY: optionalFormat(/^(true|false)$/i, 'must be exactly "true" or "false" (case-insensitive) — see lib/feature-flags.ts'),
});

export type ProductionEnvIssue = { field: string; message: string; severity: 'error' | 'warning' };

/**
 * Validate the current `process.env` against the production schema.
 * Malformed values (present but wrong shape) become `errors`; weak-but-valid
 * values become `warnings`. Missing values are never reported — this
 * function only judges the shape of what IS there.
 */
export function validateProductionEnv(env: Record<string, string | undefined> = process.env): {
  ok: boolean;
  errors: ProductionEnvIssue[];
  warnings: ProductionEnvIssue[];
} {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(ProductionEnvSchema.shape)) {
    input[key] = env[key];
  }

  const result = ProductionEnvSchema.safeParse(input);
  const errors: ProductionEnvIssue[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] || 'unknown');
      errors.push({ field, message: issue.message, severity: 'error' });
    }
  }

  const warnings: ProductionEnvIssue[] = [];
  const adminPassword = env.ADMIN_BASIC_AUTH_PASSWORD;
  if (adminPassword && adminPassword.length < 12) {
    warnings.push({
      field: 'ADMIN_BASIC_AUTH_PASSWORD',
      message: 'shorter than 12 characters — use a long, random admin password in production',
      severity: 'warning',
    });
  }
  const cronSecret = env.CRON_SECRET;
  if (cronSecret && cronSecret.length < 16) {
    warnings.push({
      field: 'CRON_SECRET',
      message: 'shorter than 16 characters — a weak cron secret can be guessed by an attacker probing scheduled endpoints',
      severity: 'warning',
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Cheap boolean form for a hard gate (see middleware.ts's license-gate-style
 *  block): true only when a genuinely malformed (not merely weak) production
 *  secret is present. */
export function productionEnvHasBlockingIssues(env: Record<string, string | undefined> = process.env): boolean {
  return validateProductionEnv(env).errors.length > 0;
}
