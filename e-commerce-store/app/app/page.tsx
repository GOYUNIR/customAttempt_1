'use client';

/**
 * MERCHANT DASHBOARD (app.<root>/app). A merchant runs THEIR store here.
 *
 * Built ONLY on /api/merchant/* routes, each of which takes the store from the
 * signed-in session (lib/merchant-session.ts) and is covered by
 * scripts/verify-merchant-isolation.ts. Nothing on this page names a store:
 * the server decides whose store it is, every time. A feature appears here
 * only after its route's isolation is proven.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

type Store = { store: { name: string | null; slug: string | null; address: string | null; plan: string | null }; you: { email: string; role: string }; payments: { connected: boolean; status: string; hasAccount: boolean; outstandingRequirements: number } };
type Size = { size: string; price: number | string; mode: 'FCFS' | 'RAFFLE'; stock?: number | string | null; winners?: number | string | null };
type Product = { id: string; name: string; slug: string; tagline: string; description: string; isActive: boolean; isUpcoming: boolean; releaseEndsAt: string; maxPerEmail: number; sizes: Size[] };
type Settings = { brandName: string; hero: { eyebrow: string; headline: string; body: string }; legal: { companyName: string; supportEmail: string; terms: string; privacy: string; shipping: string } };
type Drop = { variantId: string; product: string; size: string; kind: 'raffle' | 'waitlist'; drawAt: string | null; stock: number | null; entries: Record<'pending' | 'winner' | 'charged' | 'declined' | 'cancelled', number> };
type Drops = { drops: Drop[]; recentDraws: { item: string; winners: number; entries: number; at: string }[] };
type Entry = { id: string; email: string; type: string; status: string; submittedAt: string; decidedAt: string | null };
type Staff = { people: { email: string; role: string; name: string | null; since: string; you: boolean }[]; invites: { id: string; email: string; role: string; status: string; expiresAt: string }[] };
type Order = { ref: string; status: string; paymentStatus: string; totalCents: number; currency: string; platformFeeCents: number | null; mode: string | null; createdAt: string; customerEmail: string | null; item: string | null };

// Countries Stripe Connect supports for businesses (a Stripe fact, not branding).
const COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'BE', 'LU', 'ES', 'IT', 'PT', 'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'GR', 'EE', 'LV', 'LT', 'SK', 'SI', 'HU', 'RO', 'BG', 'HR', 'CY', 'MT', 'JP', 'SG', 'HK', 'MY', 'TH', 'MX', 'BR', 'AE'];

const C = { bg: '#0b0b0d', panel: '#141417', line: '#26262b', text: '#ececf0', muted: '#9a9aa3', accent: '#e8e8ec', good: '#3ecf8e', warn: '#f5b84b', bad: '#ff6b6b' };
const card: React.CSSProperties = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#0e0e11', border: `1px solid ${C.line}`, borderRadius: 10, color: C.text, padding: '0 12px', minHeight: 44, fontSize: 16 };
const btn: React.CSSProperties = { minHeight: 44, padding: '0 16px', borderRadius: 999, border: 'none', background: C.accent, color: '#0b0b0d', fontWeight: 700, fontSize: 15, cursor: 'pointer' };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: C.text, border: `1px solid ${C.line}` };
const label: React.CSSProperties = { display: 'block', fontSize: 13, color: C.muted, margin: '10px 0 6px' };

const money = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100); } catch { return (cents / 100).toFixed(2) + ' ' + currency; }
};
const blankProduct = (): Product => ({ id: '', name: '', slug: '', tagline: '', description: '', isActive: false, isUpcoming: false, releaseEndsAt: '', maxPerEmail: 1, sizes: [{ size: 'One Size', price: '', mode: 'FCFS', stock: '' }] });

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string } }> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export default function MerchantDashboard() {
  const [store, setStore] = useState<Store | null>(null);
  const [fatal, setFatal] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<'products' | 'drops' | 'orders' | 'settings' | 'staff'>('products');
  const [drops, setDrops] = useState<Drops | null>(null);
  const [openDrop, setOpenDrop] = useState<Drop | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [staff, setStaff] = useState<Staff | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [country, setCountry] = useState('US');
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    const s = await api<Store>('/api/merchant/store');
    if (s.status === 401) { window.location.assign('/app/login'); return; }
    if (s.status === 403 && s.body.code === 'NOT_A_MERCHANT_SESSION') { window.location.assign('/admin'); return; }
    if (!s.ok) { setFatal(s.body.error || 'Your store could not be loaded.'); return; }
    setStore(s.body);
    const [p, o] = await Promise.all([api<{ products: Product[] }>('/api/merchant/products'), api<{ orders: Order[] }>('/api/merchant/orders')]);
    const [st, d] = await Promise.all([api<Settings>('/api/merchant/settings'), api<Drops>('/api/merchant/drops')]);
    if (st.ok) setSettings(st.body);
    if (d.ok) setDrops(d.body);
    if (p.ok) setProducts(p.body.products || []);
    if (o.ok) setOrders(o.body.orders || []);
    if (s.body.you.role === 'owner') {
      const sf = await api<Staff>('/api/merchant/staff');
      if (sf.ok) setStaff(sf.body);
    }
  }, []);

  const signOut = async () => {
    await api('/api/merchant/signout', { method: 'POST' }).catch(() => null);
    window.location.assign('/app/login');
  };

  const showEntries = async (drop: Drop) => {
    setOpenDrop(drop);
    setEntries([]);
    const r = await api<{ entries: Entry[] }>('/api/merchant/drops/entries?variantId=' + encodeURIComponent(drop.variantId));
    if (r.ok) setEntries(r.body.entries || []); else setNotice(r.body.error || 'Entries could not be loaded.');
  };

  const cancelEntry = async (e: Entry) => {
    if (!window.confirm('Remove ' + e.email + ' from this ' + (openDrop?.kind || 'drop') + '? They will not be drawn or charged.')) return;
    const r = await api('/api/merchant/drops/cancel', { method: 'POST', body: JSON.stringify({ entryId: e.id }) });
    setNotice(r.ok ? 'Entry removed.' : (r.body.error || 'The entry could not be removed.'));
    if (openDrop) showEntries(openDrop);
    load();
  };

  const runDraws = async () => {
    setRunning(true);
    const r = await api<{ skipped: string | null; draws: number; charged: number; declined: number; more: boolean }>('/api/merchant/drops/run', { method: 'POST' });
    setRunning(false);
    if (!r.ok) { setNotice(r.body.error || 'Draws could not be run. Try again.'); return; }
    const b = r.body;
    setNotice(b.skipped ? 'Nothing ran: ' + b.skipped + '.' : `${b.draws} draw(s) run, ${b.charged} charged, ${b.declined} card(s) declined.${b.more ? ' More is due; press again.' : ''}`);
    load();
  };

  const invite = async () => {
    const r = await api<{ emailed: boolean }>('/api/merchant/staff/invite', { method: 'POST', body: JSON.stringify({ email: inviteEmail }) });
    if (!r.ok) { setNotice(r.body.error || 'The invitation could not be sent.'); return; }
    setNotice(r.body.emailed ? 'Invitation sent to ' + inviteEmail + '.' : 'Invitation created, but the email could not be sent. Check your email provider, then revoke and invite again.');
    setInviteEmail('');
    load();
  };

  const revokeInvite = async (id: string) => {
    const r = await api('/api/merchant/staff/revoke-invite', { method: 'POST', body: JSON.stringify({ inviteId: id }) });
    setNotice(r.ok ? 'Invitation revoked.' : (r.body.error || 'The invitation could not be revoked.'));
    load();
  };

  const removeStaff = async (email: string) => {
    if (!window.confirm('Remove ' + email + '? Their account is deleted and they are signed out at once.')) return;
    const r = await api('/api/merchant/staff/remove', { method: 'POST', body: JSON.stringify({ email }) });
    setNotice(r.ok ? email + ' removed.' : (r.body.error || 'That person could not be removed.'));
    load();
  };

  useEffect(() => {
    load();
    try {
      const q = new URLSearchParams(window.location.search).get('payments');
      if (q === 'return') setNotice('Thanks. Stripe is checking your details; payments switch on as soon as it finishes.');
      if (q === 'refresh') setNotice('That Stripe link expired. Start again below.');
      if (q) window.history.replaceState(null, '', '/app');
    } catch { /* ignore */ }
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    const r = await api<{ status: string; url?: string }>('/api/merchant/payments', { method: 'POST', body: JSON.stringify({ country }) });
    setConnecting(false);
    if (r.ok && r.body.url) { window.location.assign(r.body.url); return; }
    if (r.ok && r.body.status === 'ready') { setNotice('Payments are already on.'); load(); return; }
    setNotice(r.body.error || 'Stripe could not be reached. Try again.');
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const payload = {
      ...(editing.id ? { id: editing.id } : {}),
      name: editing.name, slug: editing.slug || undefined, tagline: editing.tagline, description: editing.description,
      isActive: editing.isActive, isUpcoming: editing.isUpcoming, maxPerEmail: Number(editing.maxPerEmail) || 1,
      releaseEndsAt: editing.releaseEndsAt ? new Date(editing.releaseEndsAt).toISOString() : '',
      sizes: editing.sizes.map((s) => ({
        size: s.size, price: Number(s.price), mode: s.mode,
        ...(!editing.id && s.stock !== '' && s.stock !== null && s.stock !== undefined ? { stock: Number(s.stock) } : {}),
        ...(s.mode === 'RAFFLE' && s.winners ? { winners: Number(s.winners) } : {}),
      })),
    };
    const r = await api<{ product: Product }>('/api/merchant/products', { method: 'POST', body: JSON.stringify(payload) });
    setSaving(false);
    if (!r.ok) { setNotice(r.body.error || 'The product could not be saved.'); return; }
    setNotice(editing.id ? 'Saved.' : 'Product created.');
    setEditing(null);
    load();
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    const r = await api<{ saved: boolean }>('/api/merchant/settings', { method: 'POST', body: JSON.stringify(settings) });
    setSaving(false);
    setNotice(r.ok ? 'Settings saved. Your store shows them within a minute.' : (r.body.error || 'Settings could not be saved.'));
  };

  const toLocalInput = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const countryName = useMemo(() => {
    try { const dn = new Intl.DisplayNames(undefined, { type: 'region' }); return (c: string) => dn.of(c) || c; } catch { return (c: string) => c; }
  }, []);

  if (fatal) return <main style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: 24, fontFamily: 'system-ui, sans-serif' }}><p>{fatal}</p><a href="/app/login" style={{ color: C.accent }}>Sign in again</a></main>;
  if (!store) return <main style={{ minHeight: '100vh', background: C.bg, color: C.muted, padding: 24, fontFamily: 'system-ui, sans-serif' }}>Loading your store…</main>;

  const pay = store.payments;
  return (
    <main style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: 'system-ui, -apple-system, sans-serif', padding: '20px 16px 60px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 13, color: C.muted, letterSpacing: 1, textTransform: 'uppercase' }}>Your store</div>
            <h1 style={{ margin: '4px 0 0', fontSize: 26 }}>{store.store.name}</h1>
            {store.store.address && <a href={store.store.address} target="_blank" rel="noreferrer" style={{ color: C.muted, fontSize: 14 }}>{store.store.address.replace('https://', '')}</a>}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, color: C.muted }}>
            <span>{store.you.email} · {store.you.role}</span>
            <button onClick={signOut} style={{ ...ghost, minHeight: 36, padding: '0 12px', fontSize: 14 }}>Sign out</button>
          </div>
        </header>

        {store.you.role === 'support' && <div role="note" style={{ ...card, borderColor: C.warn }}>Support session: you are acting inside this store. Everything you change is recorded under your name. Payments and staff stay with the owner.</div>}

        {notice && <div role="status" style={{ ...card, borderColor: C.warn, color: C.text }}>{notice} <button onClick={() => setNotice('')} style={{ ...ghost, minHeight: 32, padding: '0 10px', marginLeft: 8 }}>Dismiss</button></div>}

        <section style={card} aria-label="Payments">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 700 }}>Payments</div>
              <div style={{ color: pay.connected ? C.good : C.warn, fontSize: 14, marginTop: 4 }}>
                {pay.connected ? 'On. Customers pay straight into your Stripe account.' : pay.hasAccount ? 'Stripe needs a few more details before you can take payments.' : 'Not connected yet. Your store cannot take orders until it is.'}
              </div>
            </div>
            {!pay.connected && store.you.role === 'owner' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {!pay.hasAccount && (
                  <select aria-label="Country your business is registered in" value={country} onChange={(e) => setCountry(e.target.value)} style={{ ...input, width: 'auto', minWidth: 180 }}>
                    {COUNTRIES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
                  </select>
                )}
                <button onClick={connect} disabled={connecting} style={btn}>{connecting ? 'Opening Stripe…' : pay.hasAccount ? 'Continue with Stripe' : 'Connect payments'}</button>
              </div>
            )}
          </div>
        </section>

        <nav style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {(['products', 'drops', 'orders', 'settings', ...(store.you.role === 'owner' ? ['staff' as const] : [])] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setOpenDrop(null); }} style={tab === t ? btn : ghost}>{t === 'products' ? `Products (${products.length})` : t === 'drops' ? `Raffles & waitlists (${drops?.drops.length ?? 0})` : t === 'orders' ? `Orders (${orders.length})` : t === 'staff' ? 'Staff' : 'Settings'}</button>
          ))}
        </nav>

        {tab === 'drops' && !openDrop && (
          <section style={card} aria-label="Raffles and waitlists">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>Raffles &amp; waitlists</div>
              <button style={btn} onClick={runDraws} disabled={running}>{running ? 'Running…' : 'Run due draws now'}</button>
            </div>
            <p style={{ color: C.muted, fontSize: 13, marginTop: 0 }}>Draws also run by themselves after their draw date. Running now only does what is already due.</p>
            {(!drops || drops.drops.length === 0) && <p style={{ color: C.muted }}>No raffles or waitlists yet. Make a size a raffle, or mark a product coming soon.</p>}
            {drops?.drops.map((d) => (
              <div key={d.variantId} style={{ borderTop: `1px solid ${C.line}`, padding: '12px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{d.product} · {d.size} <span style={{ fontSize: 12, color: C.muted, marginLeft: 6 }}>{d.kind}</span></div>
                  {d.drawAt && <div style={{ color: C.muted, fontSize: 13 }}>Draw: {new Date(d.drawAt).toLocaleString()}</div>}
                  <div style={{ color: C.muted, fontSize: 13 }}>{`${d.entries.pending} waiting · ${d.entries.winner} won · ${d.entries.charged} paid · ${d.entries.declined} declined · ${d.stock ?? '?'} left`}</div>
                </div>
                <button style={ghost} onClick={() => showEntries(d)}>Entries</button>
              </div>
            ))}
            {drops && drops.recentDraws.length > 0 && (
              <>
                <div style={{ fontWeight: 700, marginTop: 18 }}>Recent draws</div>
                {drops.recentDraws.map((r, i) => <div key={i} style={{ color: C.muted, fontSize: 13, padding: '6px 0' }}>{`${new Date(r.at).toLocaleString()} · ${r.item} · ${r.winners} winner(s) from ${r.entries}`}</div>)}
              </>
            )}
          </section>
        )}

        {tab === 'drops' && openDrop && (
          <section style={card} aria-label="Entries">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{openDrop.product} · {openDrop.size}</div>
              <button style={ghost} onClick={() => setOpenDrop(null)}>Back</button>
            </div>
            {entries.length === 0 && <p style={{ color: C.muted }}>No entries.</p>}
            {entries.map((e) => (
              <div key={e.id} style={{ borderTop: `1px solid ${C.line}`, padding: '10px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 600 }}>{e.email}</div>
                  <div style={{ color: C.muted, fontSize: 13 }}>{e.status}{e.type === 'waitlist' ? ' · waitlist' : ''} · {new Date(e.submittedAt).toLocaleString()}</div>
                </div>
                {e.status === 'pending' && <button style={ghost} onClick={() => cancelEntry(e)}>Remove</button>}
              </div>
            ))}
          </section>
        )}

        {tab === 'staff' && staff && (
          <section style={card} aria-label="Staff">
            <div style={{ fontWeight: 700 }}>People who can run this store</div>
            {staff.people.map((p) => (
              <div key={p.email} style={{ borderTop: `1px solid ${C.line}`, padding: '10px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{p.email} <span style={{ color: C.muted, fontSize: 13 }}>· {p.role}{p.you ? ' (you)' : ''}</span></div>
                {p.role === 'staff' && !p.you && <button style={ghost} onClick={() => removeStaff(p.email)}>Remove</button>}
              </div>
            ))}
            <div style={{ fontWeight: 700, marginTop: 18 }}>Invite staff</div>
            <p style={{ color: C.muted, fontSize: 13, margin: '6px 0 0' }}>Staff can manage products, raffles, orders and settings. Only you can connect payments or manage staff.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <input type="email" aria-label="Email to invite" placeholder="name@example.com" style={{ ...input, flex: '1 1 220px', width: 'auto' }} value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              <button style={btn} onClick={invite} disabled={!inviteEmail}>Send invitation</button>
            </div>
            {staff.invites.filter((i) => i.status === 'pending').map((i) => (
              <div key={i.id} style={{ borderTop: `1px solid ${C.line}`, marginTop: 10, padding: '10px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{i.email} <span style={{ color: C.muted, fontSize: 13 }}>· invited, expires {new Date(i.expiresAt).toLocaleDateString()}</span></div>
                <button style={ghost} onClick={() => revokeInvite(i.id)}>Revoke</button>
              </div>
            ))}
          </section>
        )}

        {tab === 'products' && !editing && (
          <section style={card} aria-label="Products">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>Products</div>
              <button style={btn} onClick={() => setEditing(blankProduct())}>New product</button>
            </div>
            {products.length === 0 && <p style={{ color: C.muted }}>No products yet.</p>}
            {products.map((p) => (
              <div key={p.id} style={{ borderTop: `1px solid ${C.line}`, padding: '12px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{p.name} <span style={{ fontSize: 12, color: p.isActive ? C.good : C.muted, marginLeft: 6 }}>{p.isActive ? (p.isUpcoming ? 'coming soon' : 'on sale') : p.isUpcoming ? 'coming soon' : 'hidden'}</span></div>
                  {p.sizes.map((s) => <div key={s.size} style={{ color: C.muted, fontSize: 13 }}>{`${s.size} · ${Number(s.price).toFixed(2)} · ${s.mode === 'RAFFLE' ? 'raffle' : 'instant buy'} · ${s.stock ?? '?'} left`}</div>)}
                </div>
                <button style={ghost} onClick={() => setEditing({ ...p, releaseEndsAt: toLocalInput(p.releaseEndsAt), sizes: p.sizes.map((s) => ({ ...s })) })}>Edit</button>
              </div>
            ))}
          </section>
        )}

        {tab === 'products' && editing && (
          <section style={card} aria-label={editing.id ? 'Edit product' : 'New product'}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{editing.id ? 'Edit product' : 'New product'}</div>
            <label style={label}>Name<input style={input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            {!editing.id && <label style={label}>Web address (optional; made from the name)<input style={input} value={editing.slug} placeholder="summer-tee" onChange={(e) => setEditing({ ...editing, slug: e.target.value })} /></label>}
            <label style={label}>Tagline<input style={input} value={editing.tagline} onChange={(e) => setEditing({ ...editing, tagline: e.target.value })} /></label>
            <label style={label}>Description<textarea style={{ ...input, minHeight: 90, paddingTop: 10 }} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} style={{ width: 20, height: 20 }} /> On sale</label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={editing.isUpcoming} onChange={(e) => setEditing({ ...editing, isUpcoming: e.target.checked })} style={{ width: 20, height: 20 }} /> Coming soon (takes waitlist sign-ups)</label>
            </div>
            <label style={label}>Limit per customer<input type="number" min={1} max={100} style={input} value={editing.maxPerEmail} onChange={(e) => setEditing({ ...editing, maxPerEmail: Number(e.target.value) })} /></label>
            {editing.sizes.some((s) => s.mode === 'RAFFLE') && <label style={label}>Raffle draw date<input type="datetime-local" style={input} value={editing.releaseEndsAt} onChange={(e) => setEditing({ ...editing, releaseEndsAt: e.target.value })} /></label>}
            <div style={{ ...label, marginTop: 16 }}>Sizes</div>
            {editing.sizes.map((s, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
                <input aria-label="Size name" style={input} value={s.size} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, size: e.target.value }; setEditing({ ...editing, sizes }); }} />
                <input aria-label="Price" type="number" step="0.01" min="0.5" placeholder="Price" style={input} value={s.price} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, price: e.target.value }; setEditing({ ...editing, sizes }); }} />
                <select aria-label="Sale type" style={input} value={s.mode} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, mode: e.target.value as Size['mode'] }; setEditing({ ...editing, sizes }); }}>
                  <option value="FCFS">Instant buy</option><option value="RAFFLE">Raffle</option>
                </select>
                {editing.id
                  ? <div style={{ ...input, display: 'flex', alignItems: 'center', color: C.muted }}>{s.stock ?? 0} in stock</div>
                  : <input aria-label="Starting stock" type="number" min="0" placeholder="Stock" style={input} value={s.stock ?? ''} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, stock: e.target.value }; setEditing({ ...editing, sizes }); }} />}
                {s.mode === 'RAFFLE' && <input aria-label="Winners per draw" type="number" min="1" placeholder="Winners" style={input} value={s.winners ?? ''} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, winners: e.target.value }; setEditing({ ...editing, sizes }); }} />}
              </div>
            ))}
            {!editing.id && editing.sizes.length < 10 && <button style={ghost} onClick={() => setEditing({ ...editing, sizes: [...editing.sizes, { size: '', price: '', mode: 'FCFS', stock: '' }] })}>Add a size</button>}
            {editing.id && <p style={{ color: C.muted, fontSize: 13 }}>Changing stock after creation is coming with the stock tools.</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button style={btn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button style={ghost} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </section>
        )}

        {tab === 'settings' && settings && (
          <section style={card} aria-label="Settings">
            <div style={{ fontWeight: 700 }}>Store</div>
            <label style={label}>Store name shown to customers<input style={input} value={settings.brandName} onChange={(e) => setSettings({ ...settings, brandName: e.target.value })} /></label>
            <label style={label}>Homepage line above the headline<input style={input} value={settings.hero.eyebrow} onChange={(e) => setSettings({ ...settings, hero: { ...settings.hero, eyebrow: e.target.value } })} /></label>
            <label style={label}>Homepage headline<input style={input} value={settings.hero.headline} onChange={(e) => setSettings({ ...settings, hero: { ...settings.hero, headline: e.target.value } })} /></label>
            <label style={label}>Homepage text<textarea style={{ ...input, minHeight: 70, paddingTop: 10 }} value={settings.hero.body} onChange={(e) => setSettings({ ...settings, hero: { ...settings.hero, body: e.target.value } })} /></label>
            <div style={{ fontWeight: 700, marginTop: 18 }}>Policies</div>
            <p style={{ color: C.muted, fontSize: 13, margin: '6px 0 0' }}>Shown at /terms, /privacy and /shipping on your store. Until you add one, that page says it has not been published.</p>
            <label style={label}>Business name<input style={input} value={settings.legal.companyName} onChange={(e) => setSettings({ ...settings, legal: { ...settings.legal, companyName: e.target.value } })} /></label>
            <label style={label}>Contact email for customers<input type="email" style={input} value={settings.legal.supportEmail} onChange={(e) => setSettings({ ...settings, legal: { ...settings.legal, supportEmail: e.target.value } })} /></label>
            {(['terms', 'privacy', 'shipping'] as const).map((k) => (
              <label key={k} style={label}>{k === 'terms' ? 'Terms of service' : k === 'privacy' ? 'Privacy policy' : 'Shipping & sales policy'}<textarea style={{ ...input, minHeight: 120, paddingTop: 10 }} value={settings.legal[k]} onChange={(e) => setSettings({ ...settings, legal: { ...settings.legal, [k]: e.target.value } })} /></label>
            ))}
            <div style={{ marginTop: 14 }}><button style={btn} onClick={saveSettings} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
          </section>
        )}

        {tab === 'orders' && (
          <section style={card} aria-label="Orders">
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Orders</div>
            {orders.length === 0 && <p style={{ color: C.muted }}>No orders yet.</p>}
            {orders.map((o) => (
              <div key={o.ref} style={{ borderTop: `1px solid ${C.line}`, padding: '10px 0', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{o.ref} <span style={{ color: C.muted, fontWeight: 400, fontSize: 13 }}>{o.mode || ''}</span></div>
                  <div style={{ color: C.muted, fontSize: 13 }}>{o.item || ''}{o.customerEmail ? ' · ' + o.customerEmail : ''}</div>
                  <div style={{ color: C.muted, fontSize: 12 }}>{new Date(o.createdAt).toLocaleString()}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>{money(o.totalCents, o.currency)}</div>
                  <div style={{ color: C.muted, fontSize: 12 }}>{o.paymentStatus}{o.platformFeeCents ? ' · fee ' + money(o.platformFeeCents, o.currency) : ''}</div>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
