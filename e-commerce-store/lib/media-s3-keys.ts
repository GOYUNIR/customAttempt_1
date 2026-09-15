/**
 * Object-storage KEY helpers — pure, zero-import (see tests/media-s3-keys.test.ts).
 *
 * Split out of lib/media-s3.ts, which imports `crypto` and so cannot be loaded
 * directly by `node --test` (this repo's tests cannot resolve `@/` aliases, and
 * pure modules are the established way around that — see lib/csrf.ts).
 */

/** Extensions accepted for uploaded media. Anything else gets no extension. */
export const ACCEPTED_MEDIA_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpeg', 'jpg', 'svg', 'webp', 'gif', 'bmp', 'avif',
  'mp4', 'mov', 'mkv', 'avi', 'webm',
]);

/** Lowercase, hyphenated, bounded — safe as a single object-key segment. */
export function slugifyMediaSegment(value: string): string {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'product'
  );
}

/** `.ext` for an accepted media filename, '' otherwise. Never returns junk. */
export function safeMediaExtension(filename: string): string {
  const name = String(filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = name.slice(dot + 1).replace(/[^a-z0-9]/g, '');
  return ACCEPTED_MEDIA_EXTS.has(ext) ? `.${ext}` : '';
}

/**
 * `products/<slug>/<id><.ext>` — the required s3://bucket/products/[slug]/
 * prefix. `id` is caller-supplied (a uuid in the app, a deterministic id in
 * the backfill) so this function stays pure and testable.
 */
export function buildMediaObjectKey(slug: string, id: string, filename: string): string {
  // Strip disallowed characters, then collapse dot runs and trim leading /
  // trailing dots and dashes, so no '..' sequence can survive into a key.
  const safeId =
    String(id || '')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .replace(/\.+/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '') || 'object';
  return `products/${slugifyMediaSegment(slug)}/${safeId}${safeMediaExtension(filename)}`;
}

/** Parsed `data:<mime>;base64,<payload>` URL. */
export interface ParsedDataUrl {
  mime: string;
  base64: string;
}

const DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/i;

/**
 * Parse a base64 data URL. Returns null for anything else — an https:// URL,
 * a relative path, empty, or malformed input. The backfill relies on this to
 * decide what still needs migrating, so "already a URL" MUST return null.
 */
export function parseDataUrl(src: unknown): ParsedDataUrl | null {
  const s = String(src || '');
  if (!s.toLowerCase().startsWith('data:')) return null;
  const m = DATA_URL_RE.exec(s);
  if (!m) return null;
  const [, mime, base64] = m;
  if (!base64) return null;
  return { mime, base64 };
}

/** True when a media value still needs migrating to object storage. */
export function needsMediaMigration(src: unknown): boolean {
  return parseDataUrl(src) !== null;
}
