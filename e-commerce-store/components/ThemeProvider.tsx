'use client';

import { createContext, useContext } from 'react';

/**
 * Live /admin → Settings theme, baked into the server-rendered HTML by the root
 * layout. Client pages/components read this through `useLiveTheme()` for their
 * INITIAL palette so the very first paint already uses the saved theme instead
 * of flashing the build-time colors, then their existing /api/store fetch keeps
 * things fresh. SSR and hydration always agree because the provider value comes
 * from the server (RSC props), so there are no hydration mismatches.
 */
export interface LiveThemeValue {
  themeColors?: Record<string, any>;
  branding?: Record<string, any>;
  orbs?: Record<string, any>;
  heroContent?: Record<string, any>;
  copy?: Record<string, any>;
  gallery?: Record<string, any>;
  /** brandFooterData — social links, support email, copyright line. */
  footer?: Record<string, string>;
  /** Legal & policy content for the /terms, /privacy and /shipping pages. */
  legal?: Record<string, string>;
}

const ThemeContext = createContext<LiveThemeValue | null>(null);

export function useLiveTheme(): LiveThemeValue | null {
  return useContext(ThemeContext);
}

/** Also expose the value set by the layout's inline script (cached-HTML fallback). */
export function getInlineTheme(): LiveThemeValue | null {
  if (typeof window === 'undefined') return null;
  try {
    return (window as any).__GOYUNIR_THEME__ || null;
  } catch {
    return null;
  }
}

export default function ThemeProvider({
  value,
  children,
}: {
  value: LiveThemeValue | null;
  children: React.ReactNode;
}) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
