/**
 * Shared, pure helpers for the social share card / link preview.
 *
 * Used by THREE consumers so they can never drift apart:
 *   1. `app/og/route.ts`   — server-renders the 1200×630 PNG that WhatsApp /
 *      iMessage / Discord / X / Facebook fetch from `og:image`.
 *   2. `components/ShareCard.tsx` — the isomorphic presentational card used by
 *      the route AND the admin preview.
 *   3. `components/LinkPreviewGallery.tsx` — the /admin → Settings → Branding &
 *      Share preview that shows EXACTLY what the shared link looks like live,
 *      from the CURRENT (possibly unsaved) form state.
 *
 * Nothing in this file touches `next/headers`, `process.env` (server-only) or
 * the DOM, so it is safe to import from both server components and client
 * components. Keep it dependency-free.
 */

const FALLBACK_BG = '#0B0B0F';
const FALLBACK_ACCENT = '#D4AF37';

/** Small allowlist of named CSS colors (anything else must be hex/rgb/hsl). */
const NAMED_COLORS = new Set([
  'transparent',
  'white',
  'black',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'silver',
  'gold',
]);

/**
 * Sanitize an admin-edited CSS color so a leftover/free-text value can never
 * produce an invalid `background` / `color` style (which crashes satori →
 * 500 on the share-card route, i.e. "link previews don't work at all").
 * Keeps `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`,
 * `hsla()` and common named colors; anything else falls back.
 */
export function safeCssColor(value: unknown, fallback = FALLBACK_BG): string {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
  if (/^(?:rgb|rgba|hsl|hsla)\([\d\s,./%]+\)$/i.test(s)) return s;
  if (NAMED_COLORS.has(s.toLowerCase())) return s;
  return fallback;
}

/**
 * Convert a hex color to an `rgba()` string. Returns a neutral fallback when
 * the input isn't hex (named/rgb colors can't be split into channels here).
 * Used to add alpha to the card accent glow (`#D4AF37` → `rgba(212,175,55,0.33)`)
 * instead of the old `#D4AF3755` trick, which silently breaks when the accent
 * is NOT a hex string.
 */
export function hexToRgba(value: unknown, alpha: number): string {
  let h = String(value ?? '').trim().replace('#', '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 8) {
    // 8-digit hex carries its own alpha — multiply it into the requested one.
    const ownAlpha = parseInt(h.slice(6, 8), 16) / 255;
    h = h.slice(0, 6);
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${Math.max(0, Math.min(1, ownAlpha * alpha)).toFixed(3)})`;
  }
  if (h.length === 6 && /^[0-9a-fA-F]{6}$/.test(h)) {
    return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }
  return `rgba(255,255,255,${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Share-card options (buyer-facing knobs for the link preview)
// ---------------------------------------------------------------------------

export type ShareCardLayout = 'classic' | 'split' | 'minimal';
export type ShareCardFontFamily = 'system' | 'serif';

/**
 * All buyer-editable knobs for the link preview / share card. Stored on the
 * admin `branding` object (Settings → Branding & Share) and normalized here so
 * the server route, the live card and the admin previews can never drift.
 * Every field is optional at the source; defaults below keep existing cards
 * byte-for-byte identical.
 */
export interface ShareCardOptions {
  /** Show/hide the logo square in the top-left (classic) / brand mark (minimal). */
  shareLogoVisible: boolean;
  /** Show/hide the tagline line under the brand name. */
  shareTaglineVisible: boolean;
  /** Show/hide the domain in the top-right (classic/split only). */
  shareSiteVisible: boolean;
  /** Title font size in px (clamped 36–92). */
  shareTitleSize: number;
  /** Description font size in px (clamped 18–42). */
  shareDescriptionSize: number;
  /** Card composition: classic | split (image left) | minimal (centered). */
  shareLayout: ShareCardLayout;
  /** Card typeface: system | serif. */
  shareFontFamily: ShareCardFontFamily;
  /** Accent radial-glow strength, 0 (no glow) – 100 (alpha 0.45). */
  shareGlowIntensity: number;
  /** Rounded card corners in px (0–64). */
  shareCornerRadius: number;
  /** Darkness of the gradient over a share image, 0 (transparent) – 100 (near-black). */
  shareImageOverlay: number;
}

export const SHARE_CARD_DEFAULTS: ShareCardOptions = {
  shareLogoVisible: true,
  shareTaglineVisible: true,
  shareSiteVisible: true,
  shareTitleSize: 74,
  shareDescriptionSize: 30,
  shareLayout: 'classic',
  shareFontFamily: 'system',
  shareGlowIntensity: 40,
  shareCornerRadius: 0,
  shareImageOverlay: 60,
};

function toBool(value: unknown, dflt: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return dflt;
}

function clampNumber(value: unknown, min: number, max: number, dflt: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/**
 * Merge raw (admin-edited, possibly junk) branding fields into a complete,
 * validated `ShareCardOptions`. Unknown/missing fields fall back to defaults,
 * numbers are clamped to their documented ranges, and enum fields are checked
 * against their unions — free text can never leak into the card CSS.
 */
export function normalizeShareCardOptions(raw: unknown): ShareCardOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const layout = r.shareLayout;
  const font = r.shareFontFamily;
  return {
    shareLogoVisible: toBool(r.shareLogoVisible, SHARE_CARD_DEFAULTS.shareLogoVisible),
    shareTaglineVisible: toBool(r.shareTaglineVisible, SHARE_CARD_DEFAULTS.shareTaglineVisible),
    shareSiteVisible: toBool(r.shareSiteVisible, SHARE_CARD_DEFAULTS.shareSiteVisible),
    shareTitleSize: clampNumber(r.shareTitleSize, 36, 92, SHARE_CARD_DEFAULTS.shareTitleSize),
    shareDescriptionSize: clampNumber(r.shareDescriptionSize, 18, 42, SHARE_CARD_DEFAULTS.shareDescriptionSize),
    shareLayout: layout === 'classic' || layout === 'split' || layout === 'minimal' ? layout : SHARE_CARD_DEFAULTS.shareLayout,
    shareFontFamily: font === 'system' || font === 'serif' ? font : SHARE_CARD_DEFAULTS.shareFontFamily,
    shareGlowIntensity: clampNumber(r.shareGlowIntensity, 0, 100, SHARE_CARD_DEFAULTS.shareGlowIntensity),
    shareCornerRadius: clampNumber(r.shareCornerRadius, 0, 64, SHARE_CARD_DEFAULTS.shareCornerRadius),
    shareImageOverlay: clampNumber(r.shareImageOverlay, 0, 100, SHARE_CARD_DEFAULTS.shareImageOverlay),
  };
}

// Ramp anchors: alpha values at the DEFAULT intensity (glow 40, overlay 60) and
// the max at intensity 100 — the defaults reproduce the pre-options card exactly.
const GLOW_BREAKPOINT = 0.4; // glow 40/100 → base alpha
const GLOW_ACCENT_BASE = 0.33;
const GLOW_ACCENT_MAX = 0.45;
const GLOW_PURPLE_BASE = 0.28;
const GLOW_PURPLE_MAX = 0.38;
const OVERLAY_BREAKPOINT = 0.6; // overlay 60/100 → base alpha
const OVERLAY_TOP_BASE = 0.56;
const OVERLAY_TOP_MAX = 0.95;
const OVERLAY_BOTTOM_BASE = 0.68;
const OVERLAY_BOTTOM_MAX = 0.97;

/** Scale an alpha from `base` (at the default breakpoint) to `max` (at 1). */
function rampAlpha(base: number, max: number, f: number, breakpoint: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return max;
  if (f <= breakpoint) return base * (f / breakpoint);
  return base + (max - base) * ((f - breakpoint) / (1 - breakpoint));
}

/**
 * The full multi-layer `background` CSS for the 1200×630 card. This is shared
 * by the server route and the admin preview so the preview is pixel-faithful:
 *   - with a share image: dark gradient over `url(...)`, over the solid bg
 *     (gradient darkness controlled by `opts.shareImageOverlay`),
 *   - without: two radial accent glows over the solid bg (strength controlled
 *     by `opts.shareGlowIntensity`; 0 → plain solid background).
 * Both colors are sanitized first (never inject broken CSS into the renderer).
 * The `opts` param is optional — the old call signature keeps working and the
 * defaults reproduce the original alpha values exactly.
 */
export function cardBackgroundStyle(
  background: unknown,
  accent: unknown,
  shareImageUrl?: string,
  opts?: Partial<Pick<ShareCardOptions, 'shareGlowIntensity' | 'shareImageOverlay'>>,
): string {
  const safeBg = safeCssColor(background, FALLBACK_BG);
  const safeAccent = safeCssColor(accent, FALLBACK_ACCENT);
  const glowF = clampNumber(opts?.shareGlowIntensity, 0, 100, SHARE_CARD_DEFAULTS.shareGlowIntensity) / 100;
  const overlayF = clampNumber(opts?.shareImageOverlay, 0, 100, SHARE_CARD_DEFAULTS.shareImageOverlay) / 100;
  if (shareImageUrl) {
    const top = rampAlpha(OVERLAY_TOP_BASE, OVERLAY_TOP_MAX, overlayF, OVERLAY_BREAKPOINT);
    const bottom = rampAlpha(OVERLAY_BOTTOM_BASE, OVERLAY_BOTTOM_MAX, overlayF, OVERLAY_BREAKPOINT);
    return `linear-gradient(180deg, rgba(0,0,0,${top.toFixed(2)}), rgba(0,0,0,${bottom.toFixed(2)})), url(${shareImageUrl}) center/cover, ${safeBg}`;
  }
  if (glowF <= 0) return safeBg;
  const accentAlpha = rampAlpha(GLOW_ACCENT_BASE, GLOW_ACCENT_MAX, glowF, GLOW_BREAKPOINT);
  const purpleAlpha = rampAlpha(GLOW_PURPLE_BASE, GLOW_PURPLE_MAX, glowF, GLOW_BREAKPOINT);
  return `radial-gradient(circle at 18% 18%, ${hexToRgba(safeAccent, accentAlpha)}, transparent 32%), radial-gradient(circle at 82% 12%, ${hexToRgba('#A855F7', purpleAlpha)}, transparent 30%), ${safeBg}`;
}

/** Strip protocol + trailing slashes for the host shown on the card.
 * NEVER returns an empty string: scheme-only leftovers (e.g. a malformed
 * `https://` env paste) and protocol-only values fall back so the card's
 * top-right domain can never render blank. */
export function cardSiteUrlDisplay(value: unknown, fallback = 'example.com'): string {
  let raw = String(value ?? '').trim().replace(/\/+$/, '');
  // An unresolved Vercel env placeholder (`$vercel_project_production_url`) is
  // never a real domain — never print it on the card.
  if (!raw || raw.includes('$')) return fallback;
  raw = raw.replace(/^https?:\/\//i, '');
  raw = raw.replace(/^\/+/, '').trim();
  if (!raw || raw === 'http:' || raw === 'https:') return fallback;
  return raw;
}

/**
 * Build the full clickable share URL for the admin "copy link" action:
 * keeps an `http(s)://` value, prepends `https://` to a bare domain, and
 * otherwise falls back to the current origin.
 */
export function previewSiteUrl(shareUrl: unknown, origin: string): string {
  const s = String(shareUrl ?? '').trim().replace(/\/+$/, '');
  // Unresolved Vercel placeholders (`$vercel_project_production_url`) are never
  // real domains — fall back to the origin so the admin preview link stays valid.
  if (!s || s.includes('$')) return origin || 'https://example.com';
  if (/^https?:\/\//i.test(s)) return s;
  if (s && !s.includes('://')) return `https://${s}`;
  return origin || 'https://example.com';
}

/**
 * Validate + normalize an image source for CLIENT-side rendering (admin
 * preview, messenger embeds): keeps absolute `http(s)://` and `data:image/…`
 * URLs, resolves root-relative paths (`/images/…`) against the given origin,
 * drops anything else (free text like `a image url` → broken <img>).
 */
export function resolveClientImageSource(value: unknown, origin: string): string {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  if (s.startsWith('/')) return `${String(origin || '').replace(/\/+$/, '')}${s}`;
  return '';
}

/**
 * Convert ANY CSS color into a `#rrggbb` hex string suitable for the `value`
 * attribute of an `<input type="color">`. Color inputs reject `rgba()`/`rgb()`
 * values with "The specified value 'rgba(…)' does not conform to the required
 * format" (which the browser logs once per render — hundreds of times when the
 * theme editor re-renders with `cardBorder: rgba(…)`). Hex values pass through,
 * `rgb()`/`rgba()` are converted channel-wise, everything else falls back.
 */
export function toHexColor(value: unknown, fallback = '#000000'): string {
  const raw = String(value ?? '').trim();
  let s = raw.toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3 || s.length === 4) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (s.length === 6 && /^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  // Drop an 8-digit hex's alpha channel (color inputs can't express alpha).
  if (s.length === 8 && /^[0-9a-f]{8}$/.test(s)) return `#${s.slice(0, 6)}`;
  const rgb = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
    return `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`;
  }
  return fallback;
}

/**
 * Deterministic 8-hex-char content hash (FNV-1a). `generateMetadata` appends it
 * to the `og:image` URL as a cache-buster: whenever branding changes the URL
 * changes, so WhatsApp/Discord/iMessage (which cache previews aggressively by
 * URL) are forced to re-fetch the fresh card instead of showing a stale one.
 */
export function revisionHash(input: unknown): string {
  const s = JSON.stringify(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

