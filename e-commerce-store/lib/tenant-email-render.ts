/**
 * The PURE half of lib/tenant-email.ts: templates, escaping and the sender
 * header for a merchant store's customer emails. No imports on purpose, so
 * node --test loads it directly (tests/tenant-email.test.ts).
 */

/** "Store Name" <address>, with the name made safe for a header. */
export function storeFromHeader(storeName: string, address: string): string {
  const name = String(storeName || '').replace(/["<>\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Store';
  return '"' + name + '" <' + address + '>';
}

/** The verified sending ADDRESS (no name) inside a From value such as
 *  'Name <a@b.c>' or 'a@b.c'. Null when there is none. */
export function sendingAddressOf(raw: string | undefined | null): string | null {
  const v = String(raw || '').trim();
  const m = /<([^<>\s@]+@[^<>\s@]+)>/.exec(v) || /^([^<>\s@]+@[^<>\s@]+)$/.exec(v);
  return m ? m[1] : null;
}

export type StoreIdentity = { name: string; supportEmail: string | null; storeUrl: string | null };
export type StoreEmail = { subject: string; html: string; text: string };

export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function money(cents: number, currency: string): string {
  const code = String(currency || '').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD' }).format((Number(cents) || 0) / 100);
  } catch {
    return ((Number(cents) || 0) / 100).toFixed(2) + (code ? ' ' + code : '');
  }
}

function frame(store: StoreIdentity, heading: string, bodyHtml: string): string {
  const help = store.supportEmail
    ? `Questions? Reply to this email or write to ${esc(store.supportEmail)}.`
    : store.storeUrl ? `Questions? Visit <a href="${esc(store.storeUrl)}" style="color:#111">${esc(store.storeUrl.replace('https://', ''))}</a>.` : '';
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:28px 24px;border:1px solid #e5e7eb">
<p style="letter-spacing:3px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 14px">${esc(store.name)}</p>
<h1 style="font-size:22px;font-weight:700;margin:0 0 12px">${esc(heading)}</h1>
${bodyHtml}
${help ? `<p style="margin:20px 0 0;color:#6b7280;font-size:13px">${help}</p>` : ''}
</div>`;
}

function textHelp(store: StoreIdentity): string {
  return store.supportEmail ? '\n\nQuestions? Reply to this email or write to ' + store.supportEmail + '.' : store.storeUrl ? '\n\nQuestions? Visit ' + store.storeUrl : '';
}

export function renderOrderConfirmed(store: StoreIdentity, o: {
  orderRef: string; lines: Array<{ productName: string; size: string; quantity: number; amountCents: number }>; totalCents: number; currency: string;
  /** A discount code applied (the line amounts are already discounted). */
  discount?: { code: string; cents: number } | null;
}): StoreEmail {
  const rows = o.lines.map((l) => `<tr><td style="padding:6px 0">${esc(l.productName)}${l.size ? ' (' + esc(l.size) + ')' : ''}${l.quantity > 1 ? ' &times; ' + l.quantity : ''}</td><td style="padding:6px 0;text-align:right">${esc(money(l.amountCents, o.currency))}</td></tr>`).join('')
    + (o.discount && o.discount.cents > 0 ? `<tr><td style="padding:6px 0;color:#6b7280">Discount (${esc(o.discount.code)}), included above</td><td style="padding:6px 0;text-align:right;color:#6b7280">&minus;${esc(money(o.discount.cents, o.currency))}</td></tr>` : '');
  const html = frame(store, 'Thanks for your order', `
<p style="margin:0 0 14px;color:#374151">Your payment went through. Order <strong>${esc(o.orderRef)}</strong>.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px">${rows}
<tr><td style="padding:10px 0 0;border-top:1px solid #e5e7eb;font-weight:700">Total</td><td style="padding:10px 0 0;border-top:1px solid #e5e7eb;text-align:right;font-weight:700">${esc(money(o.totalCents, o.currency))}</td></tr></table>`);
  const text = store.name + '\n\nThanks for your order. Your payment went through. Order ' + o.orderRef + '.\n\n' +
    o.lines.map((l) => '- ' + l.productName + (l.size ? ' (' + l.size + ')' : '') + (l.quantity > 1 ? ' x' + l.quantity : '') + ': ' + money(l.amountCents, o.currency)).join('\n') +
    '\nTotal: ' + money(o.totalCents, o.currency) + textHelp(store);
  return { subject: 'Your order from ' + store.name + ' (' + o.orderRef + ')', html, text };
}

/** The same promise the store's confirmation page makes, in writing. */
export function renderEntryReceived(store: StoreIdentity, e: { kind: 'raffle' | 'waitlist'; product: string; size: string }): StoreEmail {
  const item = e.product + (e.size ? ' (' + e.size + ')' : '');
  const line = e.kind === 'waitlist'
    ? `You're on the waitlist for ${item}. Your saved card is charged only if one is available when it goes on sale.`
    : `Your entry for ${item} is locked in. Your saved card is charged only if you win.`;
  return {
    subject: (e.kind === 'waitlist' ? "You're on the waitlist: " : "You're entered: ") + item,
    html: frame(store, e.kind === 'waitlist' ? "You're on the waitlist" : "You're entered", `<p style="margin:0;color:#374151">${esc(line)}</p>`),
    text: store.name + '\n\n' + line + textHelp(store),
  };
}

export function renderEntryCharged(store: StoreIdentity, c: { kind: 'raffle' | 'waitlist'; product: string; size: string; amountCents: number; currency: string; orderRef: string }): StoreEmail {
  const item = c.product + (c.size ? ' (' + c.size + ')' : '');
  const line = (c.kind === 'raffle' ? `You were selected for ${item}.` : `${item} became available and it's yours.`) +
    ` Your saved card was charged ${money(c.amountCents, c.currency)}. Order ${c.orderRef}.`;
  return {
    subject: (c.kind === 'raffle' ? 'You won: ' : "It's yours: ") + item,
    html: frame(store, c.kind === 'raffle' ? 'You won' : "It's yours", `<p style="margin:0;color:#374151">${esc(line)}</p>`),
    text: store.name + '\n\n' + line + textHelp(store),
  };
}

/** The order is on its way (fulfilment v1: the whole order, once). */
export function renderOrderShipped(store: StoreIdentity, s: {
  orderRef: string; carrier: string; trackingNumber: string; trackingUrl: string | null;
  lines: Array<{ productName: string; size: string; quantity: number }>;
}): StoreEmail {
  const items = s.lines.map((l) => esc(l.productName) + (l.size ? ' (' + esc(l.size) + ')' : '') + (l.quantity > 1 ? ' &times; ' + l.quantity : '')).join('<br>');
  const track = s.trackingUrl
    ? `<p style="margin:0 0 16px"><a href="${esc(s.trackingUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:700;font-size:14px">Track your package</a></p>`
    : '';
  const html = frame(store, 'Your order is on its way', `
<p style="margin:0 0 14px;color:#374151">Order <strong>${esc(s.orderRef)}</strong> has shipped with ${esc(s.carrier)}. Tracking number: <strong>${esc(s.trackingNumber)}</strong>.</p>
${track}<p style="margin:0;color:#374151;font-size:15px">${items}</p>`);
  const text = store.name + '\n\nYour order is on its way. Order ' + s.orderRef + ' has shipped with ' + s.carrier +
    '. Tracking number: ' + s.trackingNumber + '.' + (s.trackingUrl ? '\nTrack it: ' + s.trackingUrl : '') + '\n\n' +
    s.lines.map((l) => '- ' + l.productName + (l.size ? ' (' + l.size + ')' : '') + (l.quantity > 1 ? ' x' + l.quantity : '')).join('\n') + textHelp(store);
  return { subject: 'Your order from ' + store.name + ' has shipped (' + s.orderRef + ')', html, text };
}
