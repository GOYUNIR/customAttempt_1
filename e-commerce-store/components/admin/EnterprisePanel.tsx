'use client';

import { useState, useEffect, useCallback } from 'react';
import QuoteDeskPanel from '@/components/sales/QuoteDeskPanel';
import DomainProvisioningCard from '@/components/admin/DomainProvisioningCard';
import UserRoleManager from '@/components/admin/UserRoleManager';
import { panelStyle, inputStyle, buttonPrimary, buttonGhost, statusPill, adminApiFetch } from '@/components/admin/portalStyles';

/**
 * ENTERPRISE PANEL — the admin UI for this session's three new capabilities:
 * B2B quotes (supabase/migrations/00009 + app/api/admin/b2b/quotes),
 * custom domains (Phase 4, app/api/admin/domains), and the guardrailed AI
 * assistant (Phase 5, app/api/admin/ai-assistant). Built as a single
 * self-contained, additive component — app/admin/page.tsx (9000+ lines)
 * only needed one new tab entry and one render block to host it, so nothing
 * about the existing portal changes.
 *
 * All three sub-panels require Supabase to be configured (the schema these
 * features are built on); each renders a clear, non-alarming "not
 * configured yet" state instead of an error when it isn't — the same
 * pattern lib/cloudflare-saas.ts uses for missing Cloudflare credentials.
 */

type EnterpriseSubTab = 'quotes' | 'domains' | 'roles' | 'assistant' | 'health';

const SUB_TAB_LABEL: Record<EnterpriseSubTab, string> = {
  quotes: 'B2B Quotes',
  domains: 'Custom Domains',
  roles: 'Roles',
  assistant: 'AI Assistant',
  health: 'Health & Security',
};

export default function EnterprisePanel({ password }: { password: string }) {
  const [subTab, setSubTab] = useState<EnterpriseSubTab>('quotes');

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Enterprise</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['quotes', 'domains', 'roles', 'assistant', 'health'] as EnterpriseSubTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSubTab(t)}
              style={{
                ...buttonGhost,
                ...(subTab === t ? { background: '#3b82f622', border: '1px solid #3b82f6', color: '#93c5fd' } : {}),
              }}
            >
              {SUB_TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {subTab === 'quotes' && <QuoteDeskPanel password={password} />}
      {subTab === 'domains' && <DomainProvisioningCard password={password} />}
      {subTab === 'roles' && <UserRoleManager />}
      {subTab === 'assistant' && <AssistantPanel />}
      {subTab === 'health' && <HealthPanel />}
    </div>
  );
}

// ── AI Assistant ──────────────────────────────────────────────────────────────

function AssistantPanel() {
  const [message, setMessage] = useState('');
  const [log, setLog] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setMessage('');
    setLog((l) => [...l, { role: 'user', text }]);
    setBusy(true);
    try {
      const res = await adminApiFetch('/api/admin/ai-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLog((l) => [...l, { role: 'assistant', text: `⚠ ${data?.error || 'Could not complete that request.'}` }]);
        return;
      }
      const summary = data.toolCalled
        ? `Ran ${data.toolCalled}.\n${JSON.stringify(data.toolResult, null, 2)}`
        : data.reply || '(no reply)';
      setLog((l) => [...l, { role: 'assistant', text: summary }]);
    } catch (err: any) {
      setLog((l) => [...l, { role: 'assistant', text: `⚠ ${err?.message || 'Network error.'}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Ask for a store action in plain language — e.g. &quot;audit my storefront SEO&quot; or &quot;create a 15%
        discount for variant X at 10+ units&quot;. Only tools your role is allowed to run are ever offered to the
        model, and every executed tool is written to the immutable audit log.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto', padding: 12, background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
        {log.length === 0 && <p style={{ fontSize: 12, color: '#555', margin: 0 }}>No messages yet.</p>}
        {log.map((entry, i) => (
          <div key={i} style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: entry.role === 'user' ? '#93c5fd' : '#ddd' }}>
            <strong>{entry.role === 'user' ? 'You' : 'Assistant'}:</strong> {entry.text}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Ask the assistant…"
        />
        <button type="button" style={buttonPrimary} onClick={send} disabled={busy || !message.trim()}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ── System Health & Security Diagnostic Panel ────────────────────────────────

type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'not_configured';
type HealthCheck = { id: string; label: string; status: HealthCheckStatus; detail: string };
type HealthResponse = {
  checks: HealthCheck[];
  summary: { ok: number; warning: number; error: number; notConfigured: number };
  checkedAt: string;
};

function healthStatusColor(status: HealthCheckStatus): string {
  if (status === 'ok') return '#34d399';
  if (status === 'warning') return '#fbbf24';
  if (status === 'error') return '#f87171';
  return '#6b7280';
}

function healthStatusLabel(status: HealthCheckStatus): string {
  if (status === 'ok') return 'OK';
  if (status === 'warning') return 'Warning';
  if (status === 'error') return 'Error';
  return 'Not configured';
}

function HealthPanel() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runChecks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/system-health');
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || 'Could not run diagnostics.');
        return;
      }
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runChecks();
  }, [runChecks]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
          Every check below probes REAL state (Redis lock ping, an anon-key read attempt against sensitive
          tables, live dedupe counters) — not a static configuration claim.
        </p>
        <button type="button" style={buttonGhost} onClick={runChecks} disabled={loading}>
          {loading ? 'Checking…' : 'Re-run'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span style={statusPill('#34d399')}>{data.summary.ok} OK</span>
            {data.summary.warning > 0 && <span style={statusPill('#fbbf24')}>{data.summary.warning} Warning</span>}
            {data.summary.error > 0 && <span style={statusPill('#f87171')}>{data.summary.error} Error</span>}
            {data.summary.notConfigured > 0 && <span style={statusPill('#6b7280')}>{data.summary.notConfigured} Not configured</span>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.checks.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
                <span style={{ ...statusPill(healthStatusColor(c.status)), flexShrink: 0, marginTop: 1 }}>{healthStatusLabel(c.status)}</span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{c.detail}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10.5, color: '#666' }}>Last checked {new Date(data.checkedAt).toLocaleString()}</div>
        </>
      )}
    </div>
  );
}
