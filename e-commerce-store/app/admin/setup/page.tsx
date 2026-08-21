'use client';

/**
 * /admin/setup — the unified single-page Setup Dashboard.
 *
 * Merges the old /admin/setup wizard and /admin/setup-status checklist into
 * one page: an "Environment Health & Scan" banner that auto-refreshes on save,
 * per-category status badges, a complete data-store matrix (Supabase / Upstash
 * Redis / Cloudflare KV-D1) with simultaneous primary + fallback entry, and
 * every operational field (security, site identity, Stripe, the AI suite).
 * Cloudflare build-time/runtime commands are copyable inline.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';

type ProviderOption<T extends string> = { value: T; label: string; hint: string };

const inputStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;

const EMAIL_PROVIDERS: ProviderOption<'resend' | 'postmark' | 'sendgrid'>[] = [
  { value: 'resend', label: 'Resend', hint: 'Developer-friendly — onboarding@resend.dev sandbox works immediately.' },
  { value: 'postmark', label: 'Postmark', hint: 'Fast transactional delivery. Requires a verified sender address.' },
  { value: 'sendgrid', label: 'SendGrid', hint: 'Twilio SendGrid v3 mail API. Requires a verified sender address.' },
];

const PAYMENT_PROVIDERS: ProviderOption<'stripe' | 'lemon_squeezy' | 'paddle'>[] = [
  { value: 'stripe', label: 'Stripe', hint: 'Full support — raffle card-save + instant-buy + webhooks.' },
  { value: 'lemon_squeezy', label: 'Lemon Squeezy', hint: 'Merchant-of-record. Instant-buy only (no raffle card-save).' },
  { value: 'paddle', label: 'Paddle', hint: 'Paddle Billing custom checkout. Instant-buy only (no raffle card-save).' },
];

const MAP_PROVIDERS: ProviderOption<'mapbox' | 'google_maps' | 'open_street_map'>[] = [
  { value: 'mapbox', label: 'Mapbox', hint: 'Address autofill via Mapbox search-js — the storefront default.' },
  { value: 'google_maps', label: 'Google Maps', hint: 'Places API address autofill.' },
  { value: 'open_street_map', label: 'OpenStreetMap', hint: 'Free + keyless (Nominatim). Rate limited — fine for testing.' },
];

const AI_PROVIDERS: ProviderOption<'deepseek' | 'openai' | 'anthropic' | 'replicate' | 'workers_ai'>[] = [
  { value: 'deepseek', label: 'DeepSeek Pro', hint: 'OpenAI-compatible — best price/quality for image-to-animation prompts.' },
  { value: 'openai', label: 'OpenAI', hint: 'GPT-4o-mini chat completions.' },
  { value: 'anthropic', label: 'Anthropic', hint: 'Claude Messages API.' },
  { value: 'replicate', label: 'Replicate', hint: 'Hosted Llama etc. (async predictions).' },
  { value: 'workers_ai', label: 'Workers AI', hint: 'Native Cloudflare binding — no key required.' },
];

const STORAGE_DRIVERS: { value: string; label: string; hint: string }[] = [
  { value: 'supabase', label: 'Supabase (default)', hint: 'Postgres + Auth + RLS. Also stores global_platform_settings + the super-admin.' },
  { value: 'upstash', label: 'Upstash Redis', hint: 'REST Redis — the battle-tested engine for concurrent raffle/payment writes.' },
  { value: 'cloudflare-kv', label: 'Cloudflare KV / D1', hint: 'Zero third-party store via native bindings. Concurrency caveats apply.' },
];

type OpField = { key: string; label: string; hint?: string; secret?: boolean; command?: string };

const SECURITY_FIELDS: OpField[] = [
  { key: 'admin_basic_auth_username', label: 'Admin username', hint: 'Defaults to "admin".', command: 'npx wrangler secret put ADMIN_BASIC_AUTH_USERNAME' },
  { key: 'admin_basic_auth_password', label: 'Admin password', secret: true, command: 'npx wrangler secret put ADMIN_BASIC_AUTH_PASSWORD' },
  { key: 'admin_verify_email', label: 'Admin verification email', hint: 'Inbox for the 2-step sign-in code.', command: 'npx wrangler secret put ADMIN_VERIFY_EMAIL' },
  { key: 'cron_secret', label: 'Cron secret', secret: true, hint: 'Authenticates the scheduled draw safety net.', command: 'npx wrangler secret put CRON_SECRET' },
];

const SITE_FIELDS: OpField[] = [
  { key: 'site_url', label: 'Site URL', hint: 'NEXT_PUBLIC_URL — build-time on Cloudflare.', command: 'npx wrangler secret put NEXT_PUBLIC_URL' },
  { key: 'brand_name', label: 'Brand name', hint: 'BRAND_NAME — shown in emails.', command: 'npx wrangler secret put BRAND_NAME' },
  { key: 'support_email', label: 'Support email', hint: 'SUPPORT_EMAIL — support inbox.', command: 'npx wrangler secret put SUPPORT_EMAIL' },
];

const STRIPE_FIELDS: OpField[] = [
  { key: 'stripe_secret_key', label: 'Stripe secret key', secret: true, command: 'npx wrangler secret put STRIPE_SECRET_KEY' },
  { key: 'stripe_webhook_secret', label: 'Stripe webhook secret', secret: true, command: 'npx wrangler secret put STRIPE_WEBHOOK_SECRET' },
  { key: 'stripe_product_id', label: 'Stripe product/price ID', hint: 'Global default price ID.', command: 'npx wrangler secret put STRIPE_PRODUCT_ID' },
];

const AI_KEY_FIELDS: OpField[] = [
  { key: 'deepseek_api_key', label: 'DeepSeek API key', secret: true, command: 'npx wrangler secret put DEEPSEEK_API_KEY' },
  { key: 'openai_api_key', label: 'OpenAI API key', secret: true, command: 'npx wrangler secret put OPENAI_API_KEY' },
  { key: 'anthropic_api_key', label: 'Anthropic API key', secret: true, command: 'npx wrangler secret put ANTHROPIC_API_KEY' },
  { key: 'replicate_api_token', label: 'Replicate API token', secret: true, command: 'npx wrangler secret put REPLICATE_API_TOKEN' },
  { key: 'workers_ai_account_id', label: 'Cloudflare account ID', hint: 'For the Workers AI binding.', command: 'npx wrangler secret put CLOUDFLARE_ACCOUNT_ID' },
  { key: 'workers_ai_api_token', label: 'Cloudflare API token', secret: true, hint: 'For the Workers AI binding.', command: 'npx wrangler secret put CLOUDFLARE_API_TOKEN' },
];

type Check = { present: boolean; required: boolean; blocking: boolean };
type DiscoveryGroup = { title: string; kind: string; checks: Check[] };
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
  discovery: { groups: DiscoveryGroup[]; summary: { present: number; total: number; blockingMissing: string[]; requiredMissing: string[] } };
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
  storage_provider: 'supabase',
  supabase_url: '',
  supabase_anon_key: '',
  supabase_service_role_key: '',
  upstash_redis_rest_url: '',
  upstash_redis_rest_token: '',
  cloudflare_kv_binding: '',
  cloudflare_d1_binding: '',
  admin_basic_auth_username: '',
  admin_basic_auth_password: '',
  admin_verify_email: '',
  cron_secret: '',
  site_url: '',
  brand_name: '',
  support_email: '',
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  stripe_product_id: '',
  deepseek_api_key: '',
  openai_api_key: '',
  anthropic_api_key: '',
  replicate_api_token: '',
  workers_ai_account_id: '',
  workers_ai_api_token: '',
};

function envKind(discovery: Status['discovery'] | undefined, kind: string): { present: boolean; required: boolean } {
  const group = discovery?.groups.find((g) => g.kind === kind);
  return {
    present: Boolean(group?.checks.some((c) => c.present)),
    required: Boolean(group?.checks.some((c) => c.required || c.blocking)),
  };
}

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [form, setForm] = useState<Record<string, string>>(DEFAULT_FORM);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [reconfigure, setReconfigure] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('reconfigure=1')) {
      setReconfigure(true);
    }
  }, []);

  const load = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError('');
    try {
      const res = await fetch('/api/admin/setup', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as Partial<Status>;
      if (!res.ok || !data.discovery) {
        setStatusError('Could not load the setup status. Check the server logs.');
        return;
      }
      setStatus(data as Status);
    } catch {
      setStatusError('Could not reach the setup endpoint. Check your connection.');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        ...form,
        adminEmail,
        adminPassword,
        supabaseUrl: form.supabase_url,
        supabaseAnonKey: form.supabase_anon_key,
        supabaseServiceRoleKey: form.supabase_service_role_key,
      };
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; redirect?: string };
      if (!res.ok || !data.ok) {
        setError(String(data.error || 'Setup could not be completed.'));
        return;
      }
      await load();
      window.location.assign(data.redirect || '/admin');
    } catch {
      setError('Setup could not be completed. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.ready === true;
  const configured = status?.configured === true;

  const badges = [
    { label: 'Store', present: status?.storageOk === true, required: true },
    { label: 'Auth', present: Boolean(status?.legacyAdminOk || status?.platformConfigured), required: true },
    { label: 'Payments', present: Boolean(status?.platformProviders?.payment_provider) || envKind(status?.discovery, 'payment').present, required: envKind(status?.discovery, 'payment').required },
    { label: 'Email', present: Boolean(status?.platformProviders?.mail_provider) || envKind(status?.discovery, 'email').present, required: envKind(status?.discovery, 'email').required },
    { label: 'Maps', present: Boolean(status?.platformProviders?.map_provider) || envKind(status?.discovery, 'maps').present, required: envKind(status?.discovery, 'maps').required },
    { label: 'AI', present: Boolean(status?.platformProviders?.ai_provider) || envKind(status?.discovery, 'ai').present, required: false },
    { label: 'Security', present: Boolean(status?.legacyAdminOk) || envKind(status?.discovery, 'security').present, required: false },
  ];

  async function superLogin() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/super-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(String(data.error || 'Super-admin sign-in failed.'));
        return;
      }
      setError('Signed in ✓ — you can now update providers.');
    } catch {
      setError('Sign-in failed. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '40px 16px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gap: 18 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'inline-block', background: '#111', color: '#fff', borderRadius: 14, padding: '8px 18px', fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>
            SETUP DASHBOARD
          </div>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '16px 0 6px', color: '#111' }}>Configure your store</h1>
          <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>One dashboard — data store, providers, security, payments and AI.</p>
        </div>

        <HealthBanner status={status} loading={loadingStatus} error={statusError} onRefresh={load} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {badges.map((b) => <Badge key={b.label} label={b.label} present={b.present} required={b.required} />)}
        </div>

        {ready && !reconfigure ? (
          <div style={{ background: '#fff', borderRadius: 16, padding: '24px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)', textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>Store is configured ✓</h2>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '8px 0 20px' }}>The admin portal is ready. Open it to seed products, tune the theme and go live.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => window.location.assign('/admin')} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '14px 22px', fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>Open admin portal →</button>
              <Link href="/admin/setup?reconfigure=1" style={{ color: '#374151', fontSize: 14, textDecoration: 'underline', alignSelf: 'center' }}>Reconfigure providers</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 18 }}>
            {configured && (
              <Section title="Reconfigure — sign in as super-admin" subtitle="This platform is already configured. Sign in with the master account to update providers without the env password.">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Super-admin email"><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} /></Field>
                  <Field label="Super-admin password"><input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} style={inputStyle} /></Field>
                </div>
                <button type="button" onClick={superLogin} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '12px 18px', fontSize: 14, fontWeight: 800, cursor: 'pointer', justifySelf: 'start' }}>Sign in</button>
              </Section>
            )}

            <Section title="1 · Super-admin account" subtitle="Creates the master Supabase Auth account flagged is_super_admin.">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Email"><input type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" style={inputStyle} /></Field>
                <Field label="Password (6–128 chars)"><input type="password" required value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="new-password" style={inputStyle} /></Field>
              </div>
            </Section>

            <Section title="2 · Data store (primary + fallback)" subtitle="Pick your PRIMARY driver, then enter credentials for as many drivers as you use — primary + fallback are saved together.">
              <div style={{ display: 'grid', gap: 8 }}>
                {STORAGE_DRIVERS.map((d) => (
                  <label key={d.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 12, border: form.storage_provider === d.value ? '2px solid #111' : '1px solid #d1d5db', cursor: 'pointer' }}>
                    <input type="radio" name="storage_provider" checked={form.storage_provider === d.value} onChange={() => set('storage_provider', d.value)} style={{ marginTop: 2 }} />
                    <div style={{ display: 'grid', gap: 2 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{d.label}</span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{d.hint}</span>
                    </div>
                  </label>
                ))}
              </div>

              <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Supabase</div>
                <Field label="Project URL"><input type="text" value={form.supabase_url} onChange={(e) => set('supabase_url', e.target.value)} placeholder="https://your-project.supabase.co" style={inputStyle} /></Field>
                <Field label="Anon key"><input type="password" value={form.supabase_anon_key} onChange={(e) => set('supabase_anon_key', e.target.value)} style={inputStyle} /></Field>
                <Field label="Service role key"><input type="password" value={form.supabase_service_role_key} onChange={(e) => set('supabase_service_role_key', e.target.value)} style={inputStyle} /></Field>
                <CopyCommand text="npx wrangler secret put SUPABASE_URL" copied={copied} onCopy={copy} />
              </div>

              <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Upstash Redis</div>
                <Field label="REST URL"><input type="text" value={form.upstash_redis_rest_url} onChange={(e) => set('upstash_redis_rest_url', e.target.value)} placeholder="https://….upstash.io" style={inputStyle} /></Field>
                <Field label="REST token"><input type="password" value={form.upstash_redis_rest_token} onChange={(e) => set('upstash_redis_rest_token', e.target.value)} style={inputStyle} /></Field>
                <CopyCommand text="npx wrangler secret put UPSTASH_REDIS_REST_URL" copied={copied} onCopy={copy} />
              </div>

              <div style={{ background: '#f9fafb', borderRadius: 12, padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#111' }}>Cloudflare KV / D1</div>
                <Field label="KV binding name"><input type="text" value={form.cloudflare_kv_binding} onChange={(e) => set('cloudflare_kv_binding', e.target.value)} placeholder="SITE_CACHE" style={inputStyle} /></Field>
                <Field label="D1 binding name"><input type="text" value={form.cloudflare_d1_binding} onChange={(e) => set('cloudflare_d1_binding', e.target.value)} placeholder="DB" style={inputStyle} /></Field>
                <CopyCommand text="npx wrangler secret put STORAGE_PROVIDER" copied={copied} onCopy={copy} />
                <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>Set STORAGE_PROVIDER=cloudflare-kv and define your bindings in wrangler.toml (see below).</p>
              </div>
            </Section>

            <Section title="3 · Email provider" subtitle="Transactional + verification emails.">
              <ProviderSelect label="Provider" value={form.mail_provider as 'resend' | 'postmark' | 'sendgrid'} options={EMAIL_PROVIDERS} onChange={(v) => set('mail_provider', v)} />
              <Field label="API key"><input type="password" required value={form.mail_api_key} onChange={(e) => set('mail_api_key', e.target.value)} placeholder="re_…" style={inputStyle} /></Field>
            </Section>

            <Section title="4 · Payment provider" subtitle="Charges cards and runs raffles.">
              <ProviderSelect label="Provider" value={form.payment_provider as 'stripe' | 'lemon_squeezy' | 'paddle'} options={PAYMENT_PROVIDERS} onChange={(v) => set('payment_provider', v)} />
              <Field label="API key"><input type="password" required value={form.payment_api_key} onChange={(e) => set('payment_api_key', e.target.value)} placeholder={form.payment_provider === 'stripe' ? 'sk_live_…' : 'API key'} style={inputStyle} /></Field>
              {form.payment_provider === 'stripe' && <Field label="Webhook secret"><input type="password" value={form.payment_webhook_secret} onChange={(e) => set('payment_webhook_secret', e.target.value)} placeholder="whsec_…" style={inputStyle} /></Field>}
            </Section>

            <Section title="5 · Maps provider" subtitle="Address autofill at checkout.">
              <ProviderSelect label="Provider" value={form.map_provider as 'mapbox' | 'google_maps' | 'open_street_map'} options={MAP_PROVIDERS} onChange={(v) => set('map_provider', v)} />
              {form.map_provider !== 'open_street_map' && <Field label="API key"><input type="password" required value={form.map_api_key} onChange={(e) => set('map_api_key', e.target.value)} placeholder={form.map_provider === 'mapbox' ? 'pk.…' : 'API key'} style={inputStyle} /></Field>}
              {form.map_provider === 'open_street_map' && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>OpenStreetMap needs no key.</p>}
            </Section>

            <Section title="6 · AI provider" subtitle="Universal AI engine — image-to-animation + dynamic SVG asset generation.">
              <ProviderSelect label="Provider" value={form.ai_provider as 'deepseek' | 'openai' | 'anthropic' | 'replicate' | 'workers_ai'} options={AI_PROVIDERS} onChange={(v) => set('ai_provider', v)} />
              {form.ai_provider !== 'workers_ai' && <Field label="API key"><input type="password" required value={form.ai_api_key} onChange={(e) => set('ai_api_key', e.target.value)} placeholder={form.ai_provider === 'deepseek' ? 'sk-…' : form.ai_provider === 'anthropic' ? 'sk-ant-…' : 'API key'} style={inputStyle} /></Field>}
              {form.ai_provider === 'workers_ai' && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Workers AI uses the native Cloudflare binding — no key required.</p>}
            </Section>

            <Section title="7 · Security & auth" subtitle="Admin portal protection, two-step verification and the cron safety net.">
              <OpFields fields={SECURITY_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} />
            </Section>

            <Section title="8 · Site identity" subtitle="Canonical URL, brand name and support inbox.">
              <OpFields fields={SITE_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} />
            </Section>

            <Section title="9 · Payments engine (Stripe)" subtitle="Runtime keys used by the checkout + webhook routes.">
              <OpFields fields={STRIPE_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} />
            </Section>

            <Section title="10 · AI suite keys" subtitle="Optional keys for every supported AI provider (the engine resolves per-provider).">
              <OpFields fields={AI_KEY_FIELDS} values={form} onChange={set} copied={copied} onCopy={copy} />
            </Section>

            <Section title="Cloudflare Workers / Pages setup" subtitle="Build-time vs runtime variables — copy the exact commands or follow the dashboard path.">
              <div style={{ background: '#0f172a', color: '#cbd5e1', borderRadius: 12, padding: '14px 16px', fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ fontWeight: 800, color: '#fff', marginBottom: 6 }}>Runtime secrets (after `wrangler deploy`)</div>
                <code style={{ color: '#a5f3fc' }}>npx wrangler secret put VAR_NAME</code>
                <div style={{ marginTop: 10, fontWeight: 800, color: '#fff' }}>Build-time variables (set in the shell BEFORE building)</div>
                <code style={{ color: '#a5f3fc' }}>export NEXT_PUBLIC_URL=https://yourdomain.com</code>
                <div style={{ marginTop: 10, fontWeight: 800, color: '#fff' }}>Dashboard path</div>
                <div>{status?.cloudflareVarsPath || 'Workers & Pages → [Project] → Settings → Variables and Secrets → Production'}</div>
              </div>
            </Section>

            {error && (
              <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 16px', color: '#b91c1c', fontSize: 14 }}>{error}</div>
            )}

            <button type="submit" disabled={busy} style={{ background: busy ? '#9ca3af' : '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '16px 24px', fontSize: 16, fontWeight: 800, cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'Saving…' : 'Save configuration & create admin'}
            </button>

            <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', margin: 0 }}>
              Saved into <code>global_platform_settings</code> (provider + operational settings). The admin portal unlocks after this step.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

function Section(props: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section style={{ background: '#fff', borderRadius: 16, padding: '20px 22px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)' }}>
      <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: '#111' }}>{props.title}</h2>
      {props.subtitle && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 16px', lineHeight: 1.5 }}>{props.subtitle}</p>}
      <div style={{ display: 'grid', gap: 14 }}>{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{props.label}</span>
      {props.children}
      {props.hint && <span style={{ fontSize: 12, color: '#9ca3af' }}>{props.hint}</span>}
    </label>
  );
}

function OpFields(props: { fields: OpField[]; values: Record<string, string>; onChange: (k: string, v: string) => void; copied: string; onCopy: (t: string) => void }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {props.fields.map((f) => (
        <div key={f.key} style={{ display: 'grid', gap: 6 }}>
          <Field label={f.label} hint={f.hint}>
            <input type={f.secret ? 'password' : 'text'} value={props.values[f.key] || ''} onChange={(e) => props.onChange(f.key, e.target.value)} autoComplete="off" style={inputStyle} />
          </Field>
          {f.command && <CopyCommand text={f.command} copied={props.copied} onCopy={props.onCopy} />}
        </div>
      ))}
    </div>
  );
}

function ProviderSelect<T extends string>(props: { label: string; value: T; options: ProviderOption<T>[]; onChange: (v: T) => void }) {
  const active = props.options.find((o) => o.value === props.value);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)} style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15 }}>
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {active && <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{active.hint}</p>}
    </div>
  );
}

function Badge(props: { label: string; present: boolean; required: boolean }) {
  const tone = props.present ? 'ok' : props.required ? 'need' : 'opt';
  const bg = tone === 'ok' ? '#ecfdf5' : tone === 'need' ? '#fef2f2' : '#fffbeb';
  const color = tone === 'ok' ? '#047857' : tone === 'need' ? '#b91c1c' : '#92400e';
  const glyph = tone === 'ok' ? '✅ Configured' : tone === 'need' ? '❌ Action Needed' : '⚠️ Optional';
  return <span style={{ background: bg, color, borderRadius: 999, padding: '6px 12px', fontSize: 12, fontWeight: 700 }}>{props.label} · {glyph}</span>;
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

function HealthBanner(props: { status: Status | null; loading: boolean; error: string; onRefresh: () => void }) {
  const ready = props.status?.ready === true;
  const present = props.status?.discovery.summary.present ?? 0;
  const total = props.status?.discovery.summary.total ?? 0;
  const blocking = props.status?.discovery.summary.blockingMissing ?? [];
  return (
    <div style={{ background: ready ? '#ecfdf5' : '#fff', border: `1px solid ${ready ? '#a7f3d0' : '#e5e7eb'}`, borderRadius: 16, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: '#111' }}>Environment Health & Scan</h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            {props.loading ? 'Scanning…' : ready ? '✅ Ready — all blocking requirements met.' : `❌ ${blocking.length} blocking item(s) remaining`}
            {props.status ? ` · ${present}/${total} variables detected` : ''}
          </p>
        </div>
        <button type="button" onClick={props.onRefresh} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>↻ Re-scan</button>
      </div>
      {props.error && <p style={{ color: '#b91c1c', fontSize: 13, margin: '10px 0 0' }}>{props.error}</p>}
      {props.status && blocking.length > 0 && (
        <p style={{ fontSize: 12, color: '#6b7280', margin: '10px 0 0' }}>Missing: {blocking.join(' · ')}. Fill the fields below (or set the platform env vars) and save to unlock.</p>
      )}
    </div>
  );
}
