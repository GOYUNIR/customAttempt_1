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
const copyBtnStyle = { background: '#eef2ff', color: '#3730a3', border: '1px solid #c7d2fe', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' } as const;
// Public Cloudflare dashboard URL — where a non-technical buyer pastes the 3
// Supabase values by hand (no terminal needed). Not a secret.
const CLOUDFLARE_DASHBOARD = 'https://dash.cloudflare.com/';

// ── types ─────────────────────────────────────────────────────────────────────
type MissingCred = { variable: string; command: string; example: string; where?: string; name?: string };
type DataStoreStatus = { key: string; label: string; configured: boolean; missing: MissingCred[] };
type Status = {
  configured?: boolean;
  isProduction?: boolean;
  supabaseEnvReady?: boolean;
  dataStores?: DataStoreStatus[];
  dashboardUrl?: string;
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

const DB_OPTIONS = [
  { value: 'supabase', label: 'Supabase (PostgreSQL) — recommended' },
  { value: 'upstash', label: 'Upstash Redis' },
  { value: 'cloudflare-kv', label: 'Cloudflare KV / D1' },
];

const MIRROR_OPTIONS = [
  { value: '', label: 'No mirror (single database)' },
  { value: 'upstash', label: 'Upstash Redis' },
  { value: 'supabase', label: 'Supabase' },
  { value: 'cloudflare-kv', label: 'Cloudflare KV / D1' },
];

/** One copy-paste env-var row: the variable name + a click-to-copy command. */
function EnvVarRow(props: { variable: string; command: string; where: string; copied: string; onCopy: (t: string) => void }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <EnvNameChip name={props.variable} copied={props.copied} onCopy={props.onCopy} />
      <p style={hintStyle}>{props.where}</p>
      <button
        type="button"
        onClick={() => props.onCopy(props.command)}
        style={{ textAlign: 'left', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: '#0f172a', color: props.copied === props.command ? '#4ade80' : '#e2e8f0', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', wordBreak: 'break-all' }}
      >
        {props.copied === props.command ? 'copied ✓' : props.command}
      </button>
    </div>
  );
}

/** The env-var names + copy-paste commands + links for the chosen database(s). */
function DatabaseInstructions(props: { primary: string; mirror: string; copied: string; onCopy: (t: string) => void }) {
  const { primary, mirror, copied, onCopy } = props;
  return (
    <div style={{ display: 'grid', gap: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
      {primary === 'upstash' ? (
        <>
          <p style={hintStyle}>
            Your store data (products, orders, entries) will live in <strong>Upstash Redis</strong>. Set these in Cloudflare — the URL and token as <strong>Secrets</strong>, and <code>STORAGE_PROVIDER</code> as a plaintext <strong>Variable</strong> with the value <code>upstash</code>.
          </p>
          <EnvVarRow variable="STORAGE_PROVIDER" command="npx wrangler secret put STORAGE_PROVIDER" where="Value: upstash (or set it as a plaintext Variable in the dashboard)." copied={copied} onCopy={onCopy} />
          <EnvVarRow variable="UPSTASH_REDIS_REST_URL" command="npx wrangler secret put UPSTASH_REDIS_REST_URL" where="Where: console.upstash.com → your database → REST API → copy the REST URL (https://…upstash.io)." copied={copied} onCopy={onCopy} />
          <EnvVarRow variable="UPSTASH_REDIS_REST_TOKEN" command="npx wrangler secret put UPSTASH_REDIS_REST_TOKEN" where="Where: same page → copy the REST token. Never expose it." copied={copied} onCopy={onCopy} />
          <a href="https://console.upstash.com" target="_blank" rel="noopener noreferrer" style={{ justifySelf: 'start', fontSize: 13, fontWeight: 700, color: '#1d4ed8', textDecoration: 'underline' }}>Open console.upstash.com →</a>
        </>
      ) : primary === 'cloudflare-kv' ? (
        <>
          <p style={hintStyle}>
            Your store data will live in <strong>Cloudflare Workers KV</strong> (no third-party store). Set <code>STORAGE_PROVIDER</code> to <code>cloudflare-kv</code> and add a KV namespace binding. Note: KV is best for admin/config/low-concurrency data — read the concurrency caveats before pointing raffle/payment writes at it.
          </p>
          <EnvVarRow variable="STORAGE_PROVIDER" command="npx wrangler secret put STORAGE_PROVIDER" where="Value: cloudflare-kv (plaintext Variable)." copied={copied} onCopy={onCopy} />
          <p style={hintStyle}>
            Then bind a KV namespace in <code>wrangler.jsonc</code> (the app auto-detects a KV-shaped binding) — see <a href="https://developers.cloudflare.com/kv/" target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8', textDecoration: 'underline' }}>developers.cloudflare.com/kv</a>.
          </p>
          <a href={CLOUDFLARE_DASHBOARD} target="_blank" rel="noopener noreferrer" style={{ justifySelf: 'start', fontSize: 13, fontWeight: 700, color: '#1d4ed8', textDecoration: 'underline' }}>Open the Cloudflare dashboard →</a>
        </>
      ) : (
        <>
          <p style={hintStyle}>
            <strong>Supabase (PostgreSQL)</strong> is the recommended all-in-one store — it holds your products, orders and entries AND your admin account + settings. Fill in the three Supabase values in step 2 below; no extra <code>STORAGE_PROVIDER</code> variable is needed (Supabase is the default).
          </p>
          <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer" style={{ justifySelf: 'start', fontSize: 13, fontWeight: 700, color: '#1d4ed8', textDecoration: 'underline' }}>Open supabase.com/dashboard →</a>
        </>
      )}

      {mirror && mirror !== primary && (
        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'grid', gap: 10 }}>
          <p style={{ ...hintStyle, fontWeight: 700, color: '#0f172a' }}>
            Safety mirror: every write also copies to <strong>{mirror === 'upstash' ? 'Upstash Redis' : mirror === 'supabase' ? 'Supabase' : 'Cloudflare KV'}</strong> (failover + data-loss protection).
          </p>
          <EnvVarRow variable="STORAGE_REPLICAS" command="npx wrangler secret put STORAGE_REPLICAS" where={`Value: ${mirror} (comma-separate 2–3 mirrors). Plaintext Variable.`} copied={copied} onCopy={onCopy} />
          {mirror === 'upstash' && (
            <>
              <EnvVarRow variable="UPSTASH_REDIS_REST_URL" command="npx wrangler secret put UPSTASH_REDIS_REST_URL" where="Mirror: console.upstash.com → REST API → REST URL." copied={copied} onCopy={onCopy} />
              <EnvVarRow variable="UPSTASH_REDIS_REST_TOKEN" command="npx wrangler secret put UPSTASH_REDIS_REST_TOKEN" where="Mirror: REST token (Secret)." copied={copied} onCopy={onCopy} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
  storage_provider: 'supabase',
  storage_replicas: '',
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

/** An environment-variable name with a one-tap copy button — so a buyer can
 *  paste the exact name into Cloudflare without ever typing it. */
function EnvNameChip(props: { name: string; copied: string; onCopy: (t: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, fontWeight: 800, color: '#3730a3', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 8, padding: '5px 10px' }}>{props.name}</code>
      <button type="button" onClick={() => props.onCopy(props.name)} style={copyBtnStyle}>
        {props.copied === props.name ? 'copied ✓' : 'copy name'}
      </button>
    </div>
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
  const [showHelp, setShowHelp] = useState(false);
  const [showMirror, setShowMirror] = useState(false);
  const [copied, setCopied] = useState('');
  const [probe, setProbe] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; message: string }>({ state: 'idle', message: '' });

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

  async function testConnection() {
    setProbe({ state: 'busy', message: 'Testing…' });
    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probe: 'supabase',
          supabase_url: form.supabase_url,
          supabase_anon_key: form.supabase_anon_key,
          supabase_service_role_key: form.supabase_service_role_key,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; connected?: boolean; error?: string };
      if (data.connected) {
        setProbe({ state: 'ok', message: '✓ Connected — Supabase accepted your keys.' });
      } else {
        setProbe({ state: 'fail', message: String(data.error || 'Connection failed.') });
      }
    } catch {
      setProbe({ state: 'fail', message: 'Could not test the connection — check your network.' });
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
          <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>Choose your database, then create your admin account. Everything else can wait.</p>
          {configured && (
            <p style={{ color: '#92400e', fontSize: 13, margin: 0, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px' }}>
              This store is already set up. Enter your admin email and password to update it.
            </p>
          )}
        </header>

        {inProduction && !supabaseEnvReady && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 14, padding: '18px', display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#92400e' }}>🔒 Connect Supabase to continue</div>
            <p style={hintStyle}>
              The server needs these 3 values before it can reach your database. Add them by hand in the Cloudflare dashboard (no terminal needed) or run one command each, then press <strong>Check again</strong>.
            </p>

            <a href={CLOUDFLARE_DASHBOARD} target="_blank" rel="noopener noreferrer" style={{ justifySelf: 'start', fontSize: 13, fontWeight: 700, color: '#1d4ed8', textDecoration: 'underline' }}>
              Open the Cloudflare dashboard →
            </a>
            <p style={hintStyle}>
              Path: Workers &amp; Pages → [your project] → Settings → <strong>Variables and Secrets</strong> → Production. Add each value as a <strong>Secret</strong> (encrypted) — the URL can also be a plaintext Variable.
            </p>

            {missingSupabase.length === 0 ? (
              <div style={{ fontSize: 13, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: '10px 12px' }}>
                ✓ All 3 keys detected. Press “Check again” to refresh the gate.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {missingSupabase.map((m) => (
                  <div key={m.variable} style={{ display: 'grid', gap: 6, background: '#fff', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, fontWeight: 800, color: '#0f172a' }}>{m.variable}</code>
                      <button type="button" onClick={() => copy(m.variable)} style={{ ...copyBtnStyle, flexShrink: 0 }}>
                        {copied === m.variable ? 'copied ✓' : 'copy name'}
                      </button>
                    </div>
                    {m.where ? <p style={hintStyle}>{m.where}</p> : null}
                    <button
                      type="button"
                      onClick={() => copy(m.command)}
                      style={{ textAlign: 'left', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: '#0f172a', color: copied === m.command ? '#4ade80' : '#e2e8f0', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', wordBreak: 'break-all' }}
                    >
                      {copied === m.command ? 'copied ✓' : m.command}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button type="button" onClick={() => void load()} style={{ justifySelf: 'start', background: '#fff', color: '#92400e', border: '1px solid #fde68a', borderRadius: 999, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              ⟳ Check again
            </button>
          </div>
        )}

        <form onSubmit={submit} style={{ display: 'grid', gap: 20 }}>
          <Card>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>1 · Choose your database</h2>
            <Field label="Primary database (store data)">
              <Select value={form.storage_provider} onChange={(v) => set('storage_provider', v)} options={DB_OPTIONS} />
            </Field>
            <Field label="Second database (safety mirror, optional)" hint="Mirrors every write to an independent backup so one vendor outage or data loss never takes the store down.">
              <Select value={form.storage_replicas} onChange={(v) => set('storage_replicas', v)} options={MIRROR_OPTIONS} />
            </Field>
            <DatabaseInstructions primary={form.storage_provider} mirror={form.storage_replicas} copied={copied} onCopy={copy} />
          </Card>

          <Card>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>2 · Connect Supabase (admin &amp; settings)</h2>
            <p style={hintStyle}>
              Your <strong>master admin account and store settings</strong> are saved in Supabase — this is required no matter which store database you chose above. Paste the 3 values (Project Settings → API). Each field shows the exact <strong>variable name</strong> Cloudflare expects — copy the name, paste the value.
            </p>

            <Field label="Supabase project URL" hint="Looks like https://abcdefghijklm.supabase.co">
              <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
                <EnvNameChip name="SUPABASE_URL" copied={copied} onCopy={copy} />
              </div>
              <TextInput value={form.supabase_url} onChange={(v) => set('supabase_url', v)} placeholder="https://your-project.supabase.co" />
            </Field>

            <Field label="Anon public key" hint="A long JWT starting with eyJ...">
              <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
                <EnvNameChip name="SUPABASE_ANON_KEY" copied={copied} onCopy={copy} />
              </div>
              <SecretInput value={form.supabase_anon_key} onChange={(v) => set('supabase_anon_key', v)} placeholder="eyJ..." />
            </Field>

            <Field label="Service-role key (secret)" hint="Never expose this one. It also starts with eyJ...">
              <div style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
                <EnvNameChip name="SUPABASE_SERVICE_ROLE_KEY" copied={copied} onCopy={copy} />
              </div>
              <SecretInput value={form.supabase_service_role_key} onChange={(v) => set('supabase_service_role_key', v)} placeholder="eyJ..." />
            </Field>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => void testConnection()} disabled={probe.state === 'busy'} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: probe.state === 'busy' ? 'default' : 'pointer', opacity: probe.state === 'busy' ? 0.6 : 1 }}>
                {probe.state === 'busy' ? 'Testing…' : 'Test connection'}
              </button>
              {probe.state === 'ok' && <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>{probe.message}</span>}
              {probe.state === 'fail' && <span style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c' }}>{probe.message}</span>}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <button type="button" onClick={() => setShowHelp((s) => !s)} style={{ justifySelf: 'start', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 700, color: '#1d4ed8' }}>
                {showHelp ? 'Hide' : 'Where do I find these values?'} {showHelp ? '−' : '+'}
              </button>
              {showHelp && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', display: 'grid', gap: 8 }}>
                  <p style={hintStyle}>
                    1. Go to <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8', textDecoration: 'underline' }}>supabase.com/dashboard</a> → open your project → <strong>Project Settings → API</strong>.
                  </p>
                  <p style={hintStyle}>2. Copy the <strong>Project URL</strong>, the <strong>anon public</strong> key, and the <strong>service_role</strong> key.</p>
                  <p style={hintStyle}>
                    3. Add them in Cloudflare — by hand in the <a href={CLOUDFLARE_DASHBOARD} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8', textDecoration: 'underline' }}>dashboard</a> (Workers &amp; Pages → [project] → Settings → Variables and Secrets → Production → <strong>Secrets</strong>), or with the copy-paste commands above.
                  </p>
                </div>
              )}
            </div>

            <p style={hintStyle}>
              No account yet? Create a free project at supabase.com, then grab these three values under Project Settings, API.
            </p>
          </Card>

          <Card>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#111' }}>3 · Create your admin account</h2>
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
              onClick={() => setShowMirror((s) => !s)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, width: '100%', color: '#111' }}
            >
              <span style={{ fontSize: 15, fontWeight: 800 }}>Optional: add a safety mirror (redundancy)</span>
              <span style={{ fontSize: 18, color: '#6b7280' }}>{showMirror ? '−' : '+'}</span>
            </button>
            <p style={hintStyle}>
              Mirror every write to a second independent database (e.g. Upstash Redis) so if one provider ever goes down or loses data, the store keeps a full copy. Add these in Cloudflare the same way as above, then redeploy.
            </p>
            {showMirror && (
              <div style={{ display: 'grid', gap: 10 }}>
                <EnvNameChip name="STORAGE_REPLICAS" copied={copied} onCopy={copy} />
                <p style={hintStyle}>Set this to <code>upstash</code> (or a comma-separated list for 2–3 mirrors).</p>
                <EnvNameChip name="UPSTASH_REDIS_REST_URL" copied={copied} onCopy={copy} />
                <EnvNameChip name="UPSTASH_REDIS_REST_TOKEN" copied={copied} onCopy={copy} />
                <p style={hintStyle}>
                  The store then writes to both automatically and reads from the primary with failover. Set the token as a Secret; STORAGE_REPLICAS and the URL can be plaintext Variables.
                </p>
              </div>
            )}
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
