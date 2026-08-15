// Design presets for the admin portal (/admin → Settings → Design Presets).
//
// Each preset is a complete "market persona" mapped onto the store's theme
// tokens (themeColors + glow orbs). Colors are consumed at build time by the
// static pages and live at runtime by SiteChrome, so applying a preset and
// saving it is the fastest way to reskin the whole store for a client's market.
//
// EVERY preset now speaks Apple's design language: continuous squircles, heavy
// Liquid-Glass chrome (high backdrop blur + saturation + brightness), soft
// layered card shadows, and generous page spacing — while keeping each
// persona's market identity (colors, type, mood). The flagship "Apple" preset
// is the pure iOS 26 Liquid Glass look.
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
    /** Top bar background — empty = auto (derived from cardBackground + chrome). */
    headerBackground: string;
    /** Top bar text — empty = auto (readable color picked from the header bg). */
    headerText: string;
    /** CSS font stack applied to the storefront body. */
    fontFamily: string;
    /** Border radius in px — 0 = square, ~10 = small rounded, 999 = fully rounded. */
    borderRadius: number;
    /** Header/footer/cart-drawer opacity (0-100). */
    chromeTransparency: number;
    /** Card/surface opacity (0-100). */
    surfaceTransparency: number;
    /** Corner style — 'squircle' (Apple continuous curve) | 'rounded' | 'sharp'. */
    radiusStyle: 'squircle' | 'rounded' | 'sharp';
    /** Soft card shadow intensity (0-100). */
    cardShadow: number;
    /** Frosted-glass backdrop blur (0-100) for the header / drawer / modals. */
    backdropBlur: number;
    /** Page rhythm: 'compact' | 'comfortable' | 'spacious'. */
    contentSpacing: 'compact' | 'comfortable' | 'spacious';
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
    id: 'apple',
    name: 'Apple',
    tagline: 'The full Apple look — iOS 26 Liquid Glass. Vibrant translucency, specular highlights, continuous squircles, SF type, airy rhythm.',
    accent: '#0071e3',
    background: '#f2f2f7',
    container: '#ffffff',
    fontLabel: 'SF Pro',
    radiusLabel: 'Squircle',
    themeColors: {
      primaryBackground: '#f2f2f7',
      cardBackground: '#ffffff',
      cardBorder: 'rgba(0,0,0,0.18)',
      accentPurple: '#bf5af2',
      accentBlue: '#0071e3',
      textMain: '#1d1d1f',
      textMuted: '#3f3f46',
      cardTextMain: '#1d1d1f',
      cardTextMuted: '#3f3f46',
      checkoutCtaButton: '#0071e3',
      headerBackground: '#ffffff',
      headerText: '',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 26,
      chromeTransparency: 56,
      surfaceTransparency: 96,
      radiusStyle: 'squircle',
      cardShadow: 16,
      backdropBlur: 86,
      contentSpacing: 'spacious',
    },
    orbs: {
      primary: { color: '#0071e3', opacity: 14 },
      secondary: { color: '#bf5af2', opacity: 16 },
      tertiary: { color: '#ff375f', opacity: 10 },
      fourth: { color: '#64d2ff', opacity: 10 },
      fifth: { color: '#ff9f0a', opacity: 6 },
    },
  },

  {
    id: 'default',
    name: 'Minimal (Default)',
    tagline: 'Apple design language — soft light, hairline borders, squircle corners, frosted glass. The clean default.',
    accent: '#0071e3',
    background: '#f5f5f7',
    container: '#ffffff',
    fontLabel: 'SF Pro / Inter',
    radiusLabel: 'Squircle',
    themeColors: {
      primaryBackground: '#f2f2f7',
      cardBackground: '#ffffff',
      cardBorder: 'rgba(0,0,0,0.18)',
      accentPurple: '#bf5af2',
      accentBlue: '#0071e3',
      textMain: '#1d1d1f',
      textMuted: '#3f3f46',
      cardTextMain: '#1d1d1f',
      cardTextMuted: '#3f3f46',
      checkoutCtaButton: '#0071e3',
      headerBackground: '#ffffff',
      headerText: '',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 24,
      chromeTransparency: 62,
      surfaceTransparency: 98,
      radiusStyle: 'squircle',
      cardShadow: 14,
      backdropBlur: 80,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#0071e3', opacity: 10 },
      secondary: { color: '#bf5af2', opacity: 12 },
      tertiary: { color: '#ffd60a', opacity: 7 },
      fourth: { color: '#64d2ff', opacity: 7 },
      fifth: { color: '#ff2d55', opacity: 5 },
    },
  },
  {
    id: 'luxury',
    name: 'Luxury',
    tagline: 'Trust & exclusivity — soft porcelain, metallic gold, rich black. Serif type, squircle glass edges.',
    accent: '#D4AF37',
    background: '#FFFFFF',
    container: '#111111',
    fontLabel: 'Serif',
    radiusLabel: 'Sharp',
    themeColors: {
      primaryBackground: '#FAFAF8',
      cardBackground: '#111111',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#D4AF37',
      accentBlue: '#B08D2A',
      textMain: '#111111',
      textMuted: '#3c4450',
      cardTextMain: '#F7F7F7',
      cardTextMuted: '#ccd4de',
      checkoutCtaButton: '#111111',
      headerBackground: '#111111',
      headerText: '',
      fontFamily: "'Playfair Display', Georgia, 'Times New Roman', serif",
      borderRadius: 18,
      chromeTransparency: 66,
      surfaceTransparency: 98,
      radiusStyle: 'squircle',
      cardShadow: 16,
      backdropBlur: 78,
      contentSpacing: 'spacious',
    },
    orbs: {
      primary: { color: '#D4AF37', opacity: 9 },
      secondary: { color: '#E7C860', opacity: 13 },
      tertiary: { color: '#B08D2A', opacity: 7 },
      fourth: { color: '#F3E5AB', opacity: 6 },
      fifth: { color: '#8C6D1F', opacity: 5 },
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
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#0B0B0C',
      cardBackground: '#161618',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#FF3E3E',
      accentBlue: '#FF3E3E',
      textMain: '#FFFFFF',
      textMuted: '#b8bec9',
      cardTextMain: '#FFFFFF',
      cardTextMuted: '#dcdce6',
      checkoutCtaButton: '#FF3E3E',
      headerBackground: '#161618',
      headerText: '',
      fontFamily: "'Archivo', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 20,
      chromeTransparency: 62,
      surfaceTransparency: 96,
      radiusStyle: 'squircle',
      cardShadow: 16,
      backdropBlur: 82,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#FF3E3E', opacity: 13 },
      secondary: { color: '#FF7A5C', opacity: 15 },
      tertiary: { color: '#C81E1E', opacity: 9 },
      fourth: { color: '#FF9D80', opacity: 7 },
      fifth: { color: '#7A1E1E', opacity: 5 },
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
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#F7F5F0',
      cardBackground: '#2C3E2B',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#D1B48C',
      accentBlue: '#A98B63',
      textMain: '#222B21',
      textMuted: '#39443b',
      cardTextMain: '#F5F2EC',
      cardTextMuted: '#e9f2e5',
      checkoutCtaButton: '#2C3E2B',
      headerBackground: '#2C3E2B',
      headerText: '',
      fontFamily: "'Nunito', 'Poppins', 'Segoe UI', sans-serif",
      borderRadius: 24,
      chromeTransparency: 62,
      surfaceTransparency: 98,
      radiusStyle: 'squircle',
      cardShadow: 14,
      backdropBlur: 78,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#C8A97E', opacity: 11 },
      secondary: { color: '#9FBF9B', opacity: 9 },
      tertiary: { color: '#E5D3B8', opacity: 13 },
      fourth: { color: '#7A9A76', opacity: 6 },
      fifth: { color: '#A98B63', opacity: 5 },
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    tagline: 'Magazine-grade luxury — warm paper, ink black, a single crimson accent. Serif type, refined squircles.',
    accent: '#B01E23',
    background: '#F7F4EE',
    container: '#17150F',
    fontLabel: 'Editorial Serif',
    radiusLabel: 'Sharp',
    themeColors: {
      primaryBackground: '#F7F4EE',
      cardBackground: '#17150F',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#B01E23',
      accentBlue: '#8A1418',
      textMain: '#1A1812',
      textMuted: '#40392b',
      cardTextMain: '#F7F2E9',
      cardTextMuted: '#e1d9c6',
      checkoutCtaButton: '#B01E23',
      headerBackground: '#17150F',
      headerText: '',
      fontFamily: "'Playfair Display', 'Iowan Old Style', Georgia, 'Times New Roman', serif",
      borderRadius: 18,
      chromeTransparency: 68,
      surfaceTransparency: 98,
      radiusStyle: 'squircle',
      cardShadow: 14,
      backdropBlur: 76,
      contentSpacing: 'spacious',
    },
    orbs: {
      primary: { color: '#B01E23', opacity: 8 },
      secondary: { color: '#D9B45B', opacity: 11 },
      tertiary: { color: '#8A6D3B', opacity: 7 },
      fourth: { color: '#E8D9B8', opacity: 6 },
      fifth: { color: '#5C1A1E', opacity: 5 },
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
    radiusLabel: 'Squircle',
    themeColors: {
      primaryBackground: '#FFFFFF',
      cardBackground: '#111111',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#0A0A0A',
      accentBlue: '#52525B',
      textMain: '#0A0A0A',
      textMuted: '#3e3e47',
      cardTextMain: '#FAFAFA',
      cardTextMuted: '#dadce4',
      checkoutCtaButton: '#0A0A0A',
      headerBackground: '#111111',
      headerText: '',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 22,
      chromeTransparency: 60,
      surfaceTransparency: 96,
      radiusStyle: 'squircle',
      cardShadow: 14,
      backdropBlur: 80,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#0A0A0A', opacity: 8 },
      secondary: { color: '#52525B', opacity: 10 },
      tertiary: { color: '#D4D4D8', opacity: 9 },
      fourth: { color: '#A1A1AA', opacity: 6 },
      fifth: { color: '#27272A', opacity: 4 },
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
    radiusLabel: 'Rounded',
    themeColors: {
      primaryBackground: '#0B1420',
      cardBackground: '#111D2E',
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#C9A227',
      accentBlue: '#8FA8C8',
      textMain: '#F2F5F9',
      textMuted: '#b7c3d4',
      cardTextMain: '#F5F1E6',
      cardTextMuted: '#d8e1ec',
      checkoutCtaButton: '#C9A227',
      headerBackground: '#111D2E',
      headerText: '',
      fontFamily: "'IBM Plex Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      borderRadius: 20,
      chromeTransparency: 64,
      surfaceTransparency: 96,
      radiusStyle: 'squircle',
      cardShadow: 16,
      backdropBlur: 80,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#C9A227', opacity: 8 },
      secondary: { color: '#2E4A6E', opacity: 13 },
      tertiary: { color: '#8FA8C8', opacity: 8 },
      fourth: { color: '#F0D88C', opacity: 5 },
      fifth: { color: '#17324F', opacity: 7 },
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
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#D4AF37',
      accentBlue: '#B89B5E',
      textMain: '#F7F2E9',
      textMuted: '#cfc6b3',
      cardTextMain: '#F7F2E9',
      cardTextMuted: '#e5decc',
      checkoutCtaButton: '#D4AF37',
      headerBackground: '#121212',
      headerText: '',
      fontFamily: "'Cormorant Garamond', 'Playfair Display', Georgia, serif",
      borderRadius: 20,
      chromeTransparency: 64,
      surfaceTransparency: 96,
      radiusStyle: 'squircle',
      cardShadow: 16,
      backdropBlur: 80,
      contentSpacing: 'spacious',
    },
    orbs: {
      primary: { color: '#D4AF37', opacity: 8 },
      secondary: { color: '#5C4A1E', opacity: 13 },
      tertiary: { color: '#B89B5E', opacity: 8 },
      fourth: { color: '#F0D88C', opacity: 5 },
      fifth: { color: '#3A2F14', opacity: 7 },
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
      cardBorder: 'rgba(255,255,255,0.20)',
      accentPurple: '#e879f9',
      accentBlue: '#22d3ee',
      textMain: '#f0f9ff',
      textMuted: '#b1bfd6',
      cardTextMain: '#f0f9ff',
      cardTextMuted: '#cfdbec',
      checkoutCtaButton: '#22d3ee',
      headerBackground: '#0b0f1a',
      headerText: '',
      fontFamily: "'Space Grotesk', 'Inter', 'Segoe UI', Arial, sans-serif",
      borderRadius: 22,
      chromeTransparency: 60,
      surfaceTransparency: 94,
      radiusStyle: 'squircle',
      cardShadow: 18,
      backdropBlur: 86,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#22d3ee', opacity: 12 },
      secondary: { color: '#e879f9', opacity: 14 },
      tertiary: { color: '#38bdf8', opacity: 8 },
      fourth: { color: '#a78bfa', opacity: 7 },
      fifth: { color: '#f472b6', opacity: 5 },
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
    radiusLabel: 'Squircle',
    themeColors: {
      primaryBackground: '#FAF6EF',
      cardBackground: '#FFFFFF',
      cardBorder: 'rgba(0,0,0,0.18)',
      accentPurple: '#C05B3C',
      accentBlue: '#8A6D3B',
      textMain: '#241C14',
      textMuted: '#473f31',
      cardTextMain: '#241C14',
      cardTextMuted: '#473f31',
      checkoutCtaButton: '#C05B3C',
      headerBackground: '#FFFFFF',
      headerText: '',
      fontFamily: "'Sora', 'Inter', 'Segoe UI', Arial, sans-serif",
      borderRadius: 24,
      chromeTransparency: 60,
      surfaceTransparency: 98,
      radiusStyle: 'squircle',
      cardShadow: 14,
      backdropBlur: 80,
      contentSpacing: 'comfortable',
    },
    orbs: {
      primary: { color: '#C05B3C', opacity: 8 },
      secondary: { color: '#8A6D3B', opacity: 8 },
      tertiary: { color: '#E7DFD1', opacity: 11 },
      fourth: { color: '#F0D88C', opacity: 5 },
      fifth: { color: '#B08968', opacity: 4 },
    },
  },
];

export function getThemePresetById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id);
}
