// Theme-palette → GLSL accent-vector extraction.
//
// Pure module (no React / no `@/` imports) so `node --test` can load it. The
// hero shader renders with THREE accent colors; this helper derives them from
// the live storefront theme so a preset always matches the brand's palette.

export type Vec3 = [number, number, number];

export interface AccentPalette {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

export function hexToRgb(hex: string): Vec3 {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  if (h.length !== 6 || !Number.isFinite(num)) return [0.5, 0.5, 0.5];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function firstDefined(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Derive the three GLSL accent vectors from the active theme palette. Uses the
 * accent keys the storefront already exposes (accentPurple / accentBlue /
 * checkoutCtaButton / cardBackground), falling back to brand-safe neutrals so
 * an unseeded theme can never produce a black screen.
 */
export function extractAccentPalette(themeColors: Record<string, any> | undefined | null): AccentPalette {
  const t = themeColors || {};
  const a = firstDefined(t.accentPurple, t.accentGold, '#bf5af2');
  const b = firstDefined(t.accentBlue, t.checkoutCtaButton, '#0071e3');
  const c = firstDefined(t.accentPink, t.accentOrange, t.accentGreen, t.cardBackground, '#ff375f');
  return { a: hexToRgb(a), b: hexToRgb(b), c: hexToRgb(c) };
}

/** Convert an accent palette back to CSS color strings (for the CSS fallback). */
export function paletteToCss(p: AccentPalette): [string, string, string] {
  const css = (v: Vec3) => `rgb(${Math.round(v[0] * 255)}, ${Math.round(v[1] * 255)}, ${Math.round(v[2] * 255)})`;
  return [css(p.a), css(p.b), css(p.c)];
}

/** True when two accent palettes are meaningfully different (for recompile checks). */
export function paletteEquals(x: AccentPalette, y: AccentPalette): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(x.a[i] - y.a[i]) > 1e-4) return false;
    if (Math.abs(x.b[i] - y.b[i]) > 1e-4) return false;
    if (Math.abs(x.c[i] - y.c[i]) > 1e-4) return false;
  }
  return true;
}
