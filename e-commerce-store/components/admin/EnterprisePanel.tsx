'use client';

import { useState, useEffect, useCallback, type CSSProperties } from 'react';

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

const panelStyle: CSSProperties = {
  padding: 22,
  borderRadius: 18,
  background: '#141417',
  border: '1px solid #2a2a30',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.14)',
};

const inputStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: '#0d0d10',
  border: '1px solid #303036',
  color: '#fff',
  fontSize: 13,
  boxSizing: 'border-box',
};

const buttonPrimary: CSSProperties = {
  padding: '9px 16px',
  borderRadius: 10,
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const buttonGhost: CSSProperties = {
  padding: '9px 16px',
  borderRadius: 10,
  background: 'transparent',
  color: '#ccc',
  border: '1px solid #303036',
  fontSize: 12,
  cursor: 'pointer',
};

const labelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  color: '#8b95a7',
};

const statusPill = (color: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: 'uppercase',
  color,
  background: `${color}22`,
  border: `1px solid ${color}55`,
});

type EnterpriseSubTab = 'quotes' | 'domains' | 'assistant' | 'health';

async function adminApiFetch(input: string, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: 'include' });
}

export default function EnterprisePanel({ password }: { password: string }) {
  const [subTab, setSubTab] = useState<EnterpriseSubTab>('quotes');

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase' }}>Enterprise</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['quotes', 'domains', 'assistant', 'health'] as EnterpriseSubTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSubTab(t)}
              style={{
                ...buttonGhost,
                ...(subTab === t ? { background: '#3b82f622', border: '1px solid #3b82f6', color: '#93c5fd' } : {}),
              }}
            >
              {t === 'quotes' ? 'B2B Quotes' : t === 'domains' ? 'Custom Domains' : t === 'assistant' ? 'AI Assistant' : 'Health & Security'}
            </button>
          ))}
        </div>
      </div>
      {subTab === 'quotes' && <QuotesPanel password={password} />}
      {subTab === 'domains' && <DomainsPanel password={password} />}
      {subTab === 'assistant' && <AssistantPanel />}
      {subTab === 'health' && <HealthPanel />}
    </div>
  );
}

// ── Quotes ────────────────────────────────────────────────────────────────────

type QuoteRow = {
  id: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  notes: string | null;
  created_at: string;
};

function QuotesPanel({ password }: { password: string }) {
  const [companyId, setCompanyId] = useState('');
  const [quotes, setQuotes] = useState<QuoteRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newVariantId, setNewVariantId] = useState('');
  const [newQuantity, setNewQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const loadQuotes = useCallback(async () => {
    if (!companyId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch(`/api/admin/b2b/quotes?companyId=${encodeURIComponent(companyId.trim())}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load quotes.');
        setQuotes(null);
        return;
      }
      setQuotes(data.quotes || []);
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const createQuote = async () => {
    if (!companyId.trim() || !newVariantId.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/b2b/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          companyId: companyId.trim(),
          lines: [{ variantId: newVariantId.trim(), quantity: Math.max(1, Number(newQuantity) || 1) }],
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not create quote.');
        return;
      }
      setNewVariantId('');
      setNewQuantity('1');
      setNotes('');
      await loadQuotes();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Draft and track B2B quotes. Pricing is resolved against the company&apos;s contract price list automatically
        (falls back to the tenant default list, then the catalog base price).
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Company ID</span>
          <input style={{ ...inputStyle, minWidth: 260 }} value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="uuid" />
        </div>
        <button type="button" style={buttonGhost} onClick={loadQuotes} disabled={loading || !companyId.trim()}>
          {loading ? 'Loading…' : 'Load Quotes'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      <div style={{ borderTop: '1px solid #2a2a30', paddingTop: 16 }}>
        <h3 style={{ ...labelStyle, marginBottom: 10 }}>New Quote Line</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Variant ID</span>
            <input style={inputStyle} value={newVariantId} onChange={(e) => setNewVariantId(e.target.value)} placeholder="uuid" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Quantity</span>
            <input style={{ ...inputStyle, width: 90 }} type="number" min={1} value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
            <span style={labelStyle}>Notes (optional)</span>
            <input style={inputStyle} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <button type="button" style={buttonPrimary} onClick={createQuote} disabled={creating || !companyId.trim() || !newVariantId.trim()}>
            {creating ? 'Creating…' : 'Create Quote'}
          </button>
        </div>
      </div>

      {quotes && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={labelStyle}>Quotes ({quotes.length})</h3>
          {quotes.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No quotes yet for this company.</p>}
          {quotes.map((q) => (
            <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>${(q.subtotal_cents / 100).toFixed(2)} {q.currency.toUpperCase()}</div>
                <div style={{ fontSize: 10.5, color: '#888' }}>{new Date(q.created_at).toLocaleString()}{q.notes ? ` · ${q.notes}` : ''}</div>
              </div>
              <span style={statusPill(q.status === 'accepted' || q.status === 'converted' ? '#34d399' : q.status === 'rejected' || q.status === 'expired' ? '#f87171' : '#93c5fd')}>{q.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Custom Domains ───────────────────────────────────────────────────────────

type DomainState = {
  custom_domain: string | null;
  domain_status: string;
  ssl_status: string;
  domain_verification?: { records?: Array<{ type: string; name: string; value: string }> };
  domain_checked_at: string | null;
};

function DomainsPanel({ password }: { password: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [domain, setDomain] = useState<DomainState | null>(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch('/api/admin/domains');
      const data = await res.json();
      setConfigured(Boolean(data?.configured));
      setDomain(data?.domain || null);
      if (data?.domain?.custom_domain) setHostname(data.domain.custom_domain);
    } catch {
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const linkDomain = async () => {
    if (!hostname.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, hostname: hostname.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not link domain.');
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const removeDomain = async () => {
    if (!confirm('Remove this custom domain?')) return;
    setBusy(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/domains', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not remove domain.');
        return;
      }
      setHostname('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  if (configured === null) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;

  if (!configured) {
    return (
      <div style={{ fontSize: 12.5, color: '#aaa', lineHeight: 1.6 }}>
        Custom domains require Cloudflare for SaaS. Set <code>CLOUDFLARE_API_TOKEN</code> and{' '}
        <code>CLOUDFLARE_ZONE_ID</code> in your hosting platform&apos;s environment, then reload this panel.
      </div>
    );
  }

  const statusColor = (s: string) => (s === 'active' ? '#34d399' : s === 'error' ? '#f87171' : '#fbbf24');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Map a custom domain (e.g. <code>store.yourbrand.com</code>) to this store via Cloudflare for SaaS.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Domain</span>
          <input style={{ ...inputStyle, minWidth: 260 }} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="store.yourbrand.com" />
        </div>
        <button type="button" style={buttonPrimary} onClick={linkDomain} disabled={busy || !hostname.trim()}>
          {busy ? 'Working…' : domain?.custom_domain ? 'Re-check Status' : 'Link Domain'}
        </button>
        {domain?.custom_domain && (
          <button type="button" style={{ ...buttonGhost, color: '#fca5a5', borderColor: '#7f1d1d' }} onClick={removeDomain} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      {domain?.custom_domain && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <span style={labelStyle}>Domain Status</span>
              <div style={{ marginTop: 4 }}><span style={statusPill(statusColor(domain.domain_status))}>{domain.domain_status}</span></div>
            </div>
            <div>
              <span style={labelStyle}>SSL Status</span>
              <div style={{ marginTop: 4 }}><span style={statusPill(statusColor(domain.ssl_status === 'active' ? 'active' : domain.ssl_status === 'error' ? 'error' : 'pending'))}>{domain.ssl_status}</span></div>
            </div>
          </div>
          {domain.domain_verification?.records && domain.domain_verification.records.length > 0 && (
            <div>
              <span style={labelStyle}>DNS Records To Add</span>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {domain.domain_verification.records.map((r, i) => (
                  <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: '#ccc', background: '#000', padding: '6px 8px', borderRadius: 6, overflowX: 'auto' }}>
                    {r.type} &nbsp; {r.name} &nbsp;→&nbsp; {r.value}
                  </div>
                ))}
              </div>
            </div>
          )}
          {domain.domain_checked_at && (
            <div style={{ fontSize: 10.5, color: '#666' }}>Last checked {new Date(domain.domain_checked_at).toLocaleString()}</div>
          )}
        </div>
      )}
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
