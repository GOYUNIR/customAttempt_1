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

export function buildOrderRef(email: string, productId: string, size: string, prefix?: string): string {
  const seed = `${String(email || 'anon').trim().toLowerCase()}|${String(productId || 'product').trim()}|${String(size || 'standard').trim().toLowerCase()}`;
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
