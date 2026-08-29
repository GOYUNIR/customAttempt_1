/**
 * Font catalog — the single source of truth for the admin Settings font pickers.
 *
 * Imported by BOTH the admin portal (searchable dropdowns) and the root layout
 * (the Google Fonts <link> that actually loads each family), so the picker list
 * and the loaded @font-face rules can never drift out of sync.
 *
 * Every Google Font carries its CSS `value` (the `font-family` stack written to
 * the saved theme/branding) plus its Google family name + weights used to build
 * the Google Fonts CSS2 URL. System fonts have no Google family (they render
 * from the visitor's OS, no download required).
 */

export type FontOption = {
  /** Human label shown in the picker (also the searchable text). */
  label: string;
  /** The CSS font-family stack persisted to the saved settings. */
  value: string;
  /** Loose grouping for a small label in the picker. */
  category: 'Sans' | 'Serif' | 'Display' | 'Mono' | 'System';
  /** Google Fonts family name (space-separated) when this needs a download. */
  googleFamily?: string;
  /** Google Fonts weights to load (only used when googleFamily is set). */
  weights?: string[];
};

export const FONT_CATALOG: FontOption[] = [
  // ── System (no download) ────────────────────────────────────────────────────
  { label: 'SF Pro / system (Apple default)', value: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", category: 'System' },
  { label: 'System UI — native platform font', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif", category: 'System' },
  { label: 'Georgia — classic book serif', value: "Georgia, 'Times New Roman', serif", category: 'System' },
  { label: 'Monospace — terminal / technical', value: "'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace", category: 'System' },

  // ── Sans (Google Fonts) ─────────────────────────────────────────────────────
  { label: 'Inter — clean modern sans', value: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Inter', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Poppins — geometric friendly sans', value: "'Poppins', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Poppins', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Montserrat — bold urban sans', value: "'Montserrat', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Montserrat', weights: ['400', '500', '600', '700', '800'] },
  { label: 'DM Sans — low-contrast modern sans', value: "'DM Sans', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'DM Sans', weights: ['400', '500', '700'] },
  { label: 'Manrope — warm geometric sans', value: "'Manrope', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Manrope', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Space Grotesk — techy geometric sans', value: "'Space Grotesk', 'Inter', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Space Grotesk', weights: ['400', '500', '600', '700'] },
  { label: 'Sora — rounded friendly sans', value: "'Sora', 'Inter', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Sora', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Outfit — crisp contemporary sans', value: "'Outfit', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Outfit', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Plus Jakarta Sans — airy product sans', value: "'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Plus Jakarta Sans', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Figtree — friendly rounded sans', value: "'Figtree', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Figtree', weights: ['400', '500', '600', '700', '800'] },
  { label: 'IBM Plex Sans — crisp corporate sans', value: "'IBM Plex Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif", category: 'Sans', googleFamily: 'IBM Plex Sans', weights: ['400', '500', '600', '700'] },
  { label: 'Archivo — bold condensed sans', value: "'Archivo', 'Helvetica Neue', Arial, sans-serif", category: 'Sans', googleFamily: 'Archivo', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Nunito — soft rounded sans', value: "'Nunito', 'Poppins', 'Segoe UI', sans-serif", category: 'Sans', googleFamily: 'Nunito', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Raleway — elegant wide sans', value: "'Raleway', 'Segoe UI', Arial, sans-serif", category: 'Sans', googleFamily: 'Raleway', weights: ['400', '500', '600', '700', '800'] },

  // ── Serif (Google Fonts) ────────────────────────────────────────────────────
  { label: 'Playfair Display — elegant editorial serif', value: "'Playfair Display', Georgia, 'Times New Roman', serif", category: 'Serif', googleFamily: 'Playfair Display', weights: ['400', '500', '600', '700', '800'] },
  { label: 'Cormorant Garamond — luxury fashion serif', value: "'Cormorant Garamond', 'Playfair Display', Georgia, serif", category: 'Serif', googleFamily: 'Cormorant Garamond', weights: ['400', '500', '600', '700'] },
  { label: 'Fraunces — soft editorial serif', value: "'Fraunces', Georgia, serif", category: 'Serif', googleFamily: 'Fraunces', weights: ['400', '500', '600', '700', '900'] },
  { label: 'Lora — readable book serif', value: "'Lora', Georgia, 'Times New Roman', serif", category: 'Serif', googleFamily: 'Lora', weights: ['400', '500', '600', '700'] },
  { label: 'Libre Baskerville — refined classic serif', value: "'Libre Baskerville', Georgia, serif", category: 'Serif', googleFamily: 'Libre Baskerville', weights: ['400', '700'] },

  // ── Display (Google Fonts) ──────────────────────────────────────────────────
  { label: 'Bebas Neue — tall condensed display', value: "'Bebas Neue', 'Arial Narrow', sans-serif", category: 'Display', googleFamily: 'Bebas Neue', weights: ['400'] },
  { label: 'Oswald — condensed sans display', value: "'Oswald', 'Arial Narrow', sans-serif", category: 'Display', googleFamily: 'Oswald', weights: ['400', '500', '600', '700'] },

  // ── Mono (Google Fonts) ─────────────────────────────────────────────────────
  { label: 'JetBrains Mono — modern developer mono', value: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", category: 'Mono', googleFamily: 'JetBrains Mono', weights: ['400', '500', '600', '700'] },
  { label: 'Space Mono — quirky terminal mono', value: "'Space Mono', Consolas, monospace", category: 'Mono', googleFamily: 'Space Mono', weights: ['400', '700'] },
];

/** The Google Fonts CSS2 URL that loads every download-required family above. */
export const GOOGLE_FONTS_HREF = (() => {
  const families = FONT_CATALOG.filter((f) => f.googleFamily && f.weights?.length);
  const query = families
    .map((f) => `family=${encodeURIComponent(f.googleFamily!)}:wght@${(f.weights as string[]).join(';')}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
})();

/** Resolve a saved CSS stack back to its catalog label (undefined when custom). */
export function fontLabelFor(value: string): string | undefined {
  const v = String(value || '').trim();
  return FONT_CATALOG.find((f) => f.value === v)?.label;
}
