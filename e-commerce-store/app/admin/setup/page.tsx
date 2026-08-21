'use client';

/**
 * /admin/setup — the first-run Setup Wizard.
 *
 * Self-hosted buyers select their Email / Payment / Map providers and paste the
 * API keys for each. Saving POSTs to /api/admin/setup, which persists the keys
 * to `global_platform_settings` (Supabase), creates the master super-admin
 * account, and flips `is_configured` — after which middleware.ts unlocks the
 * standard admin login and redirects every /admin request here no more.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type ProviderOption<T extends string> = { value: T; label: string; hint: string };

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

type Status = { configured: boolean; supabase: { url: boolean; anonKey: boolean; serviceRoleKey: boolean } };

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [mailProvider, setMailProvider] = useState<'resend' | 'postmark' | 'sendgrid'>('resend');
  const [mailApiKey, setMailApiKey] = useState('');
  const [paymentProvider, setPaymentProvider] = useState<'stripe' | 'lemon_squeezy' | 'paddle'>('stripe');
  const [paymentApiKey, setPaymentApiKey] = useState('');
  const [paymentWebhookSecret, setPaymentWebhookSecret] = useState('');
  const [mapProvider, setMapProvider] = useState<'mapbox' | 'google_maps' | 'open_street_map'>('mapbox');
  const [mapApiKey, setMapApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch('/api/admin/setup', { cache: 'no-store' });
      const data = (await res.json()) as Partial<Status>;
      setStatus({
        configured: data.configured === true,
        supabase: data.supabase || { url: false, anonKey: false, serviceRoleKey: false },
      });
    } catch {
      setStatus({ configured: false, supabase: { url: false, anonKey: false, serviceRoleKey: false } });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminEmail, adminPassword, mailProvider, mailApiKey,
          paymentProvider, paymentApiKey, paymentWebhookSecret,
          mapProvider, mapApiKey,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; redirect?: string };
      if (!res.ok) { setError(data.error || 'Setup failed. Check the server logs.'); return; }
      setDone(true);
      window.location.href = data.redirect || '/admin';
    } catch {
      setError('Setup failed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const supabaseReady = Boolean(status?.supabase.url && status?.supabase.serviceRoleKey);

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '40px 16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ display: 'inline-block', background: '#111', color: '#fff', borderRadius: 14, padding: '8px 18px', fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>SETUP WIZARD</div>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '16px 0 6px', color: '#111' }}>Connect your services</h1>
          <p style={{ color: '#6b7280', fontSize: 15, margin: 0, lineHeight: 1.6 }}>
            Paste your own API keys for emails, payments and maps. Nothing is hardcoded — these are stored in your Supabase{' '}
            <code style={{ background: '#e5e7eb', padding: '2px 6px', borderRadius: 6 }}>global_platform_settings</code> table and applied at
            runtime by the driver engine.
          </p>
        </div>

        {loadingStatus ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>Checking configuration…</div>
        ) : status?.configured ? (
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, textAlign: 'center', boxShadow: '0 12px 30px rgba(0,0,0,0.08)' }}>
            <p style={{ fontWeight: 700, fontSize: 17 }}>This store is already configured.</p>
            <Link href="/admin" style={{ display: 'inline-block', marginTop: 12, background: '#111', color: '#fff', padding: '12px 24px', borderRadius: 999, textDecoration: 'none', fontWeight: 700 }}>Open the Admin Portal</Link>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 20 }}>
            {!supabaseReady && (
              <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 12, padding: '14px 16px', fontSize: 13, color: '#92400e', lineHeight: 1.5 }}>
                <strong>Supabase env vars missing.</strong> Set <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code> and{' '}
                <code>SUPABASE_SERVICE_ROLE_KEY</code> in your hosting platform, redeploy, then run this wizard. Saving now will fail.
              </div>
            )}

            <Section title="1 · Master account" subtitle="This becomes the store super-admin. It can sign into the admin portal and manage these settings.">
              <Field label="Admin email">
                <input type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@yourbrand.com" autoComplete="email" />
              </Field>
              <Field label="Admin password">
                <input type="password" required minLength={6} maxLength={128} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
              </Field>
            </Section>

            <Section title="2 · Email provider" subtitle="Transactional + verification emails (entry confirmations, winners, 2FA codes).">
              <ProviderSelect label="Provider" value={mailProvider} options={EMAIL_PROVIDERS} onChange={setMailProvider} />
              <Field label="API key">
                <input type="password" required value={mailApiKey} onChange={(e) => setMailApiKey(e.target.value)} placeholder={mailProvider === 'resend' ? 're_…' : 'Server token / API key'} autoComplete="off" />
              </Field>
              <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>
                Optional: set <code>EMAIL_FROM</code> (or <code>RESEND_FROM</code>) as an env var to control the “from” address. Postmark/SendGrid only deliver from verified senders.
              </p>
            </Section>

            <Section title="3 · Payment provider" subtitle="Hosted checkouts. Stripe also powers raffle card-save + webhooks.">
              <ProviderSelect label="Provider" value={paymentProvider} options={PAYMENT_PROVIDERS} onChange={setPaymentProvider} />
              <Field label="API key">
                <input type="password" required value={paymentApiKey} onChange={(e) => setPaymentApiKey(e.target.value)} placeholder={paymentProvider === 'stripe' ? 'sk_live_… / sk_test_…' : 'API key'} autoComplete="off" />
              </Field>
              {paymentProvider === 'stripe' && (
                <Field label="Webhook signing secret">
                  <input type="password" value={paymentWebhookSecret} onChange={(e) => setPaymentWebhookSecret(e.target.value)} placeholder="whsec_…" autoComplete="off" />
                </Field>
              )}
              <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>
                {paymentProvider === 'stripe' && 'Point the Stripe webhook at /api/stripe/webhook to reconcile entries automatically.'}
                {paymentProvider === 'lemon_squeezy' && 'Also set LEMONSQUEEZY_STORE_ID + LEMONSQUEEZY_VARIANT_ID env vars (the wizard only stores the API key).'}
                {paymentProvider === 'paddle' && 'Instant-buy only — raffle card-save requires Stripe.'}
              </p>
            </Section>

            <Section title="4 · Map provider" subtitle="Address autofill on checkout + account forms.">
              <ProviderSelect label="Provider" value={mapProvider} options={MAP_PROVIDERS} onChange={setMapProvider} />
              {mapProvider !== 'open_street_map' && (
                <Field label="API key">
                  <input type="password" required value={mapApiKey} onChange={(e) => setMapApiKey(e.target.value)} placeholder={mapProvider === 'mapbox' ? 'pk.…' : 'AIza…'} autoComplete="off" />
                </Field>
              )}
              {mapProvider === 'open_street_map' && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>OpenStreetMap needs no key.</p>}
            </Section>

            {error && (
              <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 16px', color: '#b91c1c', fontSize: 14 }}>{error}</div>
            )}

            <button type="submit" disabled={busy || done || !supabaseReady} style={{ background: busy || done ? '#9ca3af' : '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '16px 24px', fontSize: 16, fontWeight: 800, cursor: busy || done ? 'default' : 'pointer' }}>
              {busy ? 'Saving…' : done ? 'Done ✓' : 'Save configuration & create admin'}
            </button>

            <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', margin: 0 }}>
              Saved into <code>global_platform_settings</code> — RLS-restricted to the super-admin. The standard admin login unlocks after this step.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

function Section(props: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ background: '#fff', borderRadius: 16, padding: '20px 22px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)' }}>
      <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: '#111' }}>{props.title}</h2>
      {props.subtitle && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 16px', lineHeight: 1.5 }}>{props.subtitle}</p>}
      <div style={{ display: 'grid', gap: 14 }}>{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{props.label}</span>
      {props.children}
    </label>
  );
}

function ProviderSelect<T extends string>(props: { label: string; value: T; options: ProviderOption<T>[]; onChange: (v: T) => void }) {
  const active = props.options.find((o) => o.value === props.value);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)} style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15 }}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {active && <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{active.hint}</p>}
    </div>
  );
}
