/**
 * Media helpers shared by the admin upload/crop tooling and the storefront
 * gallery. This module is dependency-free (no React, no server-only imports)
 * so it is safe to import from client components, server routes and node --test.
 *
 * Product galleries accept a mix of IMAGES (png/jpeg/jpg/svg/webp/gif/bmp/avif)
 * and VIDEOS (mp4/mov/mkv/avi/webm), stored as data: URLs or absolute URLs in
 * the product's `images` array. Every media item has an OPTIONAL parallel crop
 * record in `crops` (same index) describing which rectangular region of the
 * source is visible in the storefront's fixed-ratio gallery boxes.
 */

/** Normalized crop region. `x`/`y` are the crop CENTER in 0..1 image coords,
 * `w`/`h` the crop SIZE in 0..1 (1 = the whole source is visible; smaller =
 * zoomed in). The default `{x:0.5,y:0.5,w:1,h:1}` shows the full image with
 * the container doing a centered cover-crop — exactly the classic object-fit
 * behaviour, so existing products are unaffected when `crops` is absent. */
export interface MediaCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_CROP: MediaCrop = { x: 0.5, y: 0.5, w: 1, h: 1 };

/** Clamp + coerce an unknown admin value into a safe normalized crop. */
export function normalizeCrop(crop: unknown): MediaCrop {
  const c = (crop && typeof crop === 'object' ? crop : {}) as Record<string, unknown>;
  const clamp01 = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(0, Math.min(1, n)) : fallback;
  };
  return {
    x: clamp01(c.x, 0.5),
    y: clamp01(c.y, 0.5),
    w: Math.max(0.05, clamp01(c.w, 1)),
    h: Math.max(0.05, clamp01(c.h, 1)),
  };
}

/** Crop equality — used to keep the admin form state in sync with uploads. */
export function cropsEqual(a: unknown, b: unknown): boolean {
  const A = normalizeCrop(a);
  const B = normalizeCrop(b);
  return Math.abs(A.x - B.x) < 0.0001 && Math.abs(A.y - B.y) < 0.0001 && Math.abs(A.w - B.w) < 0.0001 && Math.abs(A.h - B.h) < 0.0001;
}

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|avi|webm)(?:[?#].*)?$/i;

/** True when a media source is a video (data:video/… or a known video URL). */
export function isVideoMedia(src: unknown): boolean {
  const s = String(src || '');
  if (!s) return false;
  if (/^data:video\//i.test(s)) return true;
  if (/^data:/i.test(s)) return false; // any other data: URL is not a video
  return VIDEO_EXT_RE.test(s);
}

/** Everything that is not a video is treated as an image (data:image or URL). */
export function isImageMedia(src: unknown): boolean {
  return !isVideoMedia(src);
}

/** Human label for a container ratio, e.g. 560×280 → `2:1`, 328×280 → `1.17:1`. */
export function aspectRatioLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '—';
  const ratio = width / height;
  const candidates: Array<[number, number, string]> = [
    [16, 9, '16:9'],
    [4, 3, '4:3'],
    [3, 2, '3:2'],
    [2, 1, '2:1'],
    [1.91, 1, '1.91:1'],
    [1.5, 1, '3:2'],
    [1.33, 1, '4:3'],
    [1.17, 1, '1.17:1'],
    [1, 1, '1:1'],
    [3, 4, '3:4'],
    [2, 3, '2:3'],
    [9, 16, '9:16'],
    [1, 2, '1:2'],
  ];
  let bestLabel = `${ratio.toFixed(2)}:1`;
  let bestDiff = 0.08; // tolerance for matching a "common" ratio label
  for (const [aw, ah, label] of candidates) {
    const diff = Math.abs(aw / ah - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLabel = label;
    }
  }
  return bestLabel;
}

/**
 * Position an absolutely-placed <img> inside a box so the CROP REGION fills the
 * box exactly (cover semantics). The crop rectangle (crop.w × crop.h of the
 * natural image, centered at crop.x × crop.y) maps onto the whole box — the
 * precise opposite of `object-fit: cover` where the container decides the crop.
 * Returns px styles to spread on the <img>.
 */
export function coverStyle(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
  crop: MediaCrop,
): { width: number; height: number; left: number; top: number } {
  const nw = Math.max(1, Number(naturalWidth) || 1);
  const nh = Math.max(1, Number(naturalHeight) || 1);
  const bw = Math.max(1, Number(boxWidth) || 1);
  const bh = Math.max(1, Number(boxHeight) || 1);
  const c = normalizeCrop(crop);
  // The image must be scaled so that `crop.w × naturalW` covers boxWidth AND
  // `crop.h × naturalH` covers boxHeight (the larger of the two wins).
  const scale = Math.max(bw / (c.w * nw), bh / (c.h * nh));
  const dispW = nw * scale;
  const dispH = nh * scale;
  return {
    width: dispW,
    height: dispH,
    // Center the crop region in the box (crop center in px = c.x * nw * scale).
    left: bw / 2 - c.x * nw * scale,
    top: bh / 2 - c.y * nh * scale,
  };
}
