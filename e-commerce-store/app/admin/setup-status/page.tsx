'use client';

/**
 * /admin/setup-status — the "System Configuration & Setup Checklist" page.
 *
 * middleware.ts redirects every /admin request here while the install is NOT
 * ready (missing data store, missing admin credentials, or no admin account).
 * It renders the full ✅/❌ breakdown from /api/admin/setup-status: exact
 * variable names, their purpose, copyable CLI commands (`npx wrangler secret
 * put VAR_NAME`), and the exact `wrangler.toml` block for Cloudflare bindings.
 * Once everything is detected, the "Open admin portal" button unlocks the
 * standard /admin dashboard (seamless transition).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type EnvCheck = {
  id: string;
  name: string;
  purpose: string;
  variable: string;
  aliases: string[];
  kind: string;
  present: boolean;
  required: boolean;
  blocking: boolean;
  secret: boolean;
  buildTime: boolean;
  platform: string;
  commands: string[];
  wranglerToml?: string;
};

type EnvGroup = { title: string; subtitle: string; kind: string; checks: EnvCheck[] };

type Status = {
  ok: boolean;
  ready: boolean;
  storageProvider: string;
  storageOk: boolean;
  legacyAdminOk: boolean;
  platformConfigured: boolean;
  platformProviders: { mail_provider: string | null; payment_provider: string | null; map_provider: string | null };
  environment: string;
  discovery: {
    groups: EnvGroup[];
    summary: { present: number; total: number; blockingMissing: string[]; requiredMissing: string[] };
    blockingReady: boolean;
    requiredReady: boolean;
  };
};

export default function SetupStatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/setup-status', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as Partial<Status>;
      if (!res.ok || !data.discovery) {
        setError('Could not load the setup status. Check the server logs.');
        return;
      }
      setStatus(data as Status);
    } catch {
      setError('Could not reach the setup status endpoint. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  const ready = status?.ready === true;
  const presentCount = status?.discovery.summary.present ?? 0;
  const totalCount = status?.discovery.summary.total ?? 0;
  const blockingMissing = status?.discovery.summary.blockingMissing ?? [];

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '40px 16px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ display: 'inline-block', background: '#111', color: '#fff', borderRadius: 14, padding: '8px 18px', fontSize: 12, letterSpacing: 3, fontWeight: 700 }}>
            SYSTEM CONFIGURATION
          </div>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '16px 0 6px', color: '#111' }}>Setup checklist</h1>
          <p style={{ color: '#6b7280', fontSize: 15, margin: 0, lineHeight: 1.6 }}>
            This page runs before the admin portal unlocks. It scans the runtime environment on every request and shows
            exactly what is configured <span style={{ fontWeight: 700 }}>✅</span> and what is missing <span style={{ fontWeight: 700 }}>❌</span>.
          </p>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>Scanning environment…</div>
        ) : (
          <div
            style={{
              background: ready ? '#ecfdf5' : '#fef3c7',
              border: `1px solid ${ready ? '#a7f3d0' : '#fcd34d'}`,
              borderRadius: 16,
              padding: '20px 24px',
              marginBottom: 20,
              color: ready ? '#065f46' : '#92400e',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>
              {ready ? '✅ Ready — admin portal unlocked' : `❌ ${blockingMissing.length} blocking item${blockingMissing.length === 1 ? '' : 's'} + admin account pending`}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              {ready
                ? 'All required variables and the admin account are detected. You can open the admin portal now.'
                : 'Resolve the items below, then refresh. Once the data store and an admin account exist, the standard admin portal opens automatically.'}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {ready && (
                <Link href="/admin" prefetch={false} style={{ display: 'inline-block', background: '#111', color: '#fff', borderRadius: 999, padding: '12px 22px', fontSize: 14, fontWeight: 800, textDecoration: 'none' }}>
                  Open admin portal →
                </Link>
              )}
              <Link href="/admin/setup" prefetch={false} style={{ display: 'inline-block', background: '#fff', color: '#111', borderRadius: 999, padding: '12px 22px', fontSize: 14, fontWeight: 800, textDecoration: 'none', border: '1px solid #d1d5db' }}>
                Provider setup wizard
              </Link>
              <button type="button" onClick={load} style={{ background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: 999, padding: '12px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                ⟳ Re-scan
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 16px', color: '#b91c1c', fontSize: 14, marginBottom: 20 }}>{error}</div>
        )}

        {status && !loading && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <Chip label={`${presentCount}/${totalCount} configured`} tone="neutral" />
            <Chip label={`Storage: ${status.storageProvider}`} tone={status.storageOk ? 'ok' : 'warn'} />
            <Chip label={`Admin account: ${status.platformConfigured || status.legacyAdminOk ? 'present' : 'missing'}`} tone={status.platformConfigured || status.legacyAdminOk ? 'ok' : 'warn'} />
            <Chip label={`Environment: ${status.environment}`} tone="neutral" />
          </div>
        )}

        {status &&
          !loading &&
          status.discovery.groups.map((group) => (
            <section key={group.kind} style={{ background: '#fff', borderRadius: 16, padding: '20px 22px', boxShadow: '0 12px 30px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: '#111' }}>{group.title}</h2>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 14px' }}>{group.subtitle}</p>
              <div style={{ display: 'grid', gap: 12 }}>
                {group.checks.map((check) => (
                  <CheckRow key={check.id} check={check} copied={copied} onCopy={copy} />
                ))}
              </div>
            </section>
          ))}
      </div>
    </main>
  );
}

function Chip(props: { label: string; tone: 'ok' | 'warn' | 'neutral' }) {
  const bg = props.tone === 'ok' ? '#ecfdf5' : props.tone === 'warn' ? '#fef3c7' : '#eef0f3';
  const color = props.tone === 'ok' ? '#065f46' : props.tone === 'warn' ? '#92400e' : '#374151';
  return (
    <span style={{ background: bg, color, borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 700 }}>
      {props.label}
    </span>
  );
}

function CheckRow(props: { check: EnvCheck; copied: string; onCopy: (text: string) => void }) {
  const { check, copied, onCopy } = props;
  const present = check.present;
  const badge = present ? '✅' : check.blocking ? '❌' : '⚠';

  return (
    <div
      style={{
        border: `1px solid ${present ? '#d1fae5' : check.blocking ? '#fecaca' : '#fde68a'}`,
        background: present ? '#f0fdf4' : check.blocking ? '#fef2f2' : '#fffbeb',
        borderRadius: 12,
        padding: '14px 16px',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16 }}>{badge}</span>
        <strong style={{ fontSize: 15, color: '#111' }}>{check.name}</strong>
        {check.blocking && <Tag label="BLOCKING" tone="danger" />}
        {check.required && !check.blocking && <Tag label="REQUIRED" tone="warn" />}
        {check.secret && <Tag label="SECRET" tone="neutral" />}
        {check.buildTime && <Tag label="BUILD-TIME" tone="neutral" />}
      </div>

      <p style={{ fontSize: 13, color: '#4b5563', margin: 0, lineHeight: 1.5 }}>{check.purpose}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <code style={{ background: '#111', color: '#e5e7eb', padding: '3px 8px', borderRadius: 6, fontSize: 12 }}>{check.variable}</code>
        {check.aliases.map((a) => (
          <code key={a} style={{ background: '#eef0f3', color: '#4b5563', padding: '3px 8px', borderRadius: 6, fontSize: 11 }}>{a}</code>
        ))}
      </div>

      {check.commands.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {check.commands.map((cmd) => (
            <div key={cmd} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ flex: 1, background: '#0f172a', color: '#a5f3fc', padding: '8px 12px', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{cmd}</code>
              <button
                type="button"
                onClick={() => onCopy(cmd)}
                style={{ background: copied === cmd ? '#10b981' : '#fff', color: copied === cmd ? '#fff' : '#111', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {copied === cmd ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          ))}
        </div>
      )}

      {check.wranglerToml && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>wrangler.toml</span>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <pre style={{ flex: 1, margin: 0, background: '#0f172a', color: '#a5f3fc', padding: '10px 12px', borderRadius: 8, fontSize: 12, overflowX: 'auto' }}>{check.wranglerToml}</pre>
            <button
              type="button"
              onClick={() => onCopy(check.wranglerToml || '')}
              style={{ background: copied === check.wranglerToml ? '#10b981' : '#fff', color: copied === check.wranglerToml ? '#fff' : '#111', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {copied === check.wranglerToml ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tag(props: { label: string; tone: 'danger' | 'warn' | 'neutral' }) {
  const bg = props.tone === 'danger' ? '#fee2e2' : props.tone === 'warn' ? '#fef3c7' : '#eef0f3';
  const color = props.tone === 'danger' ? '#b91c1c' : props.tone === 'warn' ? '#92400e' : '#4b5563';
  return (
    <span style={{ background: bg, color, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: 0.5 }}>
      {props.label}
    </span>
  );
}

