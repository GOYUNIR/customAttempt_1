function hashSeed(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash >>> 0)).toString(36).toUpperCase();
}

/** Sanitize an admin-configured order-ref prefix: uppercase, keep only A-Z0-9,
 * strip to max 4 chars, and default to 'GU' when empty/invalid. Callers read
 * the configured value from `store:config.refPrefix` and pass it through here
 * so a malformed/brand-new config can never produce a broken ref. */
export function normalizeRefPrefix(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  return raw || 'GU';
}

/**
 * A customer-facing order reference.
 *
 * WITHOUT `nonce` THIS IS DELIBERATELY STABLE: the same buyer, product and
 * size always produce the same ref. The raffle flow depends on that — an entry
 * stores its ref at signup and the draw reuses it weeks later to correlate the
 * charge with the entry, and one person gets one allocation, so a collision is
 * not possible there.
 *
 * PASS `nonce` ANYWHERE A CUSTOMER CAN BUY THE SAME THING TWICE. Orders are
 * idempotent on (tenant_id, order_ref) (lib/order-write.ts), so a stable ref on
 * a repeatable purchase does not create a second order — it OVERWRITES the
 * first. Measured on production before this parameter existed: one buyer, two
 * separate charges thirty-five seconds apart, two units of stock sold, and a
 * single order row whose payment intent id was the second charge. The first
 * payment existed in Stripe and nowhere in our database. The Stripe
 * PaymentIntent id is the natural nonce — it is unique per charge, and folding
 * it in keeps the ref the same short shape a customer can read out over the
 * phone.
 */
export function buildOrderRef(email: string, productId: string, size: string, prefix?: string, nonce?: string): string {
  const base = `${String(email || 'anon').trim().toLowerCase()}|${String(productId || 'product').trim()}|${String(size || 'standard').trim().toLowerCase()}`;
  const seed = nonce ? `${base}|${String(nonce).trim()}` : base;
  const token = hashSeed(seed).slice(0, 8);
  return `${normalizeRefPrefix(prefix)}-${token}`;
}

export function formatOrderRef(value: string | null | undefined, prefix?: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const refPrefix = normalizeRefPrefix(prefix);
  // Normalize legacy GOY-/GY-/GU- prefixed refs to the NEW configured prefix
  // while preserving the token portion (e.g. GY-abc123 with prefix 'GU' →
  // GU-abc123; GOY-abc123 → GU-abc123). Unknown refs pass through uppercased.
  const legacy = /^(GOY|GY|GU)-(.+)$/i.exec(trimmed);
  if (legacy) {
    return `${refPrefix}-${legacy[2].toUpperCase()}`;
  }
  return trimmed.toUpperCase();
}
