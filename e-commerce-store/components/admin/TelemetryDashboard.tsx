'use client';

import { useState, useEffect, useCallback } from 'react';
import { DashboardGrid } from '@/components/admin/PortalShell';
import { statusPill, adminApiFetch } from '@/components/admin/portalStyles';

/**
 * TELEMETRY DASHBOARD — real cards fed by real data, not fabricated
 * numbers: `lib/system-diagnostics.ts`'s `runAllHealthChecks()` (already
 * built, already backing `/api/admin/system-health` and
 * `scripts/production-readiness-check.ts`) for system-health tiles, plus
 * `/api/admin/telemetry`'s live order/raffle-entry counts for a "today"
 * tile.
 */

type Check = { id: string; label: string; status: 'ok' | 'warning' | 'error' | 'not_configured'; detail: string };

const STATUS_COLOR: Record<Check['status'], string> = { ok: '#34d399', warning: '#fbbf24', error: '#f87171', not_configured: '#6b7280' };

export default function TelemetryDashboard() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [telemetry, setTelemetry] = useState<{ ordersToday: number; pendingRaffleEntries: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [healthRes, telemetryRes] = await Promise.all([
        adminApiFetch('/api/admin/system-health'),
        adminApiFetch('/api/admin/telemetry'),
      ]);
      const health = await healthRes.json();
      const telem = await telemetryRes.json();
      if (healthRes.ok) setChecks(health.checks || []);
      if (telemetryRes.ok) setTelemetry({ ordersToday: telem.ordersToday || 0, pendingRaffleEntries: telem.pendingRaffleEntries || 0 });
    } catch {
      /* tiles just stay in their loading/empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p style={{ fontSize: 12, color: '#888' }}>Loading telemetry…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <DashboardGrid>
        <TelemetryCard label="Orders today" value={String(telemetry?.ordersToday ?? '—')} />
        <TelemetryCard label="Pending raffle entries" value={String(telemetry?.pendingRaffleEntries ?? '—')} />
        {(checks || []).map((check) => (
          <TelemetryCard key={check.id} label={check.label} value={check.status.replace('_', ' ')} color={STATUS_COLOR[check.status]} detail={check.detail} />
        ))}
      </DashboardGrid>
      <button type="button" onClick={load} style={{ alignSelf: 'flex-start', padding: '7px 14px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: '1px solid #303036', background: 'transparent', color: '#ccc' }}>
        Refresh
      </button>
    </div>
  );
}

function TelemetryCard({ label, value, color, detail }: { label: string; value: string; color?: string; detail?: string }) {
  return (
    <div style={{ padding: '16px 16px', borderRadius: 14, background: '#141417', border: '1px solid #24242a' }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#8b95a7', marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 800, textTransform: 'capitalize', color: color || '#e5e5e8' }}>{value}</span>
        {color && <span style={statusPill(color)}>●</span>}
      </div>
      {detail && <div style={{ fontSize: 10.5, color: '#666', marginTop: 6, lineHeight: 1.5 }}>{detail}</div>}
    </div>
  );
}
