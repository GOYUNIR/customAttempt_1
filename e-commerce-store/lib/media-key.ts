/**
 * MEDIA KEYS — product photos are stored as `media:<key>` (a path inside our
 * storage, no domain) and turned into a URL at READ time from
 * MEDIA_S3_PUBLIC_BASE_URL. So moving the platform to another domain never
 * touches stored photos (DOMAIN-MIGRATION.md). Older photos stored as absolute
 * URLs keep working as they are; one on our own media host is converted to a
 * key the next time its product is saved.
 *
 * A key is letters, digits and / . _ - only, with no ".." segment and no empty
 * segment, so a stored value can only ever name something inside our media
 * path, never another host or a path outside it.
 */
export const MEDIA_KEY_PREFIX = 'media:';
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;

export function validMediaKey(key: string): boolean {
  const parts = key.split('/');
  return key.length > 0 && key.length <= 400 && KEY_RE.test(key) && !parts.includes('..') && !parts.includes('.') && !parts.includes('');
}

const baseOf = (base?: string) => String(base ?? process.env.MEDIA_S3_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

/** A stored value → what to show: keys resolve against the media base; anything else passes through unchanged. */
export function resolveMediaRef(stored: unknown, base?: string): string {
  const s = String(stored ?? '');
  if (!s.startsWith(MEDIA_KEY_PREFIX)) return s;
  const key = s.slice(MEDIA_KEY_PREFIX.length);
  const b = baseOf(base);
  return validMediaKey(key) && b ? b + '/' + key : '';
}

/** What to STORE for an incoming value: a key, or null if it is not ours (a URL on our media host becomes its key). */
export function toMediaRef(value: unknown, base?: string): string | null {
  const s = String(value ?? '').trim();
  if (s.startsWith(MEDIA_KEY_PREFIX)) return validMediaKey(s.slice(MEDIA_KEY_PREFIX.length)) ? s : null;
  const b = baseOf(base);
  if (!b || !s.startsWith(b + '/')) return null;
  const key = s.slice(b.length + 1).split('?')[0].split('#')[0];
  return validMediaKey(key) ? MEDIA_KEY_PREFIX + key : null;
}
