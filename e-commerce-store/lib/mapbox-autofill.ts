'use client';

/**
 * Client-side Mapbox Address Autofill bootstrap for the React storefront
 * (item-page entry form + cart drawer).
 *
 * The Mapbox Search JS SDK is loaded lazily and attached exactly once per page
 * load. Inputs that mount later (e.g. the cart drawer's shipping field) are
 * picked up automatically by our own guarded MutationObserver — components just
 * call `ensureMapboxAutofill()` on mount.
 *
 * IMPORTANT — why we do NOT call the SDK's `collection.observe()`:
 * Mapbox search-js v1.6.0 (the latest release) has a stack-overflow bug on
 * React pages. Its `observe()` installs a document-wide MutationObserver whose
 * callback re-scans the shipping inputs and compares the old/new element lists
 * with a naive `deepEquals()` that has NO cycle detection. React mounts its
 * fiber bookkeeping as an ENUMERABLE own property on DOM nodes
 * (`__reactFiber$…`), and that object is circular (fiber.stateNode → element →
 * __reactFiber$… → …). So the first DOM mutation after `observe()` makes the
 * SDK recurse forever and throw
 *   Uncaught RangeError: Maximum call stack size exceeded
 * (stack frame maps to src/utils/index.ts → `deepEquals`). This module instead
 * runs its own identity-based MutationObserver and only calls the SDK's
 * `update()` when the set of shipping inputs actually changed — same behaviour,
 * no crash.
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

// ── SDK observe() workaround ─────────────────────────────────────────────────
// We deliberately never call collection.observe(): the SDK's MutationObserver
// deep-compares the shipping inputs (deepEquals, no cycle detection) and React
// DOM nodes carry a circular enumerable __reactFiber$… property, so any DOM
// mutation blows the stack ("Maximum call stack size exceeded"). Instead we
// watch the document with our own observer that compares inputs BY IDENTITY and
// calls collection.update() only when the input set actually changed.
let autofillObserver: MutationObserver | null = null;
let attachedInputs: HTMLInputElement[] = [];

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

/** True once the SDK loaded and autofill is attached to the page. */
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

/** Street-address inputs the SDK attaches to (same selector the SDK uses). */
function findAddressInputs(): HTMLInputElement[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return [];
  try {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[autocomplete~="street-address"], input[autocomplete~="address-line1"]'
      )
    );
  } catch {
    return [];
  }
}

/** True when the two input lists contain the same elements (order-insensitive). */
function inputsEqual(a: HTMLInputElement[], b: HTMLInputElement[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const el of b) {
    if (!seen.has(el)) return false;
  }
  return true;
}

/**
 * Attach the SDK to any street-address input that mounted since the last pass
 * (e.g. the cart drawer's shipping field). Comparison is by identity only —
 * never deep-equality — so React's circular `__reactFiber$…` DOM properties
 * can never make this recurse. No-op when nothing changed.
 */
export function resyncMapboxAutofill(): void {
  if (!collection || typeof collection.update !== 'function') return;
  const current = findAddressInputs();
  if (inputsEqual(current, attachedInputs)) return;
  attachedInputs = current;
  try {
    collection.update();
  } catch (err) {
    console.warn('[mapbox-autofill] Failed to attach autofill to a newly mounted input.', err);
  }
}

/**
 * Watch the document for shipping inputs that mount later. Replaces the SDK's
 * own `observe()`, whose MutationObserver callback crashed on React DOM nodes
 * (deepEquals stack overflow — see the module comment at the top).
 */
function startAutofillObserver(): void {
  if (autofillObserver || typeof window === 'undefined' || typeof MutationObserver === 'undefined') {
    return;
  }
  autofillObserver = new MutationObserver(() => {
    resyncMapboxAutofill();
  });
  autofillObserver.observe(document, { subtree: true, childList: true });
  // Attach to anything already in the DOM (no-op if the constructor did it).
  resyncMapboxAutofill();
}

/**
 * Attach Mapbox address autofill to the page. Safe to call from multiple
 * components and on every mount: the SDK + collection are created only once,
 * and our identity-based MutationObserver attaches to inputs rendered later.
 */
export async function ensureMapboxAutofill(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (status.status === 'loading') return;
  if (status.status === 'active') {
    // Already running — pick up any input that mounted since the last observer
    // tick (no-op unless the input set actually changed).
    resyncMapboxAutofill();
    return;
  }

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
    // Capture the inputs the SDK constructor is about to attach to, so our own
    // resync below doesn't re-attach (and re-name) the same elements.
    attachedInputs = findAddressInputs();
    collection = mapbox.autofill({ accessToken: token });
    if (collection && typeof collection.addEventListener === 'function') {
      collection.addEventListener('retrieve', handleRetrieve);
    }
    watchManualEdits();
    // NOTE: we deliberately do NOT call collection.observe() here — the SDK's
    // MutationObserver deep-compares React DOM nodes and overflows the stack.
    // startAutofillObserver() provides the same auto-attach behaviour safely.
    startAutofillObserver();
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
