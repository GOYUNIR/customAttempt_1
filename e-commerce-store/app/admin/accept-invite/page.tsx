'use client';

import { useEffect, useState, type FormEvent } from 'react';

/**
 * /admin/accept-invite — where an invited staff member sets their password.
 *
 * Reachable with NO session by design (see lib/staff-realms.ts's
 * STAFF_INVITE_PATHS): the person using it has no account yet. The token in the
 * URL is the credential.
 *
 * The invite is LOOKED UP before the form is shown, so the invitee can see
 * which address and which role they are accepting. An invitation that does not
 * say what access it grants is how someone is talked into accepting more than
 * they meant to.
 */

const inputStyle = { padding: '13px 14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 15, width: '100%', boxSizing: 'border-box' } as const;
const labelStyle = { fontSize: 13, fontWeight: 700, color: '#374151' } as const;
const hintStyle = { fontSize: 12.5, color: '#6b7280', margin: 0, lineHeight: 1.55 } as const;
const cardStyle = { background: '#fff', borderRadius: 18, padding: '28px 26px', boxShadow: '0 8px 30px rgba(0,0,0,0.07)', display: 'grid', gap: 16 } as const;

type InviteInfo = { email: string; role: string; invitedBy: string; expiresAt: string };

export default function AcceptInvitePage() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fullName, setFullName] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ signInAt: string } | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    if (!t) {
      setLoadError('This link is missing its invitation code.');
      setLoading(false);
      return;
    }
    fetch(`/api/admin/accept-invite?token=${encodeURIComponent(t)}`, { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) setInfo(data as InviteInfo);
        else setLoadError(String(data?.error || 'This invitation is not valid.'));
      })
      .catch(() => setLoadError('Could not reach the server. Check your connection and try again.'))
      .finally(() => setLoading(false));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return;
    }
    // Checked here as well as server-side: a typo in a password nobody can see
    // would otherwise lock the invitee out of the account they just created,
    // with no way to reset it.
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, fullName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(String(data?.error || 'Could not complete the invitation.'));
        return;
      }
      setDone({ signInAt: String(data.signInAt || '/admin/login') });
    } catch {
      setError('Network error — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f2f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '48px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        {loading ? (
          <div style={cardStyle}><p style={hintStyle}>Checking your invitation…</p></div>
        ) : done ? (
          <div style={cardStyle}>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#111' }}>You&apos;re all set</h1>
            <p style={hintStyle}>Your account is ready. Sign in to get started.</p>
            <a href={done.signInAt} style={{ background: '#111', color: '#fff', borderRadius: 999, padding: '14px 20px', fontSize: 15, fontWeight: 800, textAlign: 'center', textDecoration: 'none' }}>
              Go to sign-in
            </a>
          </div>
        ) : loadError ? (
          <div style={cardStyle}>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: '#111' }}>This invitation can&apos;t be used</h1>
            <p style={{ margin: 0, color: '#b91c1c', fontSize: 13.5, lineHeight: 1.5, background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>{loadError}</p>
            <p style={hintStyle}>If you think this is a mistake, ask whoever invited you to send a new invitation.</p>
          </div>
        ) : (
          <form onSubmit={submit} style={cardStyle}>
            <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#111' }}>Accept your invitation</h1>
              <p style={hintStyle}>
                <strong>{info?.invitedBy}</strong> invited you to join as <strong>{info?.role}</strong>.
              </p>
            </div>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '11px 13px' }}>
              <p style={{ ...hintStyle, fontWeight: 700, color: '#0f172a' }}>{info?.email}</p>
              <p style={hintStyle}>This is the address your account will use. It cannot be changed here.</p>
            </div>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Your name <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></span>
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Alex Rivera" autoComplete="name" style={inputStyle} />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Choose a password</span>
              <div style={{ position: 'relative' }}>
                <input
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="at least 8 characters"
                  autoComplete="new-password"
                  autoFocus
                  style={{ ...inputStyle, paddingRight: 60 }}
                />
                <button type="button" onClick={() => setShow((s) => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, fontSize: 12, fontWeight: 700, color: '#6b7280' }}>
                  {show ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Confirm password</span>
              <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" style={inputStyle} />
            </label>

            {error && (
              <p style={{ margin: 0, color: '#b91c1c', fontSize: 13, lineHeight: 1.5, background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>{error}</p>
            )}

            <button type="submit" disabled={busy} style={{ background: '#111', color: '#fff', border: 'none', borderRadius: 999, padding: '14px 20px', fontSize: 15, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Creating your account…' : 'Create my account'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
