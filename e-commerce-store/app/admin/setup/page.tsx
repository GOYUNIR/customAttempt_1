'use client';

/**
 * /admin/setup — the production Setup Wizard.
 *
 * A clean 5-step flow:
 *   1. Primary data store
 *   2. Master admin account
 *   3. Essential core services (payments + webhooks, transactional email, maps)
 *   4. System security & site identity
 *   5. Optional features (AI engine)
 *
 * Every provider selection drives its OWN input fields, environment-variable
 * names, placeholders and helper text — switching a provider swaps the form
 * instead of merely relabeling a generic field. Saving re-scans the environment
 * health check in place (no hard refresh) and updates the readiness gate.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { buildSchemaFixPlan, type SchemaFixPlan } from '@/lib/setup-schema-guide';

// ── shared styles ─────────────────────────────────────────────────────────────
const inputStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const invalidInputStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #ef4444', background: '#fef2f2', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const selectStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%' } as const;
const labelStyle = { fontSize: 13, fontWeight: 700, color: '#374151' } as const;
const hintStyle = { fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.5 } as const;
const mutedStyle = { fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.5 } as const;
const noteStyle = { fontSize: 13, color: '#6b7280', margin: 0, lineHeight: 1.6 } as const;

// ── provider field specs ──────────────────────────────────────────────────────
// Each provider declares the EXACT fields it needs. The form renders only the
// active provider's fields, so changing a provider changes the inputs, env-var
// names, placeholders and tooltips — it never just relabels a generic field.

type FieldSpec = {
  /** Form key (persisted to global_platform_settings / operational_settings). */
  key: string;
  label: string;
  /** The environment variable this field maps to (shown + copyable). */
  envVar?: string;
  placeholder?: string;
  /** Plain-English "what it does / where to copy it" helper. */
  hint?: string;
  secret?: boolean;
  optional?: boolean;
  /** Override the generated copy command. */
  command?: string;
};

type ProviderSpec = {
  value: string;
  label: string;
  hint: string;
  fields: FieldSpec[];
};

const STORAGE_OPTIONS: ProviderSpec[] = [
  {
    value: 'supabase',
    label: 'Supabase (recommended)',
    hint: 'Postgres + Auth + row-level security. Also stores your configuration and the master admin account.',
    fields: [
      { key: 'supabase_url', label: 'Project URL', envVar: 'SUPABASE_URL', placeholder: 'https://abcdefghijklm.supabase.co', hint: 'Supabase dashboard → Project Settings → API → Project URL (e.g. https://abcdefghijklm.supabase.co).' },
      { key: 'supabase_anon_key', label: 'Anon public key', envVar: 'SUPABASE_ANON_KEY', secret: true, placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…', hint: 'Project Settings → API → anon public key — a long JWT starting with "eyJ…" (safe to expose in the browser).' },
      { key: 'supabase_service_role_key', label: 'Service role key', envVar: 'SUPABASE_SERVICE_ROLE_KEY', secret: true, placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…', hint: 'Project Settings → API → service_role key — a long JWT starting with "eyJ…", server-only, never expose it.' },
    ],
  },
  {
    value: 'upstash',
    label: 'Upstash Redis',
    hint: 'REST Redis — the battle-tested engine for concurrent raffle and payment writes.',
    fields: [
      { key: 'upstash_redis_rest_url', label: 'REST URL', envVar: 'UPSTASH_REDIS_REST_URL', placeholder: 'https://eu1-brave-falcon-12345.upstash.io', hint: 'Upstash Console → Redis → REST API → UPSTASH_REDIS_REST_URL (e.g. https://eu1-brave-falcon-12345.upstash.io).' },
      { key: 'upstash_redis_rest_token', label: 'REST token', envVar: 'UPSTASH_REDIS_REST_TOKEN', secret: true, placeholder: 'AX3rASFh…', hint: 'Same page → UPSTASH_REDIS_REST_TOKEN — a long alphanumeric token (e.g. AX3rASFh…).' },
    ],
  },
  {
    value: 'cloudflare-kv',
    label: 'Cloudflare KV / D1',
    hint: 'Zero third-party store via native Cloudflare bindings. Concurrency caveats apply to raffle/payment writes.',
    fields: [
      { key: 'cloudflare_kv_binding', label: 'KV namespace binding', envVar: 'wrangler.toml', placeholder: 'SITE_CACHE', hint: 'The binding name from wrangler.toml [[kv_namespaces]]. Create the namespace with `npx wrangler kv namespace create`.', command: 'npx wrangler kv namespace create' },
      { key: 'cloudflare_d1_binding', label: 'D1 database binding', envVar: 'wrangler.toml', placeholder: 'DB', optional: true, hint: 'The binding name from wrangler.toml [[d1_databases]] — only needed for the D1 adapter.' },
    ],
  },
];

const PAYMENT_OPTIONS: ProviderSpec[] = [
  {
    value: 'none',
    label: 'Skip payments for now',
    hint: 'Launch without a payment provider. You can add Stripe / Lemon Squeezy / Paddle later from the reconfigure screen.',
    fields: [],
  },
  {
    value: 'stripe',
    label: 'Stripe',
    hint: 'Full support — raffle card-save + instant-buy + signed webhooks.',
    fields: [
      { key: 'payment_api_key', label: 'Secret key', envVar: 'STRIPE_SECRET_KEY', secret: true, placeholder: 'sk_live_51…', hint: 'Stripe Dashboard → Developers → API keys → Secret key (starts with "sk_live_" or "sk_test_").' },
      { key: 'payment_webhook_secret', label: 'Webhook signing secret', envVar: 'STRIPE_WEBHOOK_SECRET', secret: true, placeholder: 'whsec_…', hint: 'Stripe Dashboard → Developers → Webhooks → your /api/stripe/webhook endpoint → Signing secret (starts with "whsec_").' },
      { key: 'stripe_product_id', label: 'Default price ID', envVar: 'STRIPE_PRODUCT_ID', optional: true, placeholder: 'price_1ABC…', hint: 'Global fallback price. Per-product / per-size price IDs set in /admin always win (starts with "price_").' },
    ],
  },
  {
    value: 'lemon_squeezy',
    label: 'Lemon Squeezy',
    hint: 'Merchant-of-record checkout — instant-buy only (no raffle card-save).',
    fields: [
      { key: 'payment_api_key', label: 'API key', envVar: 'LEMONSQUEEZY_API_KEY', secret: true, placeholder: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.…', hint: 'Lemon Squeezy → Settings → API → API key (a long JWT starting with "eyJ…").' },
    ],
  },
  {
    value: 'paddle',
    label: 'Paddle',
    hint: 'Paddle Billing custom checkout — instant-buy only (no raffle card-save).',
    fields: [
      { key: 'payment_api_key', label: 'API key', envVar: 'PADDLE_API_KEY', secret: true, placeholder: 'pdl_live_AbCdEf…', hint: 'Paddle → Developer tools → Authentication → API key (starts with "pdl_live_" or "pdl_test_").' },
    ],
  },
];

const EMAIL_OPTIONS: ProviderSpec[] = [
  {
    value: 'resend',
    label: 'Resend',
    hint: 'Developer-friendly — the onboarding@resend.dev sandbox works immediately for testing.',
    fields: [
      { key: 'mail_api_key', label: 'API key', envVar: 'RESEND_API_KEY', secret: true, placeholder: 're_AbCdEf123456…', hint: 'Resend → API Keys → Create API key (starts with "re_").' },
    ],
  },
  {
    value: 'postmark',
    label: 'Postmark',
    hint: 'Fast transactional delivery. Requires a verified sender signature.',
    fields: [
      { key: 'mail_api_key', label: 'Server API token', envVar: 'POSTMARK_API_KEY', secret: true, placeholder: '9f4a2c1e-7d3b-4f8a-9c5e-1234567890ab', hint: 'Postmark → Servers → your server → API Tokens (a 36-character UUID).' },
    ],
  },
  {
    value: 'sendgrid',
    label: 'SendGrid',
    hint: 'Twilio SendGrid v3 mail API. Requires a verified sender address.',
    fields: [
      { key: 'mail_api_key', label: 'API key', envVar: 'SENDGRID_API_KEY', secret: true, placeholder: 'SG.AbCdEf123456…', hint: 'SendGrid → Settings → API Keys → Create API key (starts with "SG.").' },
    ],
  },
];

const MAP_OPTIONS: ProviderSpec[] = [
  {
    value: 'mapbox',
    label: 'Mapbox',
    hint: 'Address autofill via search-js — the storefront default.',
    fields: [
      { key: 'map_api_key', label: 'Public access token', envVar: 'NEXT_PUBLIC_MAPBOX_TOKEN', placeholder: 'pk.eyJ1Ijoi…', hint: 'Mapbox → Account → Access tokens (starts with "pk.eyJ1Ijoi…"). This is build-time on Cloudflare — set it in the shell BEFORE building.' },
    ],
  },
  {
    value: 'google_maps',
    label: 'Google Maps',
    hint: 'Places API address autofill.',
    fields: [
      { key: 'map_api_key', label: 'API key', envVar: 'GOOGLE_MAPS_API_KEY', secret: true, placeholder: 'AIzaSy…', hint: 'Google Cloud Console → APIs & Services → Credentials → Create credentials → API key (starts with "AIza").' },
    ],
  },
  {
    value: 'open_street_map',
    label: 'OpenStreetMap',
    hint: 'Free + keyless (Nominatim). Rate limited — fine for testing.',
    fields: [],
  },
];

const AI_OPTIONS: ProviderSpec[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek Pro',
    hint: 'OpenAI-compatible — best price/quality for image-to-animation prompts (the default primary).',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'DEEPSEEK_API_KEY', secret: true, placeholder: 'sk-…', hint: 'DeepSeek platform → API Keys.' },
    ],
  },
  {
    value: 'deepseek_lite',
    label: 'DeepSeek Lite',
    hint: 'Same DeepSeek API, lighter tier — a cheap secondary fallback.',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'DEEPSEEK_API_KEY', secret: true, placeholder: 'sk-…', hint: 'DeepSeek platform → API Keys.' },
    ],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    hint: 'GPT-4o-mini chat completions.',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'OPENAI_API_KEY', secret: true, placeholder: 'sk-proj-…', hint: 'OpenAI platform → API keys (project keys start with "sk-proj-").' },
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude Messages API.',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'ANTHROPIC_API_KEY', secret: true, placeholder: 'sk-ant-…', hint: 'Anthropic Console → API Keys.' },
    ],
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'One key for hundreds of models (OpenAI-compatible).',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'OPENROUTER_API_KEY', secret: true, placeholder: 'sk-or-…', hint: 'OpenRouter → Keys → Create key.' },
    ],
  },
  {
    value: 'groq',
    label: 'Groq',
    hint: 'Fast Llama inference (OpenAI-compatible).',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'GROQ_API_KEY', secret: true, placeholder: 'gsk_…', hint: 'Groq Cloud → API Keys.' },
    ],
  },
  {
    value: 'mistral',
    label: 'Mistral',
    hint: 'Mistral models (OpenAI-compatible).',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'MISTRAL_API_KEY', secret: true, placeholder: 'AbCdEfGh…', hint: 'Mistral AI → API Keys (a random alphanumeric string, no prefix).' },
    ],
  },
  {
    value: 'google_gemini',
    label: 'Google Gemini',
    hint: 'Gemini 1.5 Flash text generation.',
    fields: [
      { key: 'ai_api_key', label: 'API key', envVar: 'GEMINI_API_KEY', secret: true, placeholder: 'AIzaSy…', hint: 'Google AI Studio → API key (starts with "AIza").' },
    ],
  },
  {
    value: 'replicate',
    label: 'Replicate',
    hint: 'Hosted models (async predictions).',
    fields: [
      { key: 'ai_api_key', label: 'API token', envVar: 'REPLICATE_API_TOKEN', secret: true, placeholder: 'r8_…', hint: 'Replicate → Account → API tokens.' },
    ],
  },
  {
    value: 'workers_ai',
    label: 'Workers AI',
    hint: 'Native Cloudflare binding — no key required.',
    fields: [],
  },
];

/** Secondary (fallback) AI options — same providers plus a "no fallback" choice.
 *  The fields are re-keyed to `ai_api_key_secondary` so they never collide with
 *  the primary slot's `ai_api_key` in the shared form state. */
const AI_SECONDARY_OPTIONS: ProviderSpec[] = [
  { value: 'none', label: 'No fallback', hint: 'Leave this as “No fallback” if you only want one AI provider — the primary provider is the only one used. (DeepSeek Pro and DeepSeek Lite share one key.)', fields: [] },
  ...AI_OPTIONS.map((o) => ({
    ...o,
    fields: o.fields.map((f) => ({ ...f, key: 'ai_api_key_secondary', envVar: undefined, command: undefined })),
  })),
];

const SECURITY_FIELDS: FieldSpec[] = [
  { key: 'admin_basic_auth_password', label: 'Admin Basic Auth password', envVar: 'ADMIN_BASIC_AUTH_PASSWORD', secret: true, placeholder: '••••••••••••', hint: 'HTTP Basic Auth password for /admin (any strong password). Required if you are not using the master admin account.' },
  { key: 'admin_verify_email', label: 'Admin two-step inbox', envVar: 'ADMIN_VERIFY_EMAIL', placeholder: 'admin@yourstore.com', hint: 'Inbox that receives the 6-digit /admin sign-in code (falls back to SUPPORT_EMAIL).' },
  { key: 'cron_secret', label: 'Cron secret', envVar: 'CRON_SECRET', secret: true, placeholder: 'a-long-random-string', hint: 'Authenticates the scheduled draw safety net (Authorization: Bearer $CRON_SECRET) — use a long random string.' },
];

const IDENTITY_FIELDS: FieldSpec[] = [
  { key: 'brand_name', label: 'Brand name', envVar: 'BRAND_NAME', placeholder: 'Your Brand', hint: 'Shown in emails. Also editable in /admin → Settings → Branding & Share.' },
  { key: 'site_url', label: 'Site URL', envVar: 'NEXT_PUBLIC_URL', placeholder: 'https://www.yourstore.com', hint: 'Canonical / OG / email URL (e.g. https://www.yourstore.com). Build-time on Cloudflare — set it in the shell BEFORE building.' },
  { key: 'support_email', label: 'Support email', envVar: 'SUPPORT_EMAIL', placeholder: 'support@yourstore.com', hint: 'The support inbox shown in the footer and used for customer emails.' },
];

// ── status + form types ───────────────────────────────────────────────────────
type Status = {
  configured: boolean;
  ready: boolean;
  storageProvider: string;
  storageDrivers: { supabase: boolean; cloudflare: boolean; redis: boolean };
  storageOk: boolean;
  legacyAdminOk: boolean;
  platformConfigured: boolean;
  operationalConfigured: boolean;
  platformProviders: { mail_provider: string | null; payment_provider: string | null; map_provider: string | null; ai_provider: string | null };
  environment: string;
  cloudflareVarsPath: string;
  /** Raw Supabase schema/connection error from the status endpoint (e.g. a missing table). */
  supabaseSchemaError?: string;
};

const DEFAULT_FORM: Record<string, string> = {
  mail_provider: 'resend',
  mail_api_key: '',
  payment_provider: 'stripe',
  payment_api_key: '',
  payment_webhook_secret: '',
  map_provider: 'mapbox',
  map_api_key: '',
  ai_provider: 'deepseek',
  ai_api_key: '',
  ai_provider_secondary: 'none',
  ai_api_key_secondary: '',
  storage_provider: 'supabase',
  supabase_url: '',
  supabase_anon_key: '',
  supabase_service_role_key: '',
  upstash_redis_rest_url: '',
  upstash_redis_rest_token: '',
  cloudflare_kv_binding: '',
  cloudflare_d1_binding: '',
  admin_basic_auth_password: '',
  admin_verify_email: '',
  cron_secret: '',
  site_url: '',
  brand_name: '',
  support_email: '',
  stripe_product_id: '',
};

/** Build the copyable CLI command for a field's env var (or null when N/A). */
function commandFor(f: FieldSpec): string | null {
  if (f.command) return f.command;
  if (!f.envVar || !/^[A-Z][A-Z0-9_]*$/.test(f.envVar)) return null;
  if (f.envVar.startsWith('NEXT_PUBLIC_')) return `export ${f.envVar}=your-value   # build-time — set BEFORE building`;
  return `npx wrangler secret put ${f.envVar}`;
}

// ── presentational components ─────────────────────────────────────────────────
function Section(props: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ background: '#fff', borderRadius: 16, padding: '20px 22px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)' }}>
      <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: '#111' }}>{props.title}</h2>
      {props.subtitle && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 16px', lineHeight: 1.5 }}>{props.subtitle}</p>}
      <div style={{ display: 'grid', gap: 14 }}>{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; hint?: string; optional?: boolean; error?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={labelStyle}>
        {props.label}
        {props.optional ? <span style={{ color: '#9ca3af', fontWeight: 600 }}> · optional</span> : null}
      </span>
      {props.children}
      {props.error && <span style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>{props.error}</span>}
      {props.hint && <span style={hintStyle}>{props.hint}</span>}
    </label>
  );
}

function EyeIcon(props: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.open ? (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      )}
    </svg>
  );
}

/** Password input with a show/hide eye toggle — lets operators inspect typed/pasted secrets. */
function SecretInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        type={show ? 'text' : 'password'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete || 'off'}
        required={props.required}
        aria-invalid={props.invalid || undefined}
        placeholder={props.placeholder}
        style={{ ...(props.invalid ? invalidInputStyle : inputStyle), paddingRight: 46 }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide secret' : 'Show secret'}
        aria-pressed={show}
        title={show ? 'Hide' : 'Show'}
        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, color: '#6b7280', borderRadius: 8 }}
      >
        <EyeIcon open={show} />
      </button>
    </div>
  );
}

function ProviderFields(props: { fields: FieldSpec[]; values: Record<string, string>; onChange: (k: string, v: string) => void; copied: string; onCopy: (t: string) => void; errors?: Record<string, string> }) {
  if (props.fields.length === 0) {
    return <p style={noteStyle}>No API key required for this option.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {props.fields.map((f) => {
        const cmd = commandFor(f);
        const err = props.errors?.[f.key];
        return (
          <div key={f.key} style={{ display: 'grid', gap: 6 }}>
            <Field label={f.label} hint={f.hint} optional={f.optional} error={err}>
              {f.secret ? (
                <SecretInput
                  value={props.values[f.key] || ''}
                  onChange={(v) => props.onChange(f.key, v)}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  invalid={Boolean(err)}
                />
              ) : (
                <input
                  type="text"
                  value={props.values[f.key] || ''}
                  onChange={(e) => props.onChange(f.key, e.target.value)}
                  autoComplete="off"
                  aria-invalid={err ? true : undefined}
                  placeholder={f.placeholder}
                  style={err ? invalidInputStyle : inputStyle}
                />
              )}
            </Field>
            {f.envVar && <p style={mutedStyle}>Env var: <code>{f.envVar}</code></p>}
            {cmd && <CopyCommand text={cmd} copied={props.copied} onCopy={props.onCopy} />}
          </div>
        );
      })}
    </div>
  );
}

function ProviderSelect(props: { label: string; value: string; options: ProviderSpec[]; onChange: (v: string) => void }) {
  const active = props.options.find((o) => o.value === props.value);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={labelStyle}>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={selectStyle}>
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {active && <p style={hintStyle}>{active.hint}</p>}
    </div>
  );
}

function StoragePicker(props: { value: string; options: ProviderSpec[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {props.options.map((o) => (
        <label
          key={o.value}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 12, border: props.value === o.value ? '2px solid #111' : '1px solid #d1d5db', cursor: 'pointer' }}
        >
          <input type="radio" name="storage_provider" checked={props.value === o.value} onChange={() => props.onChange(o.value)} style={{ marginTop: 2 }} />
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{o.label}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>{o.hint}</span>
          </div>
        </label>
      ))}
    </div>
  );
}

function CopyCommand(props: { text: string; copied: string; onCopy: (t: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code style={{ flex: 1, background: '#0f172a', color: '#a5f3fc', padding: '8px 12px', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{props.text}</code>
      <button type="button" onClick={() => props.onCopy(props.text)} style={{ background: props.copied === props.text ? '#10b981' : '#fff', color: props.copied === props.text ? '#fff' : '#111', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {props.copied === props.text ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

/** Rich, stupid-proof "Supabase schema not applied" fix: numbered steps + the
 *  exact SQL to run, each with a 1-click "Copy SQL" button (no repo hunting). */
function SchemaFixCard(props: { plan: SchemaFixPlan; tone?: 'red' | 'yellow' }) {
  const [copiedFile, setCopiedFile] = useState('');
  const t = props.tone === 'yellow'
    ? { background: '#fffbeb', border: '#fde68a', text: '#92400e', sub: '#b45309' }
    : { background: '#fef2f2', border: '#fecaca', text: '#b91c1c', sub: '#7f1d1d' };

  async function copySql(file: string, sql: string) {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedFile(file);
      window.setTimeout(() => setCopiedFile(''), 2000);
    } catch {
      /* clipboard unavailable — the SQL is still visible to select + copy manually */
    }
  }

  return (
    <div style={{ background: t.background, border: `1px solid ${t.border}`, borderRadius: 14, padding: '16px 18px', display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: t.text }}>{props.plan.title}</div>
        <p style={{ fontSize: 13, color: t.sub, margin: 0, lineHeight: 1.5 }}>{props.plan.intro}</p>
      </div>

      <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
        {props.plan.steps.map((s, i) => (
          <li key={i} style={{ fontSize: 13, color: t.sub, lineHeight: 1.55 }}>{s}</li>
        ))}
      </ol>

      {props.plan.migrations.map((m) => (
        <div key={m.file} style={{ background: '#0f172a', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <code style={{ flex: 1, color: '#e2e8f0', fontSize: 12, fontWeight: 700, wordBreak: 'break-all' }}>📄 {m.file}</code>
            <button
              type="button"
              onClick={() => copySql(m.file, m.sql)}
              style={{
                background: copiedFile === m.file ? '#10b981' : '#16a34a',
                color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px',
                fontSize: 13, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {copiedFile === m.file ? '✓ Copied SQL' : 'Copy SQL'}
            </button>
          </div>
          <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', color: '#a5f3fc', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', whiteSpace: 'pre', background: '#020617', borderRadius: 8, padding: '10px 12px' }}>{m.sql}</pre>
        </div>
      ))}

      <p style={{ fontSize: 12.5, color: t.sub, margin: 0, lineHeight: 1.5 }}>✓ {props.plan.verify}</p>
      <p style={{ fontSize: 12.5, color: t.sub, margin: 0, lineHeight: 1.5 }}>💡 {props.plan.cli}</p>
    </div>
  );
}

const STEPS = [
  { id: 1, label: 'Primary data store' },
  { id: 2, label: 'Master admin account' },
  { id: 3, label: 'Core services' },
  { id: 4, label: 'Security & identity' },
  { id: 5, label: 'AI engine' },
];

// Maps the API's failure `stage` back to the wizard step + a plain-English hint
// so the operator sees WHICH service/key failed, not a generic message.
const STAGE_CONTEXT: Record<string, { step: number; title: string; message: string }> = {
  storage_init: {
    step: 0,
    title: 'Data store connection failed',
    message: 'The data store could not be reached. If you chose Supabase, the usual cause is a missing schema — the step-by-step fix is shown below. Otherwise double-check the Project URL / service-role key (or the Upstash REST URL + token) and confirm the project is reachable.',
  },
  create_admin: {
    step: 1,
    title: 'Master admin creation failed',
    message: 'The master admin account could not be created. Confirm the Supabase service role key is valid and that the Auth service (and profiles table) is provisioned, then try again.',
  },
  core_services: {
    step: 2,
    title: 'Core services verification failed',
    message: 'A payment, email or maps key was rejected. Double-check the Stripe / email API key (and the Mapbox public token) for the provider you selected — a wrong key here is caught before anything is saved.',
  },
  ai: {
    step: 4,
    title: 'AI provider verification failed',
    message: 'The AI provider rejected the API key. Confirm the key for the provider you selected (DeepSeek, OpenAI, Anthropic, etc.) and that the account is active.',
  },
  finalize: {
    step: 4,
    title: 'Finalizing configuration failed',
    message: 'Provider settings were saved, but the final configuration flag could not be written. Re-save to retry.',
  },
};

function Stepper(props: { step: number; onStep: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {STEPS.map((s, i) => {
        const active = i === props.step;
        const done = i < props.step;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => props.onStep(i)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              background: active ? '#111' : '#fff', color: active ? '#fff' : '#374151', border: active ? 'none' : '1px solid #d1d5db',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 999, fontSize: 11, fontWeight: 800, background: active ? '#fff' : done ? '#111' : '#e5e7eb', color: active ? '#111' : done ? '#fff' : '#6b7280' }}>{done ? '✓' : s.id}</span>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState<Record<string, string>>(DEFAULT_FORM);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorStage, setErrorStage] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [reconfigure, setReconfigure] = useState(false);
  const [step, setStep] = useState(0);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [schemaError, setSchemaError] = useState<SchemaFixPlan | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('reconfigure=1')) {
      setReconfigure(true);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/setup', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as Partial<Status>;
      setStatus(data as Status);
    } catch {
      // Status fetch failed — the wizard still works without the readiness gate.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set(key: string, value: string) {
    setNotice('');
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function clearError(key: string) {
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  async function saveToServer(): Promise<{
    status: number;
    ok: boolean;
    error?: string;
    stage?: string;
    warning?: string;
    schemaError?: SchemaFixPlan;
  }> {
    const body: Record<string, unknown> = {
      ...form,
      adminEmail,
      adminPassword,
      supabaseUrl: form.supabase_url,
      supabaseAnonKey: form.supabase_anon_key,
      supabaseServiceRoleKey: form.supabase_service_role_key,
      ai_provider: form.ai_provider === 'none' ? '' : form.ai_provider,
      ai_provider_secondary: form.ai_provider_secondary === 'none' ? '' : form.ai_provider_secondary,
      payment_provider: form.payment_provider === 'none' ? '' : form.payment_provider,
    };
    const res = await fetch('/api/admin/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      stage?: string;
      warning?: string;
      schemaError?: SchemaFixPlan;
    };
    return { status: res.status, ok: Boolean(data.ok), ...data };
  }

  /** Sign in as the master admin (sets the super-admin device cookie). Returns
   *  true on success; on failure it surfaces the reason via setError(). */
  async function trySuperLogin(): Promise<boolean> {
    const res = await fetch('/api/admin/super-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      setError(String(data.error || 'Admin sign-in failed.'));
      return false;
    }
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();

    // Final gate: surface any still-missing required fields client-side before
    // hitting the server, and jump to the first step that needs attention.
    const validation = validateAllSteps();
    if (Object.keys(validation.errors).length > 0) {
      setErrors(validation.errors);
      if (validation.firstStep >= 0) {
        setStep(validation.firstStep);
        scrollToTop();
      }
      return;
    }

    setBusy(true);
    setError('');
    setErrorStage(null);
    setSchemaError(null);
    setNotice('');
    setWarning('');
    try {
      let result = await saveToServer();

      // On an already-configured store the server requires authorization (a
      // Basic-Auth password, a super-admin session, or the Supabase service-role
      // key). If we got a 401/403, sign in as the master admin with the
      // credentials ALREADY typed above, then retry the save ONCE — so "enter
      // email + password + Save" works without hunting for a separate Sign-in
      // button.
      if ((result.status === 401 || result.status === 403) && adminEmail && adminPassword) {
        setReconfigure(true);
        if (await trySuperLogin()) {
          result = await saveToServer();
        } else {
          setError(
            result.error ||
              'Sign in first: use the "Sign in as admin" panel above (master account) or authenticate with the admin Basic Auth password, then save again.',
          );
          return;
        }
      }

      if (result.status === 401 || result.status === 403) {
        setReconfigure(true);
        setError(
          result.error ||
            'Sign in first: use the "Sign in as admin" panel above (master account) or authenticate with the admin Basic Auth password, then save again.',
        );
        return;
      }

      if (!result.ok) {
        setError(String(result.error || 'Setup could not be completed.'));
        setErrorStage(result.stage || null);
        setSchemaError(result.schemaError ?? null);
        return;
      }

      await load();
      setNotice('saved');
      setWarning(typeof result.warning === 'string' ? result.warning : '');
    } catch {
      setError('Setup could not be completed. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  async function superLogin() {
    setBusy(true);
    setError('');
    try {
      const ok = await trySuperLogin();
      if (!ok) return;
      setError('');
      setNotice('signed-in');
      // Refresh the readiness/configured status now that the super-admin device
      // cookie is set, so the page knows the platform is unlocked.
      await load();
    } catch {
      setError('Sign-in failed. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.ready === true;
  const configured = status?.configured === true;
  const activeStorage = STORAGE_OPTIONS.find((o) => o.value === form.storage_provider) || STORAGE_OPTIONS[0];
  const activePayment = PAYMENT_OPTIONS.find((o) => o.value === form.payment_provider) || PAYMENT_OPTIONS[0];
  const activeEmail = EMAIL_OPTIONS.find((o) => o.value === form.mail_provider) || EMAIL_OPTIONS[0];
  const activeMap = MAP_OPTIONS.find((o) => o.value === form.map_provider) || MAP_OPTIONS[0];
  const activeAi = AI_OPTIONS.find((o) => o.value === form.ai_provider) || AI_OPTIONS[0];
  const activeAiSecondary = AI_SECONDARY_OPTIONS.find((o) => o.value === form.ai_provider_secondary) || AI_SECONDARY_OPTIONS[0];
  const errorContext = errorStage ? STAGE_CONTEXT[errorStage] : undefined;

  const scrollToTop = () => {
    if (typeof window === 'undefined') return;
    // Defer one tick so React has committed the new step's DOM before we scroll,
    // then scroll every possible container to the top (window, <html>, <body>) —
    // some browsers/embedders scroll a different element or ignore ScrollToOptions.
    window.setTimeout(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }, 0);
  };

  const emailValid = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  function validateStep(step: number): Record<string, string> {
    const errs: Record<string, string> = {};
    if (step === 1 && !configured) {
      const email = adminEmail.trim();
      if (!email) errs.adminEmail = 'Enter the master admin email address.';
      else if (!emailValid(email)) errs.adminEmail = 'Enter a valid email address.';
      if (!adminPassword) errs.adminPassword = 'Enter a password.';
      else if (adminPassword.length < 6 || adminPassword.length > 128) errs.adminPassword = 'Password must be 6–128 characters.';
    }
    if (step === 0) {
      for (const f of activeStorage.fields) {
        if (f.optional) continue;
        if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required.`;
      }
      if (form.storage_provider !== 'supabase') {
        for (const f of STORAGE_OPTIONS[0].fields) {
          if (f.optional) continue;
          if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required.`;
        }
      }
    }
    if (step === 2) {
      if (form.payment_provider !== 'none') {
        for (const f of activePayment.fields) {
          if (f.optional) continue;
          if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required (or choose "Skip payments for now").`;
        }
      }
      for (const f of activeEmail.fields) {
        if (f.optional) continue;
        if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required.`;
      }
      for (const f of activeMap.fields) {
        if (f.optional) continue;
        if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required (or choose a keyless maps provider).`;
      }
    }
    if (step === 4) {
      // AI is now MANDATORY — the primary provider always needs a key (the
      // keyless Workers AI binding is the only exception).
      if (form.ai_provider !== 'workers_ai') {
        for (const f of activeAi.fields) {
          if (f.optional) continue;
          if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required.`;
        }
      }
      // Secondary fallback is OPTIONAL — only validate its key when a real
      // (non-keyless) provider is actually selected.
      if (form.ai_provider_secondary !== 'none' && form.ai_provider_secondary !== 'workers_ai') {
        // DeepSeek Pro + Lite share one key — a DeepSeek secondary inherits the
        // primary DeepSeek key, so its own field can stay empty.
        const isDeepSeek = (p: string) => p === 'deepseek' || p === 'deepseek_lite';
        const reusesPrimaryKey = isDeepSeek(form.ai_provider_secondary) && isDeepSeek(form.ai_provider) && Boolean((form.ai_api_key || '').trim());
        if (!reusesPrimaryKey) {
          for (const f of activeAiSecondary.fields) {
            if (f.optional) continue;
            if (!(form[f.key] || '').trim()) errs[f.key] = `${f.label} is required (or set the fallback to "No fallback").`;
          }
        }
      }
    }
    return errs;
  }

  function validateAllSteps(): { firstStep: number; errors: Record<string, string> } {
    let firstStep = -1;
    let errors: Record<string, string> = {};
    for (let i = 0; i <= 4; i++) {
      const errs = validateStep(i);
      if (Object.keys(errs).length > 0) {
        if (firstStep === -1) firstStep = i;
        errors = { ...errors, ...errs };
      }
    }
    return { firstStep, errors };
  }

  function goToStep(i: number) {
    setStep(i);
    setErrors({});
    scrollToTop();
  }

  async function handleNext() {
    const errs = validateStep(step);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    // Data-store step — verify the connection + schema BEFORE advancing, so the
    // operator learns about a broken data store immediately instead of after
    // filling every other step and hitting the final save.
    if (step === 0) {
      setBusy(true);
      setError('');
      setErrorStage(null);
      setSchemaError(null);
      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            supabaseUrl: form.supabase_url,
            supabaseAnonKey: form.supabase_anon_key,
            supabaseServiceRoleKey: form.supabase_service_role_key,
            probe: 'storage',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; stage?: string; schemaError?: SchemaFixPlan };
        if (!res.ok || !data.ok) {
          setError(String(data.error || 'The data store connection failed.'));
          setErrorStage(data.stage || 'storage_init');
          setSchemaError(data.schemaError ?? null);
          return;
        }
      } catch {
        setError('The data store connection failed. Check your connection.');
        setErrorStage('storage_init');
        setSchemaError(null);
        return;
      } finally {
        setBusy(false);
      }
    }

    // Core-services step — verify the payment / email / maps keys against their
    // real APIs BEFORE advancing, so a wrong Stripe/Resend key is caught now.
    if (step === 2) {
      setBusy(true);
      setError('');
      setErrorStage(null);
      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            supabaseUrl: form.supabase_url,
            supabaseAnonKey: form.supabase_anon_key,
            supabaseServiceRoleKey: form.supabase_service_role_key,
            probe: 'core',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; stage?: string };
        if (!res.ok || !data.ok) {
          setError(String(data.error || 'The core services could not be verified.'));
          setErrorStage(data.stage || 'core_services');
          return;
        }
      } catch {
        setError('The core services could not be verified. Check your connection.');
        setErrorStage('core_services');
        return;
      } finally {
        setBusy(false);
      }
    }

    // AI step — verify the primary (and secondary) AI key against its real API.
    if (step === 4) {
      setBusy(true);
      setError('');
      setErrorStage(null);
      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            supabaseUrl: form.supabase_url,
            supabaseAnonKey: form.supabase_anon_key,
            supabaseServiceRoleKey: form.supabase_service_role_key,
            probe: 'ai',
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; stage?: string };
        if (!res.ok || !data.ok) {
          setError(String(data.error || 'The AI provider could not be verified.'));
          setErrorStage(data.stage || 'ai');
          return;
        }
      } catch {
        setError('The AI provider could not be verified. Check your connection.');
        setErrorStage('ai');
        return;
      } finally {
        setBusy(false);
      }
    }

    setStep(Math.min(4, step + 1));
    scrollToTop();
  }

  function handleBack() {
    setStep(Math.max(0, step - 1));
    setErrors({});
    scrollToTop();
  }

  const primaryBtn = { background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '14px 22px', fontSize: 15, fontWeight: 800, cursor: 'pointer' } as const;
  const ghostBtn = { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 999, padding: '14px 22px', fontSize: 15, fontWeight: 700, cursor: 'pointer' } as const;

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '40px 16px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gap: 18 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'inline-block', background: '#111', color: '#fff', borderRadius: 14, padding: '8px 18px', fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>
            SETUP WIZARD
          </div>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '16px 0 6px', color: '#111' }}>Configure your store</h1>
          <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>Five short steps — data store, admin account, core services, security and the AI engine.</p>
          <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 4, textAlign: 'left', marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#3730a3' }}>🔑 Credentials live as environment variables</div>
            <p style={{ fontSize: 12.5, color: '#3730a3', margin: 0, lineHeight: 1.5 }}>
              This wizard saves a copy of every key, but the durable source of truth is your hosting platform. If a field cannot be saved here, set it there instead — on Cloudflare: <code>{status?.cloudflareVarsPath || 'Workers & Pages → [Project] → Settings → Variables and Secrets'}</code> (or <code>npx wrangler secret put NAME</code>); on Vercel: Project → Settings → Environment Variables; locally: <code>.env.local</code> / <code>.dev.vars</code>.
            </p>
          </div>
        </div>

        {ready && !reconfigure ? (
          <div style={{ background: '#fff', borderRadius: 16, padding: '24px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)', textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>Store is configured ✓</h2>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '8px 0 20px' }}>The admin portal is ready. Open it to seed products, tune the theme and go live.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => window.location.assign('/admin')} style={primaryBtn}>Open admin portal →</button>
              <button type="button" onClick={() => window.location.assign('/admin/setup?reconfigure=1')} style={ghostBtn}>Reconfigure providers</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 18 }}>
            {(configured || reconfigure) && (
              <Section title="Reconfigure — sign in as admin" subtitle="This platform is already configured. Sign in with the master account to update providers without the env Basic-Auth password.">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Admin email"><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" style={inputStyle} /></Field>
                  <Field label="Admin password"><SecretInput value={adminPassword} onChange={setAdminPassword} autoComplete="current-password" /></Field>
                </div>
                <button type="button" onClick={superLogin} disabled={busy} style={{ ...primaryBtn, padding: '12px 18px', fontSize: 14, justifySelf: 'start', opacity: busy ? 0.6 : 1 }}>{busy ? 'Signing in…' : 'Sign in'}</button>
              </Section>
            )}

            <Stepper step={step} onStep={goToStep} />

            {notice === 'saved' && (
              <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ color: '#047857', fontSize: 14, fontWeight: 700 }}>✓ Saved — configuration updated.</span>
                <button type="button" onClick={() => window.location.assign('/admin')} style={{ ...primaryBtn, padding: '10px 16px', fontSize: 13 }}>Open admin portal →</button>
              </div>
            )}
            {notice === 'signed-in' && (
              <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 12, padding: '12px 16px' }}>
                <span style={{ color: '#047857', fontSize: 14, fontWeight: 700 }}>✓ Signed in — you can now update the providers below.</span>
              </div>
            )}

            {warning && (
              <div style={{ background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 12, padding: '14px 16px', display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#9a3412' }}>⚠ Credentials not persisted</div>
                <p style={{ fontSize: 13, color: '#9a3412', margin: 0, lineHeight: 1.5 }}>{warning}</p>
              </div>
            )}

            {status?.supabaseSchemaError && (
              <SchemaFixCard plan={buildSchemaFixPlan(status.supabaseSchemaError)} tone="yellow" />
            )}

            {step === 1 && (
              <Section title="2 · Master admin account" subtitle="Creates the master admin account (Supabase Auth) that unlocks /admin.">
                {!configured ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Field label="Email" hint="Where the master sign-in + two-step code are sent." error={errors.adminEmail}>
                        <input type="email" required value={adminEmail} onChange={(e) => { setAdminEmail(e.target.value); clearError('adminEmail'); }} placeholder="you@example.com" autoComplete="email" aria-invalid={errors.adminEmail ? true : undefined} style={errors.adminEmail ? invalidInputStyle : inputStyle} />
                      </Field>
                      <Field label="Password" hint="6–128 characters. Store it in a password manager." error={errors.adminPassword}>
                        <SecretInput value={adminPassword} onChange={(v) => { setAdminPassword(v); clearError('adminPassword'); }} autoComplete="new-password" required invalid={Boolean(errors.adminPassword)} />
                      </Field>
                    </div>
                    <p style={noteStyle}>This account signs into <code>/admin</code> and can update providers later — it is separate from the storefront customer accounts.</p>
                  </>
                ) : (
                  <p style={noteStyle}>A master admin account already exists. Use the “Sign in as admin” panel above to unlock editing, then continue through the steps.</p>
                )}
              </Section>
            )}

            {step === 0 && (
              <Section title="1 · Primary data store" subtitle="Set up the data store first — products, carts, entries and configuration live here, and the master admin account is created on it. Enter only the chosen backend's keys.">
                <StoragePicker value={form.storage_provider} options={STORAGE_OPTIONS} onChange={(v) => set('storage_provider', v)} />
                <ProviderFields fields={activeStorage.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                {form.storage_provider !== 'supabase' && (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#075985' }}>Supabase credentials (still required)</div>
                    <p style={{ fontSize: 12, color: '#075985', margin: 0, lineHeight: 1.5 }}>
                      Your master admin account and provider settings live in Supabase, so Supabase credentials are required even when the storefront data lives in {activeStorage.label}. Enter them here.
                    </p>
                    <ProviderFields fields={STORAGE_OPTIONS[0].fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                  </div>
                )}
              </Section>
            )}

            {step === 2 && (
              <Section title="3 · Essential core services" subtitle="Payments, webhooks, transactional email and address autofill. Each provider shows only its own fields.">
                <div style={{ display: 'grid', gap: 14 }}>
                  <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Payments & webhooks</div>
                    <ProviderSelect label="Payment provider" value={form.payment_provider} options={PAYMENT_OPTIONS} onChange={(v) => set('payment_provider', v)} />
                    <ProviderFields fields={activePayment.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                  </div>

                  <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Transactional email</div>
                    <ProviderSelect label="Email provider" value={form.mail_provider} options={EMAIL_OPTIONS} onChange={(v) => set('mail_provider', v)} />
                    <ProviderFields fields={activeEmail.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                  </div>

                  <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Address autofill (maps)</div>
                    <ProviderSelect label="Maps provider" value={form.map_provider} options={MAP_OPTIONS} onChange={(v) => set('map_provider', v)} />
                    <ProviderFields fields={activeMap.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                  </div>
                </div>
              </Section>
            )}

            {step === 3 && (
              <Section title="4 · System security & site identity" subtitle="Admin portal protection, the cron safety net, and how your store names itself.">
                <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Security</div>
                  <ProviderFields fields={SECURITY_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                </div>
                <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Site identity</div>
                  <ProviderFields fields={IDENTITY_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                </div>
              </Section>
            )}

            {step === 4 && (
              <Section title="5 · AI engine" subtitle="Powers image-to-animation + dynamic SVG asset generation. The primary provider is required; the secondary fallback is optional.">
                <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Primary AI provider (required)</div>
                  <ProviderSelect label="Primary provider" value={form.ai_provider} options={AI_OPTIONS} onChange={(v) => set('ai_provider', v)} />
                  <ProviderFields fields={activeAi.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                </div>
                <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Secondary AI provider (optional fallback)</div>
                  <p style={noteStyle}>Only fill this in if you want a backup provider that takes over when the primary fails. Leave it as “No fallback” to use a single provider — DeepSeek Pro and DeepSeek Lite share the same key.</p>
                  <ProviderSelect label="Fallback provider" value={form.ai_provider_secondary} options={AI_SECONDARY_OPTIONS} onChange={(v) => set('ai_provider_secondary', v)} />
                  <ProviderFields fields={activeAiSecondary.fields} values={form} onChange={set} copied={copied} onCopy={copy} errors={errors} />
                </div>
              </Section>
            )}

            {schemaError ? (
              <SchemaFixCard plan={schemaError} />
            ) : (
              error && (
                <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 16px', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: '#b91c1c', fontSize: 15, fontWeight: 800 }}>{errorContext ? errorContext.title : 'Setup failed'}</span>
                    {errorContext && (
                      <button
                        type="button"
                        onClick={() => { setStep(errorContext.step); setError(''); setErrorStage(null); setSchemaError(null); }}
                        style={{ marginLeft: 'auto', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 999, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                      >
                        Go to step {errorContext.step + 1}
                      </button>
                    )}
                  </div>
                  {errorContext && <p style={{ color: '#7f1d1d', fontSize: 13, margin: 0, lineHeight: 1.5 }}>{errorContext.message}</p>}
                  <p style={{ color: '#b91c1c', fontSize: 13, margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-word', whiteSpace: 'pre-line', lineHeight: 1.6 }}>{error}</p>
                </div>
              )
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <button type="button" onClick={handleBack} disabled={step === 0 || busy} style={{ ...ghostBtn, opacity: step === 0 || busy ? 0.5 : 1, cursor: step === 0 || busy ? 'default' : 'pointer' }}>
                ← Back
              </button>
              {step < 4 ? (
                <button type="button" onClick={handleNext} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
                  {busy && step === 0 ? 'Verifying data store…' : 'Continue →'}
                </button>
              ) : (
                <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
                  {busy ? 'Saving…' : 'Save configuration & create admin'}
                </button>
              )}
            </div>

            <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', margin: 0 }}>
              Saved into <code>global_platform_settings</code> (providers + operational settings). The admin portal unlocks after this step.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}










