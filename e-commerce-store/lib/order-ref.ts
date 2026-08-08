function hashSeed(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash >>> 0)).toString(36).toUpperCase();
}

export function buildOrderRef(email: string, productId: string, size: string): string {
  const seed = `${String(email || 'anon').trim().toLowerCase()}|${String(productId || 'product').trim()}|${String(size || 'standard').trim().toLowerCase()}`;
  const token = hashSeed(seed).slice(0, 8);
  return `GY-${token}`;
}

export function formatOrderRef(value: string | null | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^GOY-/i.test(trimmed)) {
    return `GY-${trimmed.slice(4)}`;
  }
  if (/^GY-/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed.toUpperCase();
}
