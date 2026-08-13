// Design presets for the admin portal (/admin → Settings → Design Presets).
//
// Each preset is a complete "market persona" mapped onto the store's theme
// tokens (themeColors + glow orbs). Colors are consumed at build time by the
// static pages and live at runtime by SiteChrome, so applying a preset and
// saving it is the fastest way to reskin the whole store for a client's market.
//
// Adding a preset here automatically adds a card to the admin Settings tab —
// no other wiring is required beyond keeping the themeColors keys aligned with
// lib/store-config.ts / lib/storefront-config.ts.

export type ThemePreset = {
  id: string;
  name: string;
  /** The market goal this preset is designed to hit (shown in the admin card). */
  tagline: string;
  /** Display swatch: accent color. */
  accent: string;
  /** Display swatch: page background color. */
  background: string;
  /** Display swatch: container / card background color. */
  container: string;
  fontLabel: string;
  radiusLabel: string;
  themeColors: {
    primaryBackground: string;
    cardBackground: string;
    cardBorder: string;
    accentPurple: string;
    accentBlue: string;
    textMain: string;
    textMuted: string;
    /** Primary text color rendered on card/info-box backgrounds. */
    cardTextMain: string;
    /** Secondary/muted text color rendered on card/info-box backgrounds. */
    cardTextMuted: string;
    checkoutCtaButton: string;
    /** CSS font stack applied to the storefront body. */
    fontFamily: string;
    /** Border radius in px — 0 = square, ~10 = small rounded, 999 = fully rounded. */
    borderRadius: number;
  };
  /** Accent-matched glow orb colors (background orbs; top-bar orb was removed). */
  orbs: {
    primary: { color: string; opacity: number };
    secondary: { color: string; opacity: number };
    tertiary: { color: string; opacity: number };
    fourth: { color: string; opacity: number };
    fifth: { color: string; opacity: number };
  };
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'luxury',
    name: 'Luxury',
    tagline: 'Trust & exclusivity — pure white, metallic gold, rich black. Serif type, square edges.',
    accent: '#D4AF37',
    background: '#FFFFFF',
    container: '#111111',
    fontLabel: 'Serif',
    radiusLabel: 'Square',
    themeColors: {
      primaryBackground: '#FFFFFF',
      cardBackground: '#111111',
      cardBorder: '#262626',
      accentPurple: '#D4AF37',
      accentBlue: '#B08D2A',
      textMain: '#111111',
      textMuted: '#6B7280',
      cardTextMain: '#F7F7F7',
      cardTextMuted: '#9CA3AF',
      checkoutCtaButton: '#111111',
      fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif",
      borderRadius: 0,
    },
    orbs: {
      primary: { color: '#D4AF37', opacity: 12 },
      secondary: { color: '#E7C860', opacity: 18 },
      tertiary: { color: '#B08D2A', opacity: 10 },
      fourth: { color: '#F3E5AB', opacity: 8 },
      fifth: { color: '#8C6D1F', opacity: 6 },
    },
  },
  {
    id: 'hype',
    name: 'Hype Culture',
    tagline: 'High energy & FOMO — matte black, electric red, bold sans-serif, tight drop energy.',
    accent: '#FF3E3E',
    background: '#0B0B0C',
    container: '#161618',
    fontLabel: 'Bold Sans-serif',
    radiusLabel: 'Small rounded',
    themeColors: {
      primaryBackground: '#0B0B0C',
      cardBackground: '#161618',
      cardBorder: '#2A2A2E',
      accentPurple: '#FF3E3E',
      accentBlue: '#FF3E3E',
      textMain: '#FFFFFF',
      textMuted: '#9CA3AF',
      cardTextMain: '#FFFFFF',
      cardTextMuted: '#A1A1AA',
      checkoutCtaButton: '#FF3E3E',
      fontFamily: "'Archivo', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 10,
    },
    orbs: {
      primary: { color: '#FF3E3E', opacity: 16 },
      secondary: { color: '#FF7A5C', opacity: 18 },
      tertiary: { color: '#C81E1E', opacity: 12 },
      fourth: { color: '#FF9D80', opacity: 8 },
      fifth: { color: '#7A1E1E', opacity: 6 },
    },
  },
  {
    id: 'wellness',
    name: 'Wellness',
    tagline: 'Clean, organic, premium health — warm oatmeal, clay tan, deep sage. Rounded type & edges.',
    accent: '#D1B48C',
    background: '#F7F5F0',
    container: '#2C3E2B',
    fontLabel: 'Rounded Sans-serif',
    radiusLabel: 'Fully rounded',
    themeColors: {
      primaryBackground: '#F7F5F0',
      cardBackground: '#2C3E2B',
      cardBorder: '#42563F',
      accentPurple: '#D1B48C',
      accentBlue: '#A98B63',
      textMain: '#222B21',
      textMuted: '#6B7166',
      cardTextMain: '#F5F2EC',
      cardTextMuted: '#C9D4C4',
      checkoutCtaButton: '#2C3E2B',
      fontFamily: "'Nunito', 'Poppins', 'Segoe UI', sans-serif",
      borderRadius: 999,
    },
    orbs: {
      primary: { color: '#C8A97E', opacity: 16 },
      secondary: { color: '#9FBF9B', opacity: 14 },
      tertiary: { color: '#E5D3B8', opacity: 20 },
      fourth: { color: '#7A9A76', opacity: 8 },
      fifth: { color: '#A98B63', opacity: 6 },
    },
  },
];

export function getThemePresetById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id);
}
