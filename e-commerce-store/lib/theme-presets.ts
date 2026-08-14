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
    /** Header/footer/cart-drawer opacity (0-100). */
    chromeTransparency: number;
    /** Card/surface opacity (0-100). */
    surfaceTransparency: number;
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
    id: 'default',
    name: 'Default (Stock)',
    tagline: 'Restores the exact stock GOYUNIR theme — matte black, violet/blue accents, Inter type.',
    accent: '#635bff',
    background: '#0a0a0a',
    container: '#111111',
    fontLabel: 'Inter Sans',
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#0a0a0a',
      cardBackground: '#111111',
      cardBorder: '#222222',
      accentPurple: '#a855f7',
      accentBlue: '#3b82f6',
      textMain: '#ffffff',
      textMuted: '#888888',
      cardTextMain: '#ffffff',
      cardTextMuted: '#c9c9d3',
      checkoutCtaButton: '#635bff',
      fontFamily: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 12,
      chromeTransparency: 94,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#3b82f6', opacity: 16 },
      secondary: { color: '#a855f7', opacity: 26 },
      tertiary: { color: '#ffd79b', opacity: 12 },
      fourth: { color: '#7dd3fc', opacity: 10 },
      fifth: { color: '#f472b6', opacity: 8 },
    },
  },
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
      borderRadius: 1,
      chromeTransparency: 96,
      surfaceTransparency: 100,
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
      borderRadius: 6,
      chromeTransparency: 90,
      surfaceTransparency: 100,
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
      chromeTransparency: 92,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#C8A97E', opacity: 16 },
      secondary: { color: '#9FBF9B', opacity: 14 },
      tertiary: { color: '#E5D3B8', opacity: 20 },
      fourth: { color: '#7A9A76', opacity: 8 },
      fifth: { color: '#A98B63', opacity: 6 },
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    tagline: 'Magazine-grade luxury — warm paper, ink black, a single crimson accent. Serif type, crisp edges.',
    accent: '#B01E23',
    background: '#F7F4EE',
    container: '#17150F',
    fontLabel: 'Editorial Serif',
    radiusLabel: 'Square',
    themeColors: {
      primaryBackground: '#F7F4EE',
      cardBackground: '#17150F',
      cardBorder: '#2E2A20',
      accentPurple: '#B01E23',
      accentBlue: '#8A1418',
      textMain: '#1A1812',
      textMuted: '#6E6A5E',
      cardTextMain: '#F7F2E9',
      cardTextMuted: '#BDB6A6',
      checkoutCtaButton: '#B01E23',
      fontFamily: "'Playfair Display', 'Iowan Old Style', Georgia, 'Times New Roman', serif",
      borderRadius: 2,
      chromeTransparency: 96,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#B01E23', opacity: 10 },
      secondary: { color: '#D9B45B', opacity: 14 },
      tertiary: { color: '#8A6D3B', opacity: 10 },
      fourth: { color: '#E8D9B8', opacity: 8 },
      fifth: { color: '#5C1A1E', opacity: 6 },
    },
  },
  {
    id: 'monochrome',
    name: 'Monochrome',
    tagline: 'Relentless minimalism — pure white, pure black, zero noise. The "flagship tech" skin.',
    accent: '#0A0A0A',
    background: '#FFFFFF',
    container: '#111111',
    fontLabel: 'Minimal Sans',
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#FFFFFF',
      cardBackground: '#111111',
      cardBorder: '#E4E4E7',
      accentPurple: '#0A0A0A',
      accentBlue: '#52525B',
      textMain: '#0A0A0A',
      textMuted: '#71717A',
      cardTextMain: '#FAFAFA',
      cardTextMuted: '#A1A1AA',
      checkoutCtaButton: '#0A0A0A',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
      borderRadius: 14,
      chromeTransparency: 92,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#0A0A0A', opacity: 6 },
      secondary: { color: '#52525B', opacity: 8 },
      tertiary: { color: '#D4D4D8', opacity: 12 },
      fourth: { color: '#A1A1AA', opacity: 8 },
      fifth: { color: '#27272A', opacity: 5 },
    },
  },
  {
    id: 'navy',
    name: 'Deep Navy',
    tagline: 'Quiet institutional trust — midnight navy, antique gold, cream type. Private-banking energy.',
    accent: '#C9A227',
    background: '#0B1420',
    container: '#111D2E',
    fontLabel: 'Navy Sans',
    radiusLabel: 'Square',
    themeColors: {
      primaryBackground: '#0B1420',
      cardBackground: '#111D2E',
      cardBorder: '#1E2C40',
      accentPurple: '#C9A227',
      accentBlue: '#8FA8C8',
      textMain: '#F2F5F9',
      textMuted: '#8A97A8',
      cardTextMain: '#F5F1E6',
      cardTextMuted: '#AAB6C6',
      checkoutCtaButton: '#C9A227',
      fontFamily: "'IBM Plex Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 4,
      chromeTransparency: 94,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#C9A227', opacity: 10 },
      secondary: { color: '#2E4A6E', opacity: 16 },
      tertiary: { color: '#8FA8C8', opacity: 10 },
      fourth: { color: '#F0D88C', opacity: 6 },
      fifth: { color: '#17324F', opacity: 8 },
    },
  },
  {
    id: 'noir',
    name: 'Golden Noir',
    tagline: 'Old-money nightlife — matte black, champagne gold, ivory type. Dressed-up exclusivity.',
    accent: '#D4AF37',
    background: '#070707',
    container: '#121212',
    fontLabel: 'Editorial Serif',
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#070707',
      cardBackground: '#121212',
      cardBorder: '#26211A',
      accentPurple: '#D4AF37',
      accentBlue: '#B89B5E',
      textMain: '#F7F2E9',
      textMuted: '#8E8674',
      cardTextMain: '#F7F2E9',
      cardTextMuted: '#B8B0A0',
      checkoutCtaButton: '#D4AF37',
      fontFamily: "'Cormorant Garamond', 'Playfair Display', Georgia, serif",
      borderRadius: 10,
      chromeTransparency: 94,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#D4AF37', opacity: 10 },
      secondary: { color: '#5C4A1E', opacity: 16 },
      tertiary: { color: '#B89B5E', opacity: 10 },
      fourth: { color: '#F0D88C', opacity: 6 },
      fifth: { color: '#3A2F14', opacity: 8 },
    },
  },
  {
    id: 'neon',
    name: 'Cyber Neon',
    tagline: 'Night-drop energy — near-black, electric cyan, hot magenta. Built for hype streetwear drops.',
    accent: '#22d3ee',
    background: '#05060a',
    container: '#0b0f1a',
    fontLabel: 'Minimal Sans',
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#05060a',
      cardBackground: '#0b0f1a',
      cardBorder: '#1c2740',
      accentPurple: '#e879f9',
      accentBlue: '#22d3ee',
      textMain: '#f0f9ff',
      textMuted: '#7c8aa0',
      cardTextMain: '#f0f9ff',
      cardTextMuted: '#9fb0c9',
      checkoutCtaButton: '#22d3ee',
      fontFamily: "'Space Grotesk', 'Inter', 'Segoe UI', Arial, sans-serif",
      borderRadius: 12,
      chromeTransparency: 92,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#22d3ee', opacity: 14 },
      secondary: { color: '#e879f9', opacity: 18 },
      tertiary: { color: '#38bdf8', opacity: 10 },
      fourth: { color: '#a78bfa', opacity: 8 },
      fifth: { color: '#f472b6', opacity: 6 },
    },
  },
  {
    id: 'paper',
    name: 'Warm Paper',
    tagline: 'Soft gallery light — warm cream, coffee ink, terracotta accent. Approachable and editorial.',
    accent: '#C05B3C',
    background: '#FAF6EF',
    container: '#FFFFFF',
    fontLabel: 'Minimal Sans',
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#FAF6EF',
      cardBackground: '#FFFFFF',
      cardBorder: '#E7DFD1',
      accentPurple: '#C05B3C',
      accentBlue: '#8A6D3B',
      textMain: '#241C14',
      textMuted: '#7A6F61',
      cardTextMain: '#241C14',
      cardTextMuted: '#7A6F61',
      checkoutCtaButton: '#C05B3C',
      fontFamily: "'Sora', 'Inter', 'Segoe UI', Arial, sans-serif",
      borderRadius: 16,
      chromeTransparency: 96,
      surfaceTransparency: 100,
    },
    orbs: {
      primary: { color: '#C05B3C', opacity: 8 },
      secondary: { color: '#8A6D3B', opacity: 10 },
      tertiary: { color: '#E7DFD1', opacity: 16 },
      fourth: { color: '#F0D88C', opacity: 6 },
      fifth: { color: '#B08968', opacity: 5 },
    },
  },
];

export function getThemePresetById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id);
}
