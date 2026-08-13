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
 * Token resolution order (same contract as the standalone checkout pages in
 * /public):
 *   1. window.ENV_MAPBOX_TOKEN                  — runtime injection by the host.
 *   2. #search-js[data-mapbox-token]            — baked into the HTML at build
 *      time by scripts/inject-mapbox-token.mjs.
 *   3. NEXT_PUBLIC_MAPBOX_TOKEN                 — inlined by Next.js at build.
 *   4. NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN          — accepted alias.
 *   5. localhost-only dev override              — ?mapbox_token=… or
 *      localStorage "mapbox_dev_token" (never used outside localhost).
 *
 * Without a token this is a no-op (autofill is simply OFF) and the forms keep
 * working via native browser autofill + manual entry. The status is surfaced
 * through console logs and window.__GOYUNIR_MAPBOX__ so a missing token is
 * never a silent mystery.
 *
 * Verification tracking: when a customer picks a suggestion the SDK fires a
 * `retrieve` event on the collection. That selected address is recorded and
 * `isMapboxVerifiedAddress()` lets the checkout submit handlers require a
 * real, Mapbox-verified address whenever autofill is live — so customers can
 * no longer type any random string into the shipping field.
 */

declare global {
  interface Window {
    ENV_MAPBOX_TOKEN?: string;
    mapboxsearch?: {
      autofill: (options: { accessToken: string; options?: Record<string, unknown> }) => AddressAutofillCollection;
    };
    __GOYUNIR_MAPBOX__?: GoyunirMapboxStatus;
  }
}

type AddressAutofillCollection = {
  observe?: () => void;
  update?: () => void;
  remove?: () => void;
  addEventListener?: (type: string, handler: (event: any) => void) => void;
  removeEventListener?: (type: string, handler: (event: any) => void) => void;
};

export type GoyunirMapboxStatus =
  | { status: 'no-token'; token: false; error?: undefined }
  | { status: 'loading'; token: true; error?: undefined }
  | { status: 'active'; token: true; error?: undefined }
  | { status: 'sdk-missing'; token: true; error?: string }
  | { status: 'failed'; token: true; error?: string };

const MAPBOX_SDK_URL = 'https://api.mapbox.com/search-js/v1.6.0/web.js';
const PLACEHOLDER_ATTR = '__NEXT_PUBLIC_MAPBOX_TOKEN__';

let sdkLoadPromise: Promise<void> | null = null;
let collection: AddressAutofillCollection | null = null;
let status: GoyunirMapboxStatus = { status: 'no-token', token: false };
// Exact street-address strings that came from a Mapbox suggestion this session.
const verifiedAddresses = new Set<string>();

function setStatus(next: GoyunirMapboxStatus): void {
  status = next;
  if (typeof window !== 'undefined') {
    window.__GOYUNIR_MAPBOX__ = { ...next };
  }
}

function isLocalhostHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}


export function resolveMapboxToken(): string {
  if (typeof window === 'undefined') return '';
  if (window.ENV_MAPBOX_TOKEN) return window.ENV_MAPBOX_TOKEN.trim();

  const marker = document.getElementById('search-js');
  if (marker) {
    const attr = marker.getAttribute('data-mapbox-token') || '';
    if (attr && attr !== PLACEHOLDER_ATTR) return attr.trim();
  }

  const buildToken = (
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
    process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
    ''
  ).trim();
  if (buildToken) return buildToken;

  // Localhost-only dev override — never read on a production host. Lets you
  // test the real dropdown locally by opening the site with
  //   ?mapbox_token=pk.eyJ…   (or setting localStorage "mapbox_dev_token").
  if (isLocalhostHost()) {
    try {
      const qs = new URLSearchParams(window.location.search).get('mapbox_token');
      if (qs) return qs.trim();
      const ls = window.localStorage.getItem('mapbox_dev_token');
      if (ls) return ls.trim();
    } catch {
      /* ignore storage/query errors */
    }
  }
  return '';
}

/** Current autofill status — mirror of window.__GOYUNIR_MAPBOX__. */
export function getMapboxStatus(): GoyunirMapboxStatus {
  return { ...status };
}

/** True once the SDK loaded and the autofill collection is observing the page. */
export function isMapboxAutofillActive(): boolean {
  return status.status === 'active';
}

/**
 * True when the given address matches one that the customer picked from the
 * Mapbox suggestions this session. Matching allows the customer to append an
 * apartment/suite to a verified street line.
 */
export function isMapboxVerifiedAddress(address: string): boolean {
  const v = String(address || '').trim().toLowerCase();
  if (!v || verifiedAddresses.size === 0) return false;
  for (const known of verifiedAddresses) {
    const k = known.toLowerCase();
    if (v === k || v.startsWith(k)) return true;
  }
  return false;
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
    sdk.onerror = () => {
      console.warn('[mapbox-autofill] Failed to load the Mapbox SDK from ' + MAPBOX_SDK_URL);
      resolve();
    };
    document.head.appendChild(sdk);
  });
  return sdkLoadPromise;
}

function handleRetrieve(event: any): void {
  const input = event && (event.target as HTMLInputElement | undefined);
  // The SDK fires `retrieve` just before it fills the address fields, so defer
  // the capture by one tick to read the final filled street value.
  window.setTimeout(() => {
    const el = input && typeof input.value === 'string' ? input : null;
    const filled = el ? el.value.trim() : '';
    if (!filled) return;
    verifiedAddresses.add(filled);
    if (el) {
      el.setAttribute('data-mapbox-verified', 'true');
      el.setAttribute('data-mapbox-verified-value', filled);
      if (el.form) el.form.setAttribute('data-mapbox-verified', 'true');
    }
  }, 0);
}

function watchManualEdits(): void {
  document.addEventListener(
    'input',
    (e) => {
      const target = e.target as HTMLInputElement | null;
      if (!target || !target.dataset) return;
      if (target.dataset.mapboxVerified !== 'true') return;
      const expected = target.dataset.mapboxVerifiedValue || '';
      if (expected && target.value.trim() !== expected) {
        target.dataset.mapboxVerified = 'false';
      }
    },
    true
  );
}

/**
 * Attach Mapbox address autofill to the page. Safe to call from multiple
 * components and on every mount: the SDK + collection are created only once,
 * and the collection's MutationObserver attaches to inputs rendered later.
 */
export async function ensureMapboxAutofill(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (status.status === 'loading' || status.status === 'active') return;

  const token = resolveMapboxToken();
  if (!token) {
    setStatus({ status: 'no-token', token: false });
    console.info(
      '[mapbox-autofill] No Mapbox token configured — address autofill is OFF. ' +
        'Set NEXT_PUBLIC_MAPBOX_TOKEN (Vercel → Project Settings → Environment Variables) and redeploy.'
    );
    return;
  }

  setStatus({ status: 'loading', token: true });
  await loadMapboxSdk();
  const mapbox = window.mapboxsearch;
  if (!mapbox || typeof mapbox.autofill !== 'function') {
    setStatus({ status: 'sdk-missing', token: true });
    console.warn('[mapbox-autofill] The Mapbox SDK did not load, so autofill is unavailable.');
    return;
  }
  if (collection) {
    setStatus({ status: 'active', token: true });
    return;
  }
  try {
    collection = mapbox.autofill({ accessToken: token });
    if (collection && typeof collection.observe === 'function') {
      // Watch the document for inputs added later (e.g. the cart drawer).
      collection.observe();
    }
    if (collection && typeof collection.addEventListener === 'function') {
      collection.addEventListener('retrieve', handleRetrieve);
    }
    watchManualEdits();
    setStatus({ status: 'active', token: true });
    console.info('[mapbox-autofill] Address autofill is ACTIVE. Requests will count on your Mapbox dashboard.');
  } catch (err) {
    setStatus({
      status: 'failed',
      token: true,
      error: err instanceof Error ? err.message : String(err),
    });
    console.error('[autofill] init failed', err);
  }
}
