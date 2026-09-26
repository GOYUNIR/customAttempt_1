/**
 * CART METADATA — a cart's lines carried on a Stripe Checkout Session's
 * metadata from checkout to the webhook (TENANCY.md phase 3). Pure, so the
 * round trip is unit-tested: a lost or garbled line is money with no record of
 * what was sold.
 */

/** Stripe caps a metadata value at 500 characters (the default store's cart
 *  route puts the whole cart in one value, so a large cart there can fail).
 *  Here the cart is split over cart_0..cart_N, compact. */
export const CART_KEY_PREFIX = 'cart_';
export const CART_MAX_KEYS = 30;

export function encodeCartMetadata(lines: Array<{ productId: string; size: string; quantity: number; unitCents: number }>): Record<string, string> | null {
  const text = JSON.stringify(lines.map((l) => [l.productId, l.size, l.quantity, l.unitCents]));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 480) chunks.push(text.slice(i, i + 480));
  if (chunks.length > CART_MAX_KEYS) return null;
  const out: Record<string, string> = { cart_parts: String(chunks.length) };
  chunks.forEach((c, i) => { out[CART_KEY_PREFIX + i] = c; });
  return out;
}

export function decodeCartMetadata(md: Record<string, any>): Array<{ productId: string; size: string; quantity: number; unitCents: number }> | null {
  const parts = Number(md?.cart_parts || 0);
  if (!Number.isInteger(parts) || parts < 1 || parts > CART_MAX_KEYS) return null;
  let text = '';
  for (let i = 0; i < parts; i++) {
    const part = md[CART_KEY_PREFIX + i];
    if (typeof part !== 'string') return null;
    text += part;
  }
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) return null;
    return rows.map((r: any) => ({
      productId: String(r[0]),
      size: String(r[1]),
      quantity: Math.max(1, Math.floor(Number(r[2]) || 1)),
      unitCents: Math.max(0, Math.round(Number(r[3]) || 0)),
    }));
  } catch {
    return null;
  }
}

