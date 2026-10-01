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
type Product = { id: string; name: string; slug: string; tagline: string; description: string; isActive: boolean; isUpcoming: boolean; releaseEndsAt: string; maxPerEmail: number; sizes: Size[]; images?: string[] };
type Settings = { brandName: string; hero: { eyebrow: string; headline: string; body: string }; legal: { companyName: string; supportEmail: string; terms: string; privacy: string; shipping: string } };
type Drop = { variantId: string; product: string; size: string; kind: 'raffle' | 'waitlist'; drawAt: string | null; stock: number | null; entries: Record<'pending' | 'winner' | 'charged' | 'declined' | 'cancelled', number> };
type Drops = { drops: Drop[]; recentDraws: { item: string; winners: number; entries: number; at: string }[] };
type Entry = { id: string; email: string; type: string; status: string; submittedAt: string; decidedAt: string | null };
type Staff = { people: { email: string; role: string; name: string | null; since: string; you: boolean }[]; invites: { id: string; email: string; role: string; status: string; expiresAt: string }[] };
type StockSize = { size: string; variantId: string | null; onHand: number; held: number; available: number; tracked: boolean };
type StockView = { products: { productId: string; name: string; sizes: StockSize[] }[]; oversold: { variantId: string; item: string; shortfall: number; reference: string; at: string }[] };
type StockMove = { reason: string; change: number; after: number; shortfall: number; by: string | null; note: string | null; reference: string | null; at: string };
type Billing = { planId: string; planName: string; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceUntil: string | null; hasBillingAccount: boolean; feeLine: string; upgrade: { planId: string; name: string; monthlyCents: number } | null };
type AddressView = { current: { slug: string; url: string }; changesLeft: number; holdDays: number; candidate?: { slug: string; url: string; available: boolean; reason: string } };
type DomainsView = { plan: string; limit: number | null; used: number; domains: { hostname: string; status: string; ssl: string; ownershipVerified: boolean; primary: boolean; checkedAt: string | null; records: { type: string; name: string; value: string; why: string }[] }[] };
type Order = { ref: string; status: string; paymentStatus: string; totalCents: number; currency: string; platformFeeCents: number | null; mode: string | null; createdAt: string; customerEmail: string | null; item: string | null };

// Countries Stripe Connect supports for businesses (a Stripe fact, not branding).
const COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'NL', 'BE', 'LU', 'ES', 'IT', 'PT', 'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'GR', 'EE', 'LV', 'LT', 'SK', 'SI', 'HU', 'RO', 'BG', 'HR', 'CY', 'MT', 'JP', 'SG', 'HK', 'MY', 'TH', 'MX', 'BR', 'AE'];

const C = { bg: '#0b0b0d', panel: '#141417', line: '#26262b', text: '#ececf0', muted: '#9a9aa3', accent: '#e8e8ec', good: '#3ecf8e', warn: '#f5b84b', bad: '#ff6b6b' };
const card: React.CSSProperties = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#0e0e11', border: `1px solid ${C.line}`, borderRadius: 10, color: C.text, padding: '0 12px', minHeight: 44, fontSize: 16 };
const btn: React.CSSProperties = { minHeight: 44, padding: '0 16px', borderRadius: 999, border: 'none', background: C.accent, color: '#0b0b0d', fontWeight: 700, fontSize: 15, cursor: 'pointer' };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: C.text, border: `1px solid ${C.line}` };
// Navigation, not an action: the selected tab must never look like the screen's
// one primary (filled) button, or every screen shows two "do this" pills.
const tabOff: React.CSSProperties = { ...ghost, border: '1px solid transparent', color: C.muted, fontWeight: 600 };
const tabOn: React.CSSProperties = { ...ghost, background: C.panel, borderColor: C.line, color: C.text };
const label: React.CSSProperties = { display: 'block', fontSize: 13, color: C.muted, margin: '10px 0 6px' };

const money = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100); } catch { return (cents / 100).toFixed(2) + ' ' + currency; }
};
const blankProduct = (): Product => ({ id: '', name: '', slug: '', tagline: '', description: '', isActive: false, isUpcoming: false, releaseEndsAt: '', maxPerEmail: 1, sizes: [{ size: 'One Size', price: '', mode: 'FCFS', stock: '' }], images: [] });

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
  const [tab, setTab] = useState<'products' | 'drops' | 'orders' | 'settings' | 'staff' | 'billing'>('products');
  const [drops, setDrops] = useState<Drops | null>(null);
  const [openDrop, setOpenDrop] = useState<Drop | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [staff, setStaff] = useState<Staff | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [stock, setStock] = useState<StockView | null>(null);
  const [stockEdit, setStockEdit] = useState<Record<string, { count: string; delta: string; reason: string; note: string }>>({});
  const [history, setHistory] = useState<{ variantId: string; rows: StockMove[] } | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [country, setCountry] = useState('US');
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState<AddressView | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [addressBusy, setAddressBusy] = useState(false);
  const [domainsView, setDomainsView] = useState<DomainsView | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);

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
    const sk = await api<StockView>('/api/merchant/stock');
    if (sk.ok) setStock(sk.body);
    if (s.body.you.role === 'owner') {
      const sf = await api<Staff>('/api/merchant/staff');
      if (sf.ok) setStaff(sf.body);
      const ad = await api<AddressView>('/api/merchant/address');
      if (ad.ok) setAddress(ad.body);
      const dm = await api<DomainsView>('/api/merchant/domains');
      if (dm.ok) setDomainsView(dm.body);
      const bl = await api<Billing>('/api/merchant/billing');
      if (bl.ok) setBilling(bl.body);
    }
  }, []);

  const stockFor = (productId: string, size: string) => stock?.products.find((p) => p.productId === productId)?.sizes.find((z) => z.size === size) || null;
  const editOf = (variantId: string) => stockEdit[variantId] || { count: '', delta: '', reason: 'restock', note: '' };
  const putEdit = (variantId: string, patch: Partial<{ count: string; delta: string; reason: string; note: string }>) => setStockEdit({ ...stockEdit, [variantId]: { ...editOf(variantId), ...patch } });
  const refreshStock = async () => { const sk = await api<StockView>('/api/merchant/stock'); if (sk.ok) setStock(sk.body); };

  const countStock = async (variantId: string) => {
    const e = editOf(variantId);
    const r = await api<{ onHand: number; held: number; available: number; before: number }>('/api/merchant/stock/set', { method: 'POST', body: JSON.stringify({ variantId, count: e.count, note: e.note }) });
    setNotice(r.ok ? `Count saved: ${r.body.onHand} on hand${r.body.held ? `, ${r.body.held} in open checkouts` : ''}, ${r.body.available} available.` : (r.body.error || 'The count could not be saved.'));
    if (r.ok) { putEdit(variantId, { count: '', note: '' }); await refreshStock(); }
  };

  const adjust = async (variantId: string, sign: 1 | -1) => {
    const e = editOf(variantId);
    const n = Math.abs(Number(e.delta));
    const reason = sign > 0 ? 'restock' : (e.reason === 'restock' ? 'adjust' : e.reason);
    const r = await api<{ onHand: number; held: number; available: number }>('/api/merchant/stock/adjust', { method: 'POST', body: JSON.stringify({ variantId, delta: sign * n, reason, note: e.note }) });
    setNotice(r.ok ? `Stock ${sign > 0 ? 'added' : 'removed'}: ${r.body.onHand} on hand, ${r.body.available} available.` : (r.body.error || 'Stock could not be changed.'));
    if (r.ok) { putEdit(variantId, { delta: '', note: '' }); await refreshStock(); }
  };

  const showHistory = async (variantId: string) => {
    if (history?.variantId === variantId) { setHistory(null); return; }
    const r = await api<{ history: StockMove[] }>('/api/merchant/stock/history?variantId=' + encodeURIComponent(variantId));
    if (r.ok) setHistory({ variantId, rows: r.body.history || [] }); else setNotice(r.body.error || 'History could not be loaded.');
  };

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
      if (q === 'return') {
        setNotice('Thanks. Stripe is checking your details; this page updates by itself when it finishes (usually a few minutes).');
        // Poll for about 2 minutes so "checking your details" never has to be
        // cleared by a reload. Stops as soon as payments are on.
        let tries = 0;
        const timer = window.setInterval(async () => {
          tries += 1;
          const s = await api<Store>('/api/merchant/store').catch(() => null);
          if (s?.ok) setStore(s.body);
          if (s?.ok && s.body.payments.connected) {
            window.clearInterval(timer);
            setNotice('Payments are on. Your store can take orders.');
          } else if (tries >= 24) {
            window.clearInterval(timer);
            setNotice('Stripe is still checking your details. Payments switch on as soon as it finishes; reload this page later to see it.');
          }
        }, 5000);
      }
      if (q === 'refresh') setNotice('That Stripe link expired. Start again below.');
      const b = new URLSearchParams(window.location.search).get('billing');
      if (b === 'success') { setTab('billing'); setNotice('Payment received. Your plan switches as soon as Stripe confirms it, usually within a minute.'); setTimeout(() => { load(); }, 5000); }
      if (b === 'cancel') { setTab('billing'); setNotice('No change made. You are still on your current plan.'); }
      if (q || b) window.history.replaceState(null, '', '/app');
    } catch { /* ignore */ }
  }, [load]);

  const billingGo = async (path: string) => {
    setBillingBusy(true);
    const r = await api<{ url?: string }>(path, { method: 'POST' });
    setBillingBusy(false);
    if (r.ok && r.body.url) { window.location.assign(r.body.url); return; }
    setNotice(r.body.error || 'Stripe could not be reached. Try again.');
  };

  const connect = async () => {
    setConnecting(true);
    const r = await api<{ status: string; url?: string }>('/api/merchant/payments', { method: 'POST', body: JSON.stringify({ country }) });
    setConnecting(false);
    if (r.ok && r.body.url) { window.location.assign(r.body.url); return; }
    if (r.ok && r.body.status === 'ready') { setNotice('Payments are already on.'); load(); return; }
    setNotice(r.body.error || 'Stripe could not be reached. Try again.');
  };

  // Photos go through the server (checked, stored in this store's own folder);
  // the returned address is added to the product, which is saved with Save.
  const [uploading, setUploading] = useState(false);
  const addPhotos = async (files: FileList | null) => {
    if (!editing || !files || files.length === 0) return;
    setUploading(true);
    let images = [...(editing.images || [])];
    for (const f of Array.from(files)) {
      if (images.length >= 8) { setNotice('A product can have up to 8 photos.'); break; }
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch('/api/merchant/media', { method: 'POST', body: fd, credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.url) images = [...images, body.url];
      else { setNotice((body.error || 'That photo could not be uploaded.') + ' (' + f.name + ')'); break; }
    }
    setEditing((cur) => (cur ? { ...cur, images } : cur));
    setUploading(false);
  };

  // Live availability, 300 ms after typing stops.
  useEffect(() => {
    if (!address || !addressInput.trim()) return;
    const t = window.setTimeout(async () => {
      const r = await api<AddressView>('/api/merchant/address?slug=' + encodeURIComponent(addressInput));
      if (r.ok) setAddress((cur) => (cur ? { ...cur, candidate: r.body.candidate, changesLeft: r.body.changesLeft } : r.body));
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressInput]);

  const domainCall = async (method: string, body?: object, query = '') => {
    setDomainBusy(true);
    const r = await api<DomainsView>('/api/merchant/domains' + query, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    setDomainBusy(false);
    if (r.ok) { setDomainsView(r.body); return true; }
    setNotice(r.body.error || 'That did not work. Try again.');
    return false;
  };

  const changeAddress = async () => {
    const next = address?.candidate;
    if (!next?.available) return;
    setAddressBusy(true);
    const r = await api<{ url: string; previous: string; holdDays: number }>('/api/merchant/address', { method: 'POST', body: JSON.stringify({ slug: next.slug }) });
    setAddressBusy(false);
    if (r.ok) {
      setNotice(`Your store is now at ${r.body.url}. ${r.body.previous} sends visitors there for ${r.body.holdDays} days. It can take a minute to reach everyone.`);
      setAddressInput('');
      load();
    } else setNotice(r.body.error || 'The address could not be changed.');
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const payload = {
      ...(editing.id ? { id: editing.id } : {}),
      name: editing.name, slug: editing.slug || undefined, tagline: editing.tagline, description: editing.description,
      images: editing.images || [],
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
          {(['products', 'drops', 'orders', 'settings', ...(store.you.role === 'owner' ? ['staff' as const, 'billing' as const] : [])] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setOpenDrop(null); }} aria-current={tab === t ? 'page' : undefined} style={tab === t ? tabOn : tabOff}>{t === 'products' ? `Products (${products.length})` : t === 'drops' ? `Raffles & waitlists (${drops?.drops.length ?? 0})` : t === 'orders' ? `Orders (${orders.length})` : t === 'staff' ? 'Staff' : t === 'billing' ? 'Plan & billing' : 'Settings'}</button>
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

        {tab === 'billing' && billing && (
          <section style={card} aria-label="Plan and billing">
            <div style={{ fontWeight: 700 }}>Your plan: {billing.planName}</div>
            <div style={{ color: C.muted, fontSize: 14, marginTop: 4 }}>{billing.feeLine}</div>
            {billing.status === 'past_due' && billing.graceUntil && (
              <div role="alert" style={{ color: C.warn, fontSize: 14, marginTop: 10 }}>{`Your last payment for ${billing.planName} failed. Update your card by ${new Date(billing.graceUntil).toLocaleDateString()} or the store moves to Free and per-sale fees apply again.`}</div>
            )}
            {billing.cancelAtPeriodEnd && billing.currentPeriodEnd && (
              <div style={{ color: C.muted, fontSize: 14, marginTop: 10 }}>{`Cancelled. ${billing.planName} stays on until ${new Date(billing.currentPeriodEnd).toLocaleDateString()}, then the store moves to Free.`}</div>
            )}
            {!billing.cancelAtPeriodEnd && billing.status === 'active' && billing.currentPeriodEnd && (
              <div style={{ color: C.muted, fontSize: 14, marginTop: 10 }}>{`Renews ${new Date(billing.currentPeriodEnd).toLocaleDateString()}.`}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {billing.upgrade && <button style={btn} disabled={billingBusy} onClick={() => billingGo('/api/merchant/billing/checkout')}>{`Switch to ${billing.upgrade.name}: ${money(billing.upgrade.monthlyCents, 'usd')}/month, no per-sale fee`}</button>}
              {billing.hasBillingAccount && <button style={ghost} disabled={billingBusy} onClick={() => billingGo('/api/merchant/billing/portal')}>Manage billing</button>}
            </div>
            {billing.upgrade && <p style={{ color: C.muted, fontSize: 13, margin: '10px 0 0' }}>Billed monthly by card; cancel any time from Manage billing. The switch applies from your next sale.</p>}
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
            {stock && stock.oversold.length > 0 && (
              <div role="alert" style={{ border: `1px solid ${C.bad}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontWeight: 700, color: C.bad }}>Oversold in the last 30 days</div>
                <p style={{ margin: '4px 0 6px', color: C.muted, fontSize: 13 }}>A customer paid after their checkout hold ran out and the last units had gone. The sale is recorded; you decide whether to find a unit, substitute, or refund in Stripe.</p>
                {stock.oversold.map((o, i) => <div key={i} style={{ fontSize: 13 }}>{`${o.item}: oversold by ${o.shortfall} · ${new Date(o.at).toLocaleString()} · ${o.reference}`}</div>)}
              </div>
            )}
            {products.length === 0 && <p style={{ color: C.muted }}>No products yet.</p>}
            {products.map((p) => (
              <div key={p.id} style={{ borderTop: `1px solid ${C.line}`, padding: '12px 0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{p.name} <span style={{ fontSize: 12, color: p.isActive ? C.good : C.muted, marginLeft: 6 }}>{p.isActive ? (p.isUpcoming ? 'coming soon' : 'on sale') : p.isUpcoming ? 'coming soon' : 'hidden'}</span></div>
                  {p.sizes.map((s) => { const st = stockFor(p.id, s.size); return <div key={s.size} style={{ color: C.muted, fontSize: 13 }}>{`${s.size} · ${Number(s.price).toFixed(2)} · ${s.mode === 'RAFFLE' ? 'raffle' : 'instant buy'} · ${st ? st.available + ' available' + (st.held ? ` (${st.held} in checkout)` : '') : (s.stock ?? '?') + ' left'}`}</div>; })}
                </div>
                <button style={ghost} onClick={() => setEditing({ ...p, releaseEndsAt: toLocalInput(p.releaseEndsAt), sizes: p.sizes.map((s) => ({ ...s })), images: [...(p.images || [])] })}>Edit</button>
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
            <div style={label}>Photos {(editing.images || []).length > 0 && <span style={{ color: C.muted }}>· the first one is the cover</span>}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {(editing.images || []).map((src, i) => (
                <div key={src} style={{ position: 'relative', width: 84, height: 84, borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.line}` }}>
                  <img src={src} alt={'Photo ' + (i + 1)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <button aria-label={'Remove photo ' + (i + 1)} onClick={() => setEditing({ ...editing, images: (editing.images || []).filter((x) => x !== src) })} style={{ position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 999, border: 'none', background: 'rgba(0,0,0,0.7)', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: '26px', padding: 0 }}>×</button>
                </div>
              ))}
              {(editing.images || []).length < 8 && (
                <label style={{ ...ghost, display: 'inline-flex', alignItems: 'center', cursor: uploading ? 'wait' : 'pointer' }}>
                  {uploading ? 'Uploading…' : 'Add photos'}
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple disabled={uploading} onChange={(e) => { addPhotos(e.target.files); e.currentTarget.value = ''; }} style={{ display: 'none' }} />
                </label>
              )}
            </div>
            {/* One status, not two checkboxes that combine four ways for three
                real states. A stored product with both flags reads as coming
                soon, which is what the storefront shows for it. */}
            <label style={label}>Status
              <select style={input} value={editing.isUpcoming ? 'upcoming' : editing.isActive ? 'live' : 'draft'}
                onChange={(e) => setEditing({ ...editing, isActive: e.target.value === 'live', isUpcoming: e.target.value === 'upcoming' })}>
                <option value="draft">Draft: hidden from your store</option>
                <option value="upcoming">Coming soon: shown, takes waitlist sign-ups</option>
                <option value="live">On sale</option>
              </select>
            </label>
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
                  ? <div style={{ ...input, display: 'flex', alignItems: 'center', color: C.muted }}>{(stockFor(editing.id, s.size)?.available ?? 0) + ' available'}</div>
                  : <input aria-label="Starting stock" type="number" min="0" placeholder="Stock" style={input} value={s.stock ?? ''} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, stock: e.target.value }; setEditing({ ...editing, sizes }); }} />}
                {s.mode === 'RAFFLE' && <input aria-label="Winners per draw" type="number" min="1" placeholder="Winners" style={input} value={s.winners ?? ''} onChange={(e) => { const sizes = [...editing.sizes]; sizes[i] = { ...s, winners: e.target.value }; setEditing({ ...editing, sizes }); }} />}
              </div>
            ))}
            {!editing.id && editing.sizes.length < 10 && <button style={ghost} onClick={() => setEditing({ ...editing, sizes: [...editing.sizes, { size: '', price: '', mode: 'FCFS', stock: '' }] })}>Add a size</button>}
            {editing.id && (
              <div aria-label="Stock" style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 700 }}>Stock</div>
                <p style={{ color: C.muted, fontSize: 13, margin: '4px 0 8px' }}>Count what is on the shelf, or add and remove units. Units in someone&apos;s open checkout stay set aside for 30 minutes; set a size to 0 to stop selling it.</p>
                {editing.sizes.map((s) => {
                  const st = stockFor(editing.id, s.size);
                  if (!st || !st.variantId) return <div key={s.size} style={{ color: C.muted, fontSize: 13 }}>{s.size}: save the product first.</div>;
                  const v = st.variantId;
                  const e = editOf(v);
                  return (
                    <div key={s.size} style={{ borderTop: `1px solid ${C.line}`, padding: '10px 0' }}>
                      <div style={{ fontWeight: 600 }}>{s.size} <span style={{ color: C.muted, fontWeight: 400, fontSize: 13 }}>{`${st.onHand} on hand · ${st.held} in checkout · ${st.available} available`}</span></div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <input aria-label={'Counted units for ' + s.size} type="number" min="0" inputMode="numeric" placeholder="Count" style={{ ...input, width: 110 }} value={e.count} onChange={(ev) => putEdit(v, { count: ev.target.value })} />
                        <button style={ghost} disabled={e.count.trim() === ''} onClick={() => countStock(v)}>Set count</button>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <input aria-label={'Units to add or remove for ' + s.size} type="number" min="1" inputMode="numeric" placeholder="Units" style={{ ...input, width: 110 }} value={e.delta} onChange={(ev) => putEdit(v, { delta: ev.target.value })} />
                        <button style={ghost} disabled={!(Number(e.delta) > 0)} onClick={() => adjust(v, 1)}>Add</button>
                        <select aria-label={'Reason for removing ' + s.size} style={{ ...input, width: 'auto' }} value={e.reason === 'restock' ? 'adjust' : e.reason} onChange={(ev) => putEdit(v, { reason: ev.target.value })}>
                          <option value="adjust">Damaged / lost</option><option value="correction">Correction</option>
                        </select>
                        <button style={ghost} disabled={!(Number(e.delta) > 0)} onClick={() => adjust(v, -1)}>Remove</button>
                        <button style={ghost} onClick={() => showHistory(v)}>{history?.variantId === v ? 'Hide history' : 'History'}</button>
                      </div>
                      <input aria-label={'Note for ' + s.size} placeholder="Note (optional)" maxLength={200} style={{ ...input, marginTop: 8 }} value={e.note} onChange={(ev) => putEdit(v, { note: ev.target.value })} />
                      {history?.variantId === v && (
                        <div style={{ marginTop: 8 }}>
                          {history.rows.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No changes yet.</div>}
                          {history.rows.map((m, i) => (
                            <div key={i} style={{ fontSize: 13, color: C.muted, padding: '3px 0', overflowWrap: 'anywhere' }}>
                              {`${new Date(m.at).toLocaleString()} · ${({ opening: 'starting stock', sale: 'sold', restock: 'added', adjust: 'removed', count: 'counted', correction: 'correction' } as Record<string, string>)[m.reason] || m.reason} ${m.change > 0 ? '+' : ''}${m.change} → ${m.after}${m.shortfall ? ` · OVERSOLD by ${m.shortfall}` : ''}${m.by ? ' · ' + m.by : ''}${m.note ? ' · ' + m.note : ''}`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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

        {tab === 'settings' && domainsView && store.you.role === 'owner' && (
          <section style={card} aria-label="Custom domain">
            <div style={{ fontWeight: 700 }}>Custom domain</div>
            <div style={{ color: C.muted, fontSize: 14, marginTop: 4 }}>
              {`Use a domain you own, like www.yourstore.com. Your ${domainsView.plan} plan includes ${domainsView.limit === null ? 'as many as you need' : domainsView.limit}; you are using ${domainsView.used}.`}
            </div>
            {domainsView.domains.map((d) => (
              <div key={d.hostname} style={{ borderTop: `1px solid ${C.line}`, marginTop: 12, paddingTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{d.hostname}{d.primary ? ' · main address' : ''}</div>
                  <div style={{ fontSize: 13, color: d.status === 'active' ? C.good : d.status === 'error' ? C.bad : C.warn }}>
                    {d.status === 'active' ? 'Live' : d.status === 'error' ? 'Problem: check the records below' : 'Waiting for your DNS records'}
                  </div>
                </div>
                {d.status !== 'active' && (
                  <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
                    Add these two records where you bought the domain (it can take up to an hour to work):
                    {d.records.map((r) => (
                      <div key={r.type} style={{ marginTop: 6, padding: '8px 10px', background: '#0e0e11', borderRadius: 8, overflowWrap: 'anywhere' }}>
                        <div><strong>{r.type}</strong> · {r.why}</div>
                        <div>Name: <code>{r.name}</code></div>
                        <div>Value: <code>{r.value}</code></div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {d.status !== 'active' && <button style={ghost} disabled={domainBusy} onClick={() => domainCall('PATCH', { hostname: d.hostname, action: 'check' })}>Check now</button>}
                  {d.status === 'active' && !d.primary && <button style={ghost} disabled={domainBusy} onClick={() => domainCall('PATCH', { hostname: d.hostname, action: 'primary' })}>Make it my main address</button>}
                  <button style={ghost} disabled={domainBusy} onClick={() => { if (window.confirm('Disconnect ' + d.hostname + '? Your store stops answering on it.')) domainCall('DELETE', undefined, '?hostname=' + encodeURIComponent(d.hostname)); }}>Disconnect</button>
                </div>
              </div>
            ))}
            {(domainsView.limit === null || domainsView.used < domainsView.limit) && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <input style={{ ...input, flex: '1 1 240px', width: 'auto' }} placeholder="www.yourstore.com" value={domainInput} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setDomainInput(e.target.value)} />
                <button style={btn} disabled={domainBusy || !domainInput.trim()} onClick={async () => { if (await domainCall('POST', { hostname: domainInput })) setDomainInput(''); }}>{domainBusy ? 'Connecting…' : 'Connect domain'}</button>
              </div>
            )}
          </section>
        )}

        {tab === 'settings' && address && store.you.role === 'owner' && (
          <section style={card} aria-label="Store address">
            <div style={{ fontWeight: 700 }}>Store address</div>
            <div style={{ color: C.muted, fontSize: 14, marginTop: 4 }}>Now: <a href={address.current.url} style={{ color: C.text }}>{address.current.url.replace('https://', '')}</a></div>
            <label style={label}>New address
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input style={{ ...input, flex: 1 }} value={addressInput} placeholder={address.current.slug} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  onChange={(e) => setAddressInput(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'))} />
                <span style={{ color: C.muted, whiteSpace: 'nowrap' }}>{'.' + address.current.url.split('.').slice(1).join('.')}</span>
              </div>
            </label>
            {addressInput.trim() && address.candidate && address.candidate.slug === addressInput.trim() && (
              <div role="status" style={{ fontSize: 14, marginTop: 8, color: address.candidate.available ? C.good : C.warn }}>
                {address.candidate.available ? '✓ ' : ''}{address.candidate.reason}{address.candidate.available ? ' Your store will be at ' + address.candidate.url.replace('https://', '') + '.' : ''}
              </div>
            )}
            <p style={{ color: C.muted, fontSize: 13, margin: '10px 0 0' }}>
              {`Your current address keeps working for ${address.holdDays} days (it sends visitors to the new one), and you can switch back. ${address.changesLeft} change${address.changesLeft === 1 ? '' : 's'} left this month.`}
            </p>
            <div style={{ marginTop: 12 }}>
              <button style={btn} onClick={changeAddress} disabled={addressBusy || !address.candidate?.available || address.candidate.slug !== addressInput.trim() || address.changesLeft === 0}>
                {addressBusy ? 'Changing…' : address.candidate?.available && address.candidate.slug === addressInput.trim() ? 'Move my store to ' + address.candidate.url.replace('https://', '') : 'Change address'}
              </button>
            </div>
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
