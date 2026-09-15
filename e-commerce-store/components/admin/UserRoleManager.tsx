'use client';

import { useState, useEffect, useCallback } from 'react';
import { inputStyle, buttonGhost, labelStyle, statusPill, adminApiFetch } from '@/components/admin/portalStyles';

/**
 * ROLE MANAGEMENT — super_admin-only view of every `users.role` (migration
 * 00003/00015) plus the recent platform audit trail. Calls
 * `/api/admin/users`, which independently enforces `actorHasPlatformAdminAccess`
 * server-side — this component doesn't try to duplicate that check (no
 * actor-role prop is threaded down from `app/admin/page.tsx`, which this
 * intentionally doesn't touch, per this session's own established pattern
 * of extending via new components rather than editing that 9000+-line
 * file); a non-platform-admin who reaches this tab (e.g. an `owner` session
 * on app.site.com, where `EnterprisePanel` is also mounted) sees a clean
 * "access required" message from the 403 response, not a crash.
 */

type UserRow = { id: string; email: string; role: string };
type AuditLogRow = { id: string; actor: string | null; action: string; detail: Record<string, unknown> | null; created_at: string };

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  owner: 'Owner',
  staff: 'Staff',
  sales: 'Sales (legacy)',
  sales_rep: 'Sales Rep',
  sales_admin: 'Sales Admin',
  deal_desk: 'Deal Desk',
  customer: 'Customer',
};

export default function UserRoleManager() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[] | null>(null);
  const [allowedRoles, setAllowedRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load users.');
        setUsers(null);
        return;
      }
      setUsers(data.users || []);
      setAuditLogs(data.auditLogs || []);
      setAllowedRoles(data.allowedRoles || []);
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateRole = async (userId: string, role: string) => {
    setSavingId(userId);
    setError('');
    try {
      const res = await adminApiFetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not update role.');
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setSavingId('');
    }
  };

  if (loading) return <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>;

  if (error && !users) {
    return <div style={{ fontSize: 12.5, color: '#fca5a5' }}>{error}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <p style={{ fontSize: 11.5, color: '#888', margin: 0 }}>
        Manage platform RBAC roles. `sales_rep`/`sales_admin`/`deal_desk` (migration 00015) grant Sales Hub access;
        `owner`/`staff` grant Merchant Hub access; `super_admin` has system-wide oversight.
      </p>
      {error && <div style={{ fontSize: 12, color: '#fca5a5' }}>{error}</div>}

      <div>
        <h3 style={{ ...labelStyle, marginBottom: 10 }}>Users ({users?.length || 0})</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(users || []).map((u) => (
            <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#0d0d10', borderRadius: 10, border: '1px solid #24242a' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</div>
                <div style={{ marginTop: 4 }}>
                  <span style={statusPill(u.role === 'super_admin' ? '#34d399' : '#93c5fd')}>{ROLE_LABEL[u.role] || u.role}</span>
                </div>
              </div>
              <select
                style={{ ...inputStyle, width: 170 }}
                value={u.role}
                disabled={savingId === u.id}
                onChange={(e) => updateRole(u.id, e.target.value)}
              >
                {allowedRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r] || r}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {users && users.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No users found.</p>}
        </div>
      </div>

      <div style={{ borderTop: '1px solid #2a2a30', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={labelStyle}>Recent Audit Log</h3>
          <button type="button" style={buttonGhost} onClick={load}>
            Refresh
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(auditLogs || []).map((log) => (
            <div key={log.id} style={{ padding: '8px 10px', background: '#0d0d10', borderRadius: 8, border: '1px solid #24242a', fontSize: 11 }}>
              <span style={{ color: '#93c5fd', fontWeight: 600 }}>{log.action}</span>
              {log.actor ? <span style={{ color: '#888' }}> · {log.actor}</span> : null}
              <span style={{ color: '#555' }}> · {new Date(log.created_at).toLocaleString()}</span>
              {log.detail ? <div style={{ color: '#777', marginTop: 3, fontFamily: 'monospace', fontSize: 10 }}>{JSON.stringify(log.detail)}</div> : null}
            </div>
          ))}
          {auditLogs && auditLogs.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No audit entries yet.</p>}
        </div>
      </div>
    </div>
  );
}
