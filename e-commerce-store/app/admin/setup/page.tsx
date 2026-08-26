'use client';

/**
 * /admin/setup — the production Setup Wizard, kept deliberately minimal.
 *
 * The store boots from TWO required inputs:
 *   1. A Supabase connection (project URL + anon key + service-role key).
 *   2. A master admin account (email + password).
 *
 * Payments, transactional email, maps and the AI engine are all OPTIONAL and
 * tucked into one collapsed section — the storefront runs without them (no
 * checkout / no emails / no autofill / CSS fallback animations) and each can be
 * added later in the admin portal. This is the "less is more" setup: one page,
 * two cards, one button.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

// ── shared styles ─────────────────────────────────────────────────────────────
const inputStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const selectStyle = { padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const labelStyle = { fontSize: 13, fontWeight: 700, color: '#374151' } as const;
const hintStyle = { fontSize: 12.5, color: '#6b7280', margin: 0, lineHeight: 1.55 } as const;

// ── types ─────────────────────────────────────────────────────────────────────
type MissingCred = { variable: string; command: string; example: string };
type DataStoreStatus = { key: string; label: string; configured: boolean; missing: MissingCred[] };
type Status = {
  configured?: boolean;
  isProduction?: boolean;
  supabaseEnvReady?: boolean;
  dataStores?: DataStoreStatus[];
};

// ── provider options (each defaults to "Skip for now") ────────────────────────
const MAIL_OPTIONS = [
  { value: '', label: 'Skip for now' },
  { value: 'resend', label: 'Resend' },
  { value: 'postmark', label: 'Postmark' },
  { value: 'sendgrid', label: 'SendGrid' },
];
const PAYMENT_OPTIONS = [
  { value: '', label: 'Skip for now' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'lemon_squeezy', label: 'Lemon Squeezy' },
  { value: 'paddle', label: 'Paddle' },
];
const MAP_OPTIONS = [
  { value: '', label: 'Skip for now' },
  { value: 'mapbox', label: 'Mapbox' },
  { value: 'google_maps', label: 'Google Maps' },
  { value: 'open_street_map', label: 'OpenStreetMap (no key)' },
];
const AI_OPTIONS = [
  { value: '', label: 'Skip for now' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'replicate', label: 'Replicate' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'google_gemini', label: 'Google Gemini' },
  { value: 'workers_ai', label: 'Cloudflare Workers AI (no key)' },
];

const DEFAULT_FORM: Record<string, string> = {
  supabase_url: '',
  supabase_anon_key: '',
  supabase_service_role_key: '',
  mail_provider: '',
  mail_api_key: '',
  payment_provider: '',
  payment_api_key: '',
  payment_webhook_secret: '',
  map_provider: '',
  map_api_key: '',
  ai_provider: '',
  ai_api_key: '',
  ai_provider_secondary: '',
  ai_api_key_secondary: '',
};

const needsKey = (provider: string): boolean => provider !== '' && provider !== 'none';

// ── tiny presentational components ────────────────────────────────────────────
function Card(props: { children: ReactNode }) {
  return (
    <section style={{ background: '#fff', borderRadius: 16, padding: '24px 26px', boxShadow: '0 6px 24px rgba(0,0,0,0.05)', display: 'grid', gap: 16 }}>
      {props.children}
    </section>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={labelStyle}>{props.label}</span>
      {props.children}
      {props.hint ? <p style={hintStyle}>{props.hint}</p> : null}
    </label>
  );
}

function TextInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} autoComplete="off" style={inputStyle} />
  );
}

function SecretInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        type={show ? 'text' : 'password'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete="off"
        style={{ ...inputStyle, paddingRight: 60 }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, fontSize: 12, fontWeight: 700, color: '#6b7280' }}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

function Select(props: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={selectStyle}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── the page ──────────────────────────────────────────────────────────────────
export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState<Record<string, string>>(DEFAULT_FORM);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [notice, setNotice] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/setup', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as Partial<Status>;
      setStatus(data as Status);
    } catch {
      /* status fetch failed — the form still works without the readiness gate */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configured = status?.configured === true;
  const inProduction = status?.isProduction === true;
  const supabaseEnvReady = status?.supabaseEnvReady === true;
  const supabaseStore = status?.dataStores?.find((d) => d.key === 'supabase');
  const missingSupabase = supabaseStore?.missing ?? [];

  function set(key: string, value: string) {
    setNotice('');
    setError('');
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

  async function saveToServer(): Promise<{ status: number; ok: boolean; error?: string; warning?: string }> {
    const res = await fetch('/api/admin/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        supabaseUrl: form.supabase_url,
        supabaseAnonKey: form.supabase_anon_key,
        supabaseServiceRoleKey: form.supabase_service_role_key,
        adminEmail,
        adminPassword,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string };
    return { status: res.status, ok: Boolean(data.ok), error: data.error, warning: data.warning };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setWarning('');
    setNotice('');

    const needsSupabase = !configured || !supabaseEnvReady;
    if (needsSupabase && (!form.supabase_url.trim() || !form.supabase_anon_key.trim() || !form.supabase_service_role_key.trim())) {
      setError('Enter your Supabase project URL, anon key and service-role key.');
      return;
    }
    if (!configured) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())) {
        setError('Enter a valid admin email address.');
        return;
      }
      if (adminPassword.length < 6 || adminPassword.length > 128) {
        setError('Admin password must be 6-128 characters.');
        return;
      }
    }

    setBusy(true);
    try {
      let result = await saveToServer();

      if ((result.status === 401 || result.status === 403) && adminEmail && adminPassword) {
        if (await trySuperLogin()) {
          result = await saveToServer();
        } else {
          return;
        }
      }

      if (!result.ok) {
        setError(String(result.error || 'Setup could not be completed.'));
        return;
      }

      setWarning(typeof result.warning === 'string' ? result.warning : '');
      setNotice('saved');
      await load();
    } catch {
      setError('Setup could not be completed. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '48px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 20 }}>
        <header style={{ textAlign: 'center', display: 'grid', gap: 8 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: '#111' }}>Set up your store</h1>
          <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>Two things to get started. Everything else can wait.</p>
          {configured && (
            <p style={{ color: '#92400e', fontSize: 13, margin: 0, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px' }}>
              This store is already set up. Enter your admin email and password to update it.
            </p>
          )}
        </header>

        {inProduction && !supabaseEnvReady && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 14, padding: '16px 18px', display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#92400e' }}>First, set your 3 Supabase keys</div>
            <p style={hintStyle}>In production these must be set as secrets on your host. Add each one, then press Check again.</p>
            {missingSupabase.map((m) => (
              <button
                key={m.variable}
                type="button"
                onClick={() => copy(m.command)}
                style={{ textAlign: 'left', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: '#0f172a', color: copied === m.command ? '#4ade80' : '#e2e8f0', border: 'none', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', wordBreak: 'break-all' }}
              >
                {copied === m.command ? 'copied' : m.command}
              </button>
            ))}
            <button type="button" onClick={() => void load()} style={{ justifySelf: 'start', background: '#fff', color: '#92400e', border: '1px solid #fde68a', borderRadius: 999, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              Check again
            </button>
          </div>
        )}

        <form onSubmit={submit} style={{ display: 'grid', gap: 20 }}>
          <Card>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>1 · Connect your database</h2>
            <Field label="Supabase project URL" hint="Looks like https://abcdefghijklm.supabase.co">
              <TextInput value={form.supabase_url} onChange={(v) => set('supabase_url', v)} placeholder="https://your-project.supabase.co" />
            </Field>
            <Field label="Anon public key" hint="A long JWT starting with eyJ...">
              <SecretInput value={form.supabase_anon_key} onChange={(v) => set('supabase_anon_key', v)} placeholder="eyJ..." />
            </Field>
            <Field label="Service-role key (secret)" hint="Never expose this one. It also starts with eyJ...">
              <SecretInput value={form.supabase_service_role_key} onChange={(v) => set('supabase_service_role_key', v)} placeholder="eyJ..." />
            </Field>
            <p style={hintStyle}>
              No account yet? Create a free project at supabase.com, then grab these three values under Project Settings, API.
            </p>
          </Card>

          <Card>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>2 · Create your admin account</h2>
            <Field label="Email">
              <TextInput value={adminEmail} onChange={(v) => setAdminEmail(v)} placeholder="you@example.com" />
            </Field>
            <Field label="Password" hint="At least 6 characters.">
              <SecretInput value={adminPassword} onChange={(v) => setAdminPassword(v)} placeholder="password" />
            </Field>
          </Card>

          <Card>
            <button
              type="button"
              onClick={() => setShowOptional((s) => !s)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, width: '100%', color: '#111' }}
            >
              <span style={{ fontSize: 15, fontWeight: 800 }}>Optional: payments, email, maps and AI</span>
              <span style={{ fontSize: 18, color: '#6b7280' }}>{showOptional ? '−' : '+'}</span>
            </button>
            <p style={hintStyle}>Skip these for now. The store opens without them and you can add each one later in Settings.</p>

            {showOptional && (
              <div style={{ display: 'grid', gap: 18 }}>
                <div style={{ display: 'grid', gap: 12 }}>
                  <Field label="Payments">
                    <Select value={form.payment_provider} onChange={(v) => set('payment_provider', v)} options={PAYMENT_OPTIONS} />
                  </Field>
                  {needsKey(form.payment_provider) && (
                    <Field label="API key (secret)">
                      <SecretInput value={form.payment_api_key} onChange={(v) => set('payment_api_key', v)} placeholder="sk_..." />
                    </Field>
                  )}
                  {form.payment_provider === 'stripe' && (
                    <Field label="Webhook signing secret" hint="Optional at setup. Add it under Settings later.">
                      <SecretInput value={form.payment_webhook_secret} onChange={(v) => set('payment_webhook_secret', v)} placeholder="whsec_..." />
                    </Field>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 12 }}>
                  <Field label="Transactional email">
                    <Select value={form.mail_provider} onChange={(v) => set('mail_provider', v)} options={MAIL_OPTIONS} />
                  </Field>
                  {needsKey(form.mail_provider) && (
                    <Field label="API key (secret)">
                      <SecretInput value={form.mail_api_key} onChange={(v) => set('mail_api_key', v)} placeholder="re_..." />
                    </Field>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 12 }}>
                  <Field label="Address autofill (maps)">
                    <Select value={form.map_provider} onChange={(v) => set('map_provider', v)} options={MAP_OPTIONS} />
                  </Field>
                  {(form.map_provider === 'mapbox' || form.map_provider === 'google_maps') && (
                    <Field label="Public token">
                      <SecretInput value={form.map_api_key} onChange={(v) => set('map_api_key', v)} placeholder="pk.eyJ..." />
                    </Field>
                  )}
                </div>

                <div style={{ display: 'grid', gap: 12 }}>
                  <Field label="AI engine" hint="Powers product animations. Without it the store uses built-in presets.">
                    <Select value={form.ai_provider} onChange={(v) => set('ai_provider', v)} options={AI_OPTIONS} />
                  </Field>
                  {form.ai_provider !== '' && form.ai_provider !== 'workers_ai' && (
                    <Field label="API key (secret)">
                      <SecretInput value={form.ai_api_key} onChange={(v) => set('ai_api_key', v)} placeholder="sk-..." />
                    </Field>
                  )}
                </div>
              </div>
            )}
          </Card>

          {error && (
            <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 16px' }}>
              <p style={{ color: '#b91c1c', fontSize: 13, margin: 0, lineHeight: 1.6, whiteSpace: 'pre-line', wordBreak: 'break-word' }}>{error}</p>
            </div>
          )}

          {warning && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '14px 16px' }}>
              <p style={{ color: '#92400e', fontSize: 13, margin: 0, lineHeight: 1.6 }}>{warning}</p>
            </div>
          )}

          {notice === 'saved' && (
            <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 12, padding: '14px 16px', textAlign: 'center' }}>
              <p style={{ color: '#065f46', fontSize: 14, margin: 0, fontWeight: 700 }}>
                Saved.{' '}
                <Link href="/admin" prefetch={false} style={{ color: '#065f46', textDecoration: 'underline' }}>
                  Open the admin portal
                </Link>
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '16px 22px', fontSize: 16, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Saving...' : 'Finish setup'}
          </button>
        </form>
      </div>
    </main>
  );
}
