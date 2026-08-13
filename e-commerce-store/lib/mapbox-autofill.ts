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
      autofill: (options: {
        accessToken: string;
        options?: Record<string, unknown>;
        /**
         * REQUIRED for Mapbox search-js v1.6.0: when false (the SDK default) it
         * renames an attached input's `autocomplete` to "new-password" on
         * focus/typing, which makes the field invisible to both our selector and
         * the SDK's own re-scan, so the next update() tears the dropdown down.
         */
        browserAutofillEnabled?: boolean;
      }) => AddressAutofillCollection;
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
  | {
      status: 'active';
      token: true;
      error?: undefined;
      /** True ONLY when the SDK actually attached autofill to >=1 address input. */
      attached?: boolean;
      /** Number of eligible address inputs currently on the page. */
      inputs?: number;
      /** Number of inputs the SDK successfully attached to. */
      attachedInputs?: number;
      /** Number of <mapbox-search-listbox> dropdown elements the SDK created. */
      listboxes?: number;
      /** First characters of the resolved token (for diagnosing wrong/placeholder tokens). */
      tokenPrefix?: string;
      /** Current hostname (for diagnosing Mapbox token URL restrictions). */
      host?: string;
      /** Mapbox suggest API error messages seen this session. */
      suggestErrors?: string[];
      /** Number of Mapbox suggest requests issued this session. */
      suggestCount?: number;
      /** True when a Mapbox suggest request was rejected (401/403) this session. */
      tokenRejected?: boolean;
    }
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

// ── Actual-attach tracking ───────────────────────────────────────────────────
// `status: 'active'` only means "SDK loaded + collection created". It does NOT
// mean the SDK attached autofill to any input. We track real attachment by
// inspecting the DOM for the SDK's ground-truth side effects: it appends one
// `<mapbox-search-listbox>` per attached input to <body> and points that
// element's `.input` property at the attached input.
let attachTimer: number | null = null;
let suggestErrors: string[] = [];
let suggestCount = 0;
let resolvedTokenPrefix = '';
let tokenRejected = false;

/**
 * True once the SDK successfully attached to at least one input this page-load.
 * Once latched, autofill stays "on" for the rest of the session while eligible
 * inputs exist — our identity-based MutationObserver keeps the collection
 * re-attached, so a transient DOM read of 0 during a React re-render can never
 * flip the checkout gates or the UI hint back to "could not attach".
 */
let attachedEver = false;

/**
 * Whether the SDK is effectively attached RIGHT NOW. Combines a live DOM read
 * with the `attachedEver` latch: after the first verified attach, eligible
 * inputs count as attached until they're gone (the observer heals teardowns
 * within a tick), so the hint and the checkout gate never flap.
 */
function isCurrentlyAttached(): boolean {
  if (tokenRejected) return false;
  const info = verifyMapboxAttachment();
  if (info.inputs === 0) return false;
  return attachedEver ? true : info.attachedInputs > 0;
}

/** Admin/auth pages never render a shipping input — skip the SDK entirely there. */
function pageNeverHasAddressInputs(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname || '';
  return path.startsWith('/admin') || path.startsWith('/auth');
}

function setStatus(next: GoyunirMapboxStatus): void {
  status = next;
  if (typeof window !== 'undefined') {
    window.__GOYUNIR_MAPBOX__ = { ...next } as GoyunirMapboxStatus;
    try {
      window.dispatchEvent(
        new CustomEvent('goyunir-mapbox-status', { detail: { ...next } })
      );
    } catch {
      /* ignore */
    }
  }
}

function isLocalhostHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}


export function resolveMapboxToken(): string {
  if (typeof window === 'undefined') return '';
  let token = '';
  if (window.ENV_MAPBOX_TOKEN) {
    token = window.ENV_MAPBOX_TOKEN.trim();
  } else {
    const marker = document.getElementById('search-js');
    if (marker) {
      const attr = marker.getAttribute('data-mapbox-token') || '';
      if (attr && attr !== PLACEHOLDER_ATTR) token = attr.trim();
    }
    if (!token) {
      const buildToken = (
        process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
        process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ||
        ''
      ).trim();
      if (buildToken) token = buildToken;
    }
    // Localhost-only dev override — never read on a production host. Lets you
    // test the real dropdown locally by opening the site with
    //   ?mapbox_token=pk.eyJ…   (or setting localStorage "mapbox_dev_token").
    if (!token && isLocalhostHost()) {
      try {
        const qs = new URLSearchParams(window.location.search).get('mapbox_token');
        if (qs) token = qs.trim();
        else {
          const ls = window.localStorage.getItem('mapbox_dev_token');
          if (ls) token = ls.trim();
        }
      } catch {
        /* ignore storage/query errors */
      }
    }
  }

  // Mapbox browser autofill requires a PUBLIC `pk.*` token. A secret `sk.*`
  // token or an obvious placeholder makes the SDK load (status "active") but
  // every suggest request is then rejected — and rejected requests do not
  // bill, so the Mapbox dashboard shows zero usage while no dropdown appears.
  if (!token) return '';
  if (!/^pk\.[A-Za-z0-9_-]{6,}/.test(token)) {
    console.warn(
      '[mapbox-autofill] Rejecting non-public Mapbox token (must start with "pk."). ' +
        'A secret "sk.*" token or placeholder can never work in the browser.'
    );
    return '';
  }
  return token;
}

/** Current autofill status — mirror of window.__GOYUNIR_MAPBOX__. */
export function getMapboxStatus(): GoyunirMapboxStatus {
  if (status.status === 'active') {
    const info = verifyMapboxAttachment();
    const attached = isCurrentlyAttached();
    // Heal path: eligible inputs exist but the SDK isn't actually attached yet
    // (or the attach side effects were dropped when React replaced the input's
    // DOM node on a re-render). Restart the retry loop here so a status read can
    // never permanently leave the UI stuck on "autofill could not attach" while
    // a dropdown is actually attachable. startAttachLoop() is a no-op when a
    // loop is already running, and update() only dispatches status events when
    // the attachment state flips.
    if (!tokenRejected && info.inputs > 0 && !attached && attachTimer === null) {
      resyncMapboxAutofill();
      startAttachLoop();
    }
    return {
      ...status,
      attached,
      inputs: info.inputs,
      attachedInputs: info.attachedInputs,
      listboxes: info.listboxes,
      tokenPrefix: resolvedTokenPrefix,
      host: typeof window !== 'undefined' ? window.location.hostname : undefined,
      suggestErrors: suggestErrors.slice(-5),
      suggestCount,
      tokenRejected,
    } as GoyunirMapboxStatus;
  }
  return { ...status };
}

/**
 * Count the dropdown listbox elements the SDK created. The SDK appends one
 * `<mapbox-search-listbox>` per attached input to `document.body`.
 */
function listboxElements(): Element[] {
  if (typeof document === 'undefined') return [];
  try {
    return Array.from(document.querySelectorAll('mapbox-search-listbox'));
  } catch {
    return [];
  }
}

/**
 * Count listboxes whose SDK `.input` is one of the CURRENT eligible inputs.
 * This is the SDK's ground-truth attach signal: the SDK appends one
 * `<mapbox-search-listbox>` per attached input to <body> and points its `.input`
 * property at that element. Attribute-based checks (`data-lpignore`,
 * `name="… address-search"`) are NOT reliable because the SDK leaves those
 * attributes behind when `collection.update()` tears an instance down (it only
 * removes the listbox and listeners), so an input can look "attached" while no
 * dropdown actually exists.
 */
function realAttachedInputs(eligible: HTMLInputElement[]): number {
  if (typeof document === 'undefined') return 0;
  try {
    const set = new Set(eligible);
    let count = 0;
    const listboxes = Array.from(document.querySelectorAll('mapbox-search-listbox'));
    for (const lb of listboxes) {
      const input = (lb as Element & { input?: HTMLInputElement }).input;
      if (input && set.has(input)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Inspect the DOM for the SDK's attach side effects:
 *  - the SDK appends a `<mapbox-search-listbox>` dropdown to <body> per
 *    attached input and links it to that input via its `.input` property.
 * These are the ONLY reliable signals that autofill actually attached; the
 * `status: 'active'` flag merely means the SDK loaded.
 */
export function verifyMapboxAttachment(): {
  inputs: number;
  attachedInputs: number;
  listboxes: number;
} {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { inputs: 0, attachedInputs: 0, listboxes: 0 };
  }
  const eligible = findAddressInputs();
  return {
    inputs: eligible.length,
    attachedInputs: realAttachedInputs(eligible),
    listboxes: listboxElements().length,
  };
}

/** True once the SDK loaded AND is actually attached to at least one input. */
export function isMapboxAutofillActive(): boolean {
  if (status.status !== 'active') return false;
  // If Mapbox rejected the token, the dropdown can never produce results, so
  // don't force customers to "pick from the suggestions" — fall back to
  // structural validation instead.
  if (tokenRejected) return false;
  return isCurrentlyAttached();
}

/**
 * The current live value of an eligible address input. This is the DOM truth,
 * which matters because the Mapbox SDK fills the input value programmatically
 * when a suggestion is picked — that does NOT trigger React's onChange, so
 * React state can be stale (empty) while the input visibly shows the selected
 * address. Submit handlers should prefer this over state.
 *
 * Selection order: the input the user is currently typing in (active element),
 * else the LAST eligible input (the cart drawer mounts after the product form,
 * so its input comes later in document order), else the first eligible input.
 */
export function getAutofillAddressValue(input?: HTMLInputElement | null): string {
  if (typeof document === 'undefined') return '';
  const read = (el: HTMLInputElement | null | undefined): string =>
    el ? String(el.value || '').trim() : '';
  if (input) return read(input);
  const inputs = findAddressInputs();
  if (inputs.length === 0) return '';
  const active = document.activeElement as HTMLInputElement | null;
  if (active && inputs.includes(active)) return read(active);
  return read(inputs[inputs.length - 1]);
}

/**
 * Refresh the `active` status payload with live attach diagnostics so
 * `window.__GOYUNIR_MAPBOX__` (and any UI hint) always reflects reality.
 */
function refreshActiveStatus(): void {
  if (status.status !== 'active') return;
  const info = verifyMapboxAttachment();
  const next: GoyunirMapboxStatus = {
    status: 'active',
    token: true,
    attached: isCurrentlyAttached(),
    inputs: info.inputs,
    attachedInputs: info.attachedInputs,
    listboxes: info.listboxes,
    tokenPrefix: resolvedTokenPrefix,
    host: typeof window !== 'undefined' ? window.location.hostname : undefined,
    suggestErrors: suggestErrors.slice(-5),
    suggestCount,
    tokenRejected,
  };
  setStatus(next);
}

/**
 * Transition the module to `active` and publish the FULL status payload in one
 * event. Publishing a bare `{ status: 'active', token: true }` first would let
 * components briefly read `attached: undefined` and flip the hint to
 * "autofill could not attach" before the attach loop verifies.
 */
function markActive(): void {
  const info = verifyMapboxAttachment();
  const next: GoyunirMapboxStatus = {
    status: 'active',
    token: true,
    attached: isCurrentlyAttached(),
    inputs: info.inputs,
    attachedInputs: info.attachedInputs,
    listboxes: info.listboxes,
    tokenPrefix: resolvedTokenPrefix,
    host: typeof window !== 'undefined' ? window.location.hostname : undefined,
    suggestErrors: suggestErrors.slice(-5),
    suggestCount,
    tokenRejected,
  };
  setStatus(next);
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

/** The address `autocomplete` value every storefront shipping input starts with. */
const ADDRESS_AUTOCOMPLETE = 'shipping street-address';

/**
 * Mapbox search-js v1.6.0 renames an attached input's `autocomplete` attribute
 * to "new-password" on focus and on every keystroke when `browserAutofillEnabled`
 * is false (its default). That makes BOTH our selector AND the SDK's own re-scan
 * (`Hi()` / `update()`) stop recognizing the field, so a later
 * `collection.update()` tears the dropdown down and it never comes back (and the
 * UI hint flips to "could not attach" even though attach was verified). Restore
 * the address value on any input the SDK attached to so the field stays eligible.
 */
function restoreAddressAutocomplete(): void {
  if (typeof document === 'undefined') return;
  const candidates = new Set<HTMLInputElement>();
  try {
    document
      .querySelectorAll<HTMLInputElement>(
        'input[autocomplete~="street-address"], input[autocomplete~="address-line1"]'
      )
      .forEach((el) => candidates.add(el));
  } catch {
    /* ignore */
  }
  // Inputs the SDK is currently attached to (its listbox `.input` pointers) may
  // have been renamed to "new-password" and no longer match the selector.
  listboxElements().forEach((lb) => {
    const input = (lb as Element & { input?: HTMLInputElement }).input;
    if (input instanceof HTMLInputElement) candidates.add(input);
  });
  for (const el of candidates) {
    if ((el.getAttribute('autocomplete') || '') === 'new-password') {
      el.setAttribute('autocomplete', ADDRESS_AUTOCOMPLETE);
    }
  }
}

/** Street-address inputs the SDK attaches to (same selector the SDK uses). */
function findAddressInputs(): HTMLInputElement[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return [];
  try {
    const found = new Map<HTMLInputElement, boolean>();
    document
      .querySelectorAll<HTMLInputElement>(
        'input[autocomplete~="street-address"], input[autocomplete~="address-line1"]'
      )
      .forEach((el) => found.set(el, true));
    // The SDK renames an attached input's `autocomplete` to "new-password" on
    // focus/typing (browser-autofill prevention), so the selector above can stop
    // matching a field that still has a live dropdown attached. Treat inputs the
    // SDK is currently attached to (its listbox `.input` pointers) as eligible
    // too, so a rename can never make the status/hint flap to "could not attach".
    listboxElements().forEach((lb) => {
      const input = (lb as Element & { input?: HTMLInputElement }).input;
      if (input instanceof HTMLInputElement && input.isConnected) found.set(input, true);
    });
    return Array.from(found.keys());
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
 * (e.g. the cart drawer's shipping field), or re-attach when the SDK is loaded
 * but somehow didn't attach (React can replace input DOM nodes on re-render).
 * Comparison is by identity only — never deep-equality — so React's circular
 * `__reactFiber$…` DOM properties can never make this recurse.
 */
export function resyncMapboxAutofill(): void {
  if (!collection || typeof collection.update !== 'function') return;
  // Mapbox renames attached inputs to "new-password" on focus/typing; restore
  // before the SDK's re-scan so update() sees the address field as eligible and
  // (re)attaches it instead of tearing the dropdown down.
  restoreAddressAutocomplete();
  const current = findAddressInputs();
  const info = verifyMapboxAttachment();
  const inputsChanged = !inputsEqual(current, attachedInputs);
  const missingAttach = current.length > 0 && info.attachedInputs === 0;
  if (!inputsChanged && !missingAttach) return;
  attachedInputs = current;
  try {
    collection.update();
  } catch (err) {
    console.warn('[mapbox-autofill] Failed to attach autofill to a newly mounted input.', err);
  }
  refreshActiveStatus();
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
    // Keep the SDK from permanently renaming our address fields to
    // "new-password" (which would make the next update() tear the dropdown down).
    restoreAddressAutocomplete();
    resyncMapboxAutofill();
  });
  autofillObserver.observe(document, {
    subtree: true,
    childList: true,
    // Watch autocomplete changes too so we can immediately undo the SDK's
    // "new-password" rename before any other code re-scans the DOM.
    attributes: true,
    attributeFilter: ['autocomplete'],
  });
  // Attach to anything already in the DOM (no-op if the constructor did it).
  restoreAddressAutocomplete();
  resyncMapboxAutofill();
}

function stopAttachLoop(): void {
  if (attachTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(attachTimer);
    attachTimer = null;
  }
}

/**
 * Safety net that keeps forcing `collection.update()` until the SDK really
 * attached to the address inputs (or until there is nothing left to attach).
 *
 * The SDK's constructor runs `update()` once, but on a React page the eligible
 * inputs can mount AFTER the SDK finished loading (the product fetch races the
 * cached SDK script) or React can replace input DOM nodes on re-render. The
 * collection's own `observe()` can't be used — its MutationObserver callback
 * deep-compares React DOM nodes (`at(Hi(), …)`) and overflows the stack — so
 * we retry `update()` (which is idempotent) until the DOM shows real attach
 * side effects, then stop.
 */
function startAttachLoop(): void {
  if (attachTimer !== null || typeof window === 'undefined') return;
  const MAX_ATTEMPTS = 20; // ~16s of retries
  let attempts = 0;
  const attempt = (): boolean => {
    attempts += 1;
    const info = verifyMapboxAttachment();
    if (info.attachedInputs > 0) {
      attachedEver = true;
      stopAttachLoop();
      console.info(
        `[mapbox-autofill] Attach verified: ${info.attachedInputs} input(s) attached, ${info.listboxes} dropdown(s) rendered. Type in the shipping field to see suggestions.`
      );
      refreshActiveStatus();
      return true;
    }
    if (info.inputs === 0) {
      // No eligible inputs yet — React may still be mounting the form, or this
      // page simply never renders a shipping input (e.g. /admin, /auth). This
      // is expected, not an error: the observer re-attaches if one appears.
      if (attempts >= MAX_ATTEMPTS) {
        stopAttachLoop();
        console.info(
          '[mapbox-autofill] No address inputs on this page — autofill will attach automatically if one appears later.'
        );
      }
      return false;
    }
    // Eligible inputs exist but nothing is actually attached — force the SDK to
    // re-scan. The SDK's update() is destructive (it tears down and rebuilds all
    // instances), but we only reach this branch when there is nothing real to
    // tear down, so the dropdown is never flickered while it is working.
    try {
      collection?.update?.();
    } catch (err) {
      console.warn('[mapbox-autofill] Retry update() failed:', err);
    }
    if (attempts >= MAX_ATTEMPTS) {
      stopAttachLoop();
      console.warn(
        '[mapbox-autofill] Could not attach autofill after retrying. ' +
          'If Mapbox requests are rejected, the token is likely invalid or URL-restricted for this domain ' +
          '(see window.__GOYUNIR_MAPBOX__).'
      );
      refreshActiveStatus();
    }
    return false;
  };
  // Try once immediately (a status read may have restarted us), then keep
  // retrying until the DOM shows real attach side effects.
  const verified = attempt();
  if (!verified) {
    attachTimer = window.setInterval(attempt, 800);
  }
}

/**
 * Attach Mapbox address autofill to the page. Safe to call from multiple
 * components and on every mount: the SDK + collection are created only once,
 * and our identity-based MutationObserver attaches to inputs rendered later.
 */
export async function ensureMapboxAutofill(): Promise<void> {
  if (typeof window === 'undefined') return;
  // Admin/auth pages never render a shipping input — loading the SDK there is
  // wasted work and only produces "no address inputs" noise in the console.
  if (pageNeverHasAddressInputs()) return;
  if (status.status === 'loading') return;
  if (status.status === 'active') {
    // Already running — pick up any input that mounted since the last observer
    // tick (no-op unless the input set actually changed or attach is missing).
    resyncMapboxAutofill();
    startAttachLoop();
    refreshActiveStatus();
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

  resolvedTokenPrefix = token.length > 7 ? `${token.slice(0, 7)}…` : '(token too short?)';

  setStatus({ status: 'loading', token: true });
  await loadMapboxSdk();
  const mapbox = window.mapboxsearch;
  if (!mapbox || typeof mapbox.autofill !== 'function') {
    setStatus({ status: 'sdk-missing', token: true });
    console.warn('[mapbox-autofill] The Mapbox SDK did not load, so autofill is unavailable.');
    return;
  }
  if (collection) {
    markActive();
    resyncMapboxAutofill();
    startAttachLoop();
    refreshActiveStatus();
    return;
  }
  try {
    // Capture the inputs the SDK constructor is about to attach to, so our own
    // resync below doesn't re-attach (and re-name) the same elements.
    attachedInputs = findAddressInputs();
    // NOTE: `browserAutofillEnabled: true` is REQUIRED. With the SDK default
    // (false) it renames an attached input's `autocomplete` to "new-password"
    // on focus/typing, which makes both our selector and the SDK's own re-scan
    // stop recognizing the field — the next collection.update() then tears the
    // dropdown down and it never comes back. With this option the SDK keeps the
    // original address autocomplete while the field is empty/short, and our
    // restoreAddressAutocomplete() guard covers the longer-typing case.
    collection = mapbox.autofill({ accessToken: token, browserAutofillEnabled: true });
    if (collection && typeof collection.addEventListener === 'function') {
      collection.addEventListener('retrieve', handleRetrieve);
      collection.addEventListener('suggest', () => {
        suggestCount += 1;
        refreshActiveStatus();
      });
      collection.addEventListener('suggesterror', (event: any) => {
        const detail = event && event.detail;
        const message =
          detail instanceof Error
            ? detail.message
            : (detail && detail.message) || String(detail || 'Mapbox suggest error');
        suggestErrors = suggestErrors.concat(message);
        console.warn('[mapbox-autofill] Mapbox suggest error:', message);
        if (/401|403|unauthorized|not authorized|forbidden|access token|invalid token/i.test(message)) {
          tokenRejected = true;
          console.error(
            '[mapbox-autofill] Mapbox is REJECTING the access token. Fix: (1) use a PUBLIC pk.* token, ' +
              '(2) in account.mapbox.com → Access Tokens check URL restrictions include this domain (' +
              (typeof window !== 'undefined' ? window.location.hostname : '?') +
              '), (3) ensure the token was not revoked/expired. Token prefix: ' +
              resolvedTokenPrefix
          );
        }
        refreshActiveStatus();
      });
    }
    watchManualEdits();
    // Force an explicit scan+attach ONLY if the constructor didn't already
    // attach (e.g. the eligible inputs mounted after the SDK finished loading).
    // update() is idempotent but re-creating wrappers duplicates the SDK's
    // hidden data-seed element, so skip it when the DOM already shows attach
    // side effects.
    const initialAttach = verifyMapboxAttachment();
    if (initialAttach.attachedInputs === 0 && initialAttach.listboxes === 0) {
      try {
        collection?.update?.();
      } catch (err) {
        console.warn('[mapbox-autofill] Initial update() failed:', err);
      }
    }
    // NOTE: we deliberately do NOT call collection.observe() here — the SDK's
    // MutationObserver deep-compares React DOM nodes and overflows the stack.
    // startAutofillObserver() provides the same auto-attach behaviour safely.
    startAutofillObserver();
    markActive();
    console.info(
      '[mapbox-autofill] SDK loaded (token ' + resolvedTokenPrefix + '). Verifying attach…'
    );
    startAttachLoop();
    refreshActiveStatus();
  } catch (err) {
    setStatus({
      status: 'failed',
      token: true,
      error: err instanceof Error ? err.message : String(err),
    });
    console.error('[autofill] init failed', err);
  }
}
