import { isImageMedia } from '@/lib/media';

/**
 * The releases the store home shows, from an /api/store payload: the active
 * ones, else the configured fallback (upcoming, then archived) so the site is
 * never empty. Shared by the page (components/storefront/LegacyHomePage.tsx)
 * and the server, which preloads the hero's cover photo when it renders the
 * first screen (lib/storefront-ssr.ts).
 */
export function homeDisplay(data: any): any[] {
  const all = Array.isArray(data?.allProducts) ? data.allProducts : [];
  const sortFn = (a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name));
  let display = [...all]
    .filter((p: any) => p.isActive === true && p.isArchived !== true && p.isUpcoming !== true)
    .sort(sortFn);
  if (display.length === 0) {
    const fallback = String(data?.config?.layout?.homepageFallback || 'upcoming');
    if (fallback === 'upcoming' || fallback === 'upcoming_then_archived') {
      display = [...all].filter((p: any) => p.isUpcoming === true && p.isArchived !== true).sort(sortFn);
    }
    if (display.length === 0 && (fallback === 'archived' || fallback === 'upcoming_then_archived')) {
      display = [...all].filter((p: any) => p.isArchived === true).sort(sortFn);
    }
  }
  return display;
}

/** The hero's cover: the first IMAGE of the first release ('' when none). */
export function heroCoverOf(display: any[]): string {
  const medias: string[] = (display[0]?.images || []).filter((src: unknown) => typeof src === 'string' && src);
  return medias.find((src) => isImageMedia(src)) || '';
}
