'use client';

/**
 * Signed-in cart sync (client side).
 *
 * The anonymous cart lives in localStorage (`goyunir-cart`). When a customer
 * signs in, this module:
 *
 *   1. fetches the account's saved cart (`store:cart:<userId>` via
 *      `/api/cart/sync`),
 *   2. merges it with the current local bag (server first, local overrides the
 *      same product+size lines so freshly-added items keep the newest price),
 *   3. writes the merged bag back to localStorage (firing `goyunir-cart-updated`
 *      so the drawer + product page re-render),
 *   4. persists every later change back to the server, debounced 900ms.
 *
 * The merge only runs once per page session (SiteChrome guards it), so a cart
 * emptied on another device is not re-populated by this browser's stale local
 * copy on every navigation.
 */

let persistTimer: number | null = null;

function readLocalCart(): any[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('goyunir-cart');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalCart(items: any[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('goyunir-cart', JSON.stringify(items));
  } catch {
    /* storage full/blocked — the bag stays in memory */
  }
  window.dispatchEvent(new CustomEvent('goyunir-cart-updated'));
}

function lineKey(item: any): string {
  return `${String(item?.productId || '')}::${String(item?.size || '')}`;
}

/** Merge the server-saved cart with the local bag. Server lines come first;
 *  local lines override the same product+size (keeps the newest metadata). */
export function mergeCarts(serverItems: any[], localItems: any[]): any[] {
  const map = new Map<string, any>();
  for (const item of Array.isArray(serverItems) ? serverItems : []) {
    if (!item) continue;
    map.set(lineKey(item), { ...item });
  }
  for (const item of Array.isArray(localItems) ? localItems : []) {
    if (!item) continue;
    const key = lineKey(item);
    map.set(key, map.has(key) ? { ...map.get(key), ...item } : { ...item });
  }
  return [...map.values()];
}

/** Debounced POST of the current bag to the account cart. No-op when signed
 *  out (the route returns 401 and we ignore it). */
export function scheduleCartPersist(items?: any[]): void {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  const payload = items || readLocalCart();
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    fetch('/api/cart/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ items: payload }),
    }).catch(() => { /* signed out or offline — local bag still works */ });
  }, 900);
}

/** Pull the signed-in user's saved cart, merge with the local bag, write the
 *  merged result back to localStorage and persist it. Returns true when a
 *  server cart was loaded (i.e. the user is signed in). */
export async function syncCartWithServer(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await fetch('/api/cart/sync', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const data = await res.json();
    const serverItems = Array.isArray(data?.items) ? data.items : [];
    const localItems = readLocalCart();
    const merged = mergeCarts(serverItems, localItems);
    const changed = merged.length !== localItems.length || JSON.stringify(merged) !== JSON.stringify(localItems);
    if (changed) writeLocalCart(merged);
    if (merged.length > 0) scheduleCartPersist(merged);
    return true;
  } catch {
    return false;
  }
}
