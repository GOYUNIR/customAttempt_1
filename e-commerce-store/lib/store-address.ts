/**
 * STORE ADDRESS RULES (STORE-ADDRESSES.md §A): which <name>.<root> a store may
 * choose. Pure; the database decides only taken / held / cap (00039).
 *
 * Refused: bad format; platform-reserved labels and legacy hosts; names that
 * impersonate payment providers, banks or big tech, or read like a sign-in
 * page. Lookalikes are caught after undoing common tricks (digits for letters,
 * hyphens), so "paypa1", "pay-pal" and "g00gle" are refused like the real ones.
 */
import { isReservedStoreSlug } from './storefront-host.ts';

/** Changing is capped, and an old name is held (then released) — 00039. */
export const STORE_ADDRESS_RULES = { holdDays: 90, maxChanges: 3, windowDays: 30 } as const;

// Distinctive brands: refused anywhere inside the name (after normalizing).
const BRAND_ANYWHERE = [
  'paypal', 'venmo', 'cashapp', 'coinbase', 'binance', 'revolut', 'transferwise',
  'mastercard', 'americanexpress', 'wellsfargo', 'bankofamerica', 'jpmorgan', 'goldmansachs', 'barclays', 'santander',
  'google', 'gmail', 'microsoft', 'appleid', 'icloud', 'amazon', 'facebook', 'instagram', 'whatsapp',
  'netflix', 'shopify', 'squarespace', 'squareup', 'bigcommerce', 'woocommerce', 'klarna', 'afterpay', 'adyen',
];
// Short or generic words: refused as a whole hyphen-separated part of the name.
const WORDS_AS_PART = [
  'stripe', 'zelle', 'visa', 'amex', 'chase', 'citi', 'hsbc', 'bank', 'banking', 'meta', 'wix', 'ebay', 'etsy',
  'login', 'signin', 'signon', 'verify', 'verification', 'secure', 'security', 'account', 'accounts', 'password',
  'wallet', 'payment', 'payments', 'pay', 'billing', 'invoice', 'refund', 'support', 'helpdesk', 'admin', 'official',
];
// Undo the usual substitutions before comparing.
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '$': 's', '@': 'a' };
const unTrick = (s: string) => s.split('').map((ch) => LOOKALIKE[ch] ?? ch).join('');

export type AddressCheck = { ok: true; slug: string } | { ok: false; slug: string; reason: string };

/** Lower-case, spaces and underscores to hyphens; what the input box shows. */
export function normalizeAddressInput(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[\s_]+/g, '-').slice(0, 60);
}

export function checkStoreAddress(raw: string, ctx: { legacyHosts: Set<string> | null; rootDomain: string | undefined }): AddressCheck {
  const slug = normalizeAddressInput(raw);
  if (slug.length < 3) return { ok: false, slug, reason: 'Use at least 3 characters.' };
  if (slug.length > 40) return { ok: false, slug, reason: 'Use at most 40 characters.' };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return { ok: false, slug, reason: 'Use letters, numbers and single hyphens (not at the start or end).' };
  if (isReservedStoreSlug(slug, ctx.legacyHosts, ctx.rootDomain)) return { ok: false, slug, reason: 'That name is reserved.' };
  const flat = unTrick(slug.replace(/-/g, ''));
  const parts = slug.split('-').map(unTrick);
  if (BRAND_ANYWHERE.some((b) => flat.includes(b)) || parts.some((p) => WORDS_AS_PART.includes(p))) {
    return { ok: false, slug, reason: 'That name could be mistaken for a bank, payment or tech brand, or a sign-in page. Choose another.' };
  }
  return { ok: true, slug };
}
