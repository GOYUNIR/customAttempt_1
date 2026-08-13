'use client';

/**
 * Client-side Mapbox Address Autofill bootstrap for the React storefront
 * (item-page entry form + cart drawer).
 *
 * The Mapbox Search JS SDK is loaded lazily and attached exactly once per page
 * load. The AddressAutofillCollection returned by `autofill()` keeps a
 * MutationObserver on the document, so inputs that mount later (e.g. the cart
 * drawer's shipping field) are picked up automatically — components just call
 * `ensureMapboxAutofill()` on mount.
 *
 * Token resolution order (same contract as the standalone checkout pages):
 *   1. window.ENV_MAPBOX_TOKEN   — runtime injection by the hosting layer.
 *   2. NEXT_PUBLIC_MAPBOX_TOKEN  — inlined by Next.js at build time.
 *
 * Without a token this is a no-op and the forms keep working via native
 * browser autofill + manual entry.
 */

declare global {
  interface Window {
    ENV_MAPBOX_TOKEN?: string;
    mapboxsearch?: {
      autofill: (options: { accessToken: string }) => {
        observe?: () => void;
        update?: () => void;
        remove?: () => void;
      };
    };
  }
}

const MAPBOX_SDK_URL = 'https://api.mapbox.com/search-js/v1.6.0/web.js';

let sdkLoadPromise: Promise<void> | null = null;
let collection: {
  observe?: () => void;
  update?: () => void;
  remove?: () => void;
} | null = null;

export function resolveMapboxToken(): string {
  if (typeof window !== 'undefined' && window.ENV_MAPBOX_TOKEN) {
    return window.ENV_MAPBOX_TOKEN;
  }
  return (process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '').trim();
}

function loadMapboxSdk(): Promise<void> {
  if (sdkLoadPromise) return sdkLoadPromise;
  if (typeof window === 'undefined' || window.mapboxsearch) {
    sdkLoadPromise = Promise.resolve();
    return sdkLoadPromise;
  }
  sdkLoadPromise = new Promise((resolve) => {
    const sdk = document.createElement('script');
    sdk.src = MAPBOX_SDK_URL;
    sdk.async = true;
    sdk.onload = () => resolve();
    sdk.onerror = () => resolve();
    document.head.appendChild(sdk);
  });
  return sdkLoadPromise;
}

/**
 * Attach Mapbox address autofill to the page. Safe to call from multiple
 * components and on every mount: the SDK + collection are created only once,
 * and the collection's MutationObserver attaches to inputs rendered later.
 */
export async function ensureMapboxAutofill(): Promise<void> {
  const token = resolveMapboxToken();
  if (!token) return;
  await loadMapboxSdk();
  const mapbox = window.mapboxsearch;
  if (!mapbox || typeof mapbox.autofill !== 'function') return;
  if (collection) return;
  try {
    collection = mapbox.autofill({ accessToken: token });
    if (collection && typeof collection.observe === 'function') {
      // Watch the document for inputs added later (e.g. the cart drawer).
      collection.observe();
    }
  } catch (err) {
    console.error('[autofill] init failed', err);
  }
}
