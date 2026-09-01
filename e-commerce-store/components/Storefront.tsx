'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { useLiveTheme } from '@/components/ThemeProvider';
import { ensureMapboxAutofill, getAutofillAddressValue, getMapboxStatus } from '@/lib/mapbox-autofill';
import { validateShippingAddress } from '@/lib/address-validation';
import { isConfiguredPrice, surfaceBackground, themeRadius, cardShadowStyle, contentSpacingScale, cardSheen, getSizeCheckoutMode, hasMixedCheckoutModes, sizeCheckoutModes, resolveSizeLimits, visibleProductCategories } from '@/lib/storefront-config';
import { dropTimestampToMsOrNaN } from '@/lib/drop-timestamps';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { notifyDropDue } from '@/lib/client-auto-draw';
import { isVideoMedia, coverStyle, pickCrop, DEFAULT_CROP } from '@/lib/media';
import { samplerPresentation, formatMoneyCents, isSamplerSize } from '@/lib/sampler-config';
import NotFoundView from '@/components/NotFoundView';

const CART_KEY = 'goyunir-cart';
const CHECKOUT_DETAILS_KEY = 'goyunir-checkout-details';
// How long before a still-due draw trigger re-arms. Mirrors the lib/client-auto-draw
// re-arm window so a tab left open past the zero-moment gets another nudge + page
// refresh if the pool somehow stayed open — but a re-fetch that returns the SAME due
// anchor can never re-trigger sooner than this (that loop was what reset the visitor's
// selected size every ~1.5s).
const DRAW_TRIGGER_REARM_MS = 4 * 60 * 1000;

/**
 * Address quality gate for checkout. The validator requires a COMPLETE
 * shippable address (street # + name, city, state, ZIP, country) — see
 * lib/address-validation.ts. Its short message guides the customer to the
 * address dropdown, which always fills a full, shippable address.
 */
function addressValidationError(address: string): string | null {
  return validateShippingAddress(address);
}

function getProductPriceCategory(product: any, size: string) {
  const cats = product.priceCategories || [];
  return cats.find((c: any) => c.size === size) || null;
}

/**
 * Resolve the countdown anchors for ONE product+size pair. Per-size raffle
 * configs ("customize each raffle differently") mean the selected size decides
 * the timer the visitor sees AND the trigger anchor the draw engine is nudged
 * with:
 *   - `drawAnchor` → DISPLAY anchor (the "new raffle" timer when the size's raw
 *     cycle end has passed but inventory remains and the schedule recurs).
 *   - `dueAnchor`  → TRIGGER anchor (the raw per-size cycle end — may be in the
 *     past on load so the draw still fires for an ended-but-un-drawn pool).
 * Returns `{ drawAnchor, dueAnchor }` strings (empty when the product is
 * archived or has no usable anchor).
 */
function resolveProductAnchors(data: any, size: string): { drawAnchor?: string; dueAnchor?: string } {
  const productData = data?.product;
  if (!productData) return {};
  if (productData.isArchived) return {};
  const storeTz = String(data?.config?.dropSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles');
  const sizeKey = String(size || '').trim().toLowerCase();
  // Per-size raw cycle end wins over the product-level one; per-size display
  // anchor wins over the product-level "new raffle" timer.
  const sizeCfg = (productData?.sizeConfigs || {})[sizeKey] || {};
  const releaseEndsAt = String(sizeCfg?.releaseEndsAt || productData.releaseEndsAt || '');
  const sizeNext = (productData?.sizeNextReleaseEndsAt || {}) as Record<string, string>;
  const nextReleaseEndsAt = String(sizeNext[sizeKey] || productData.nextReleaseEndsAt || '');
  const releaseMs = releaseEndsAt ? dropTimestampToMsOrNaN(releaseEndsAt, storeTz) : NaN;
  const nextReleaseMs = nextReleaseEndsAt ? dropTimestampToMsOrNaN(nextReleaseEndsAt, storeTz) : NaN;

  if (productData.isUpcoming) {
    const anchor = productData.goLiveAt || releaseEndsAt;
    return { drawAnchor: anchor, dueAnchor: anchor };
  }
  if (nextReleaseEndsAt && Number.isFinite(nextReleaseMs)) {
    return { drawAnchor: nextReleaseEndsAt, dueAnchor: releaseEndsAt || nextReleaseEndsAt };
  }
  if (releaseEndsAt && Number.isFinite(releaseMs)) {
    return { drawAnchor: releaseEndsAt, dueAnchor: releaseEndsAt };
  }
  // No usable anchor → no countdown. Do NOT fall back to the global drop
  // schedule's target date/time: a product with no dates set must not show a
  // countdown at all (previously it re-anchored to the global daily 00:00).
  return {};
}

/**
 * Small inline spinner used inside buttons while an async action is running.
 * Because every tap now also gets the global press-down animation, a button
 * that is mid-request shows BOTH the pressed (disabled) state AND this
 * spinner + label — there is never a moment where a tap looks unhandled.
 */
function ButtonSpinner({ light = true }: { light?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          border: `2px solid ${light ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.25)'}`,
          borderTopColor: light ? '#ffffff' : '#111111',
          animation: 'goyunirSpin 0.7s linear infinite',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    </span>
  );
}

function getFallbackImage(product: any) {
  const images = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
  if (images.length > 0) return images[0];
  return '';
}

function readStoredCart() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredCart(items: any[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CART_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('goyunir-cart-updated'));
}

function readCheckoutDetails() {
  if (typeof window === 'undefined') return { email: '', address: '' };
  try {
    const raw = window.localStorage.getItem(CHECKOUT_DETAILS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      email: typeof parsed?.email === 'string' ? parsed.email : '',
      address: typeof parsed?.address === 'string' ? parsed.address : '',
    };
  } catch {
    return { email: '', address: '' };
  }
}

function writeCheckoutDetails(email: string, address: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CHECKOUT_DETAILS_KEY, JSON.stringify({ email, address }));
}

/**
 * Session "already entered" ledger. Records productId+size pairs that were
 * actually secured as raffle/waitlist entries this session so the "Add to bag"
 * button can block an item the customer is already entered for even before the
 * email-based server lookup runs (the server also blocks duplicates at
 * checkout, so this is convenience + UX, not the security gate).
 */
const ENTERED_LEDGER_KEY = 'goyunir-entered-items';

function readEnteredLedger(): Array<{ productId: string; size: string }> {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ENTERED_LEDGER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function markEnteredLedger(productId: string, size: string) {
  if (typeof window === 'undefined') return;
  try {
    const list = readEnteredLedger().filter((e) => !(e.productId === productId && e.size === size));
    list.push({ productId, size });
    window.localStorage.setItem(ENTERED_LEDGER_KEY, JSON.stringify(list));
  } catch {}
}

function readPendingEntry(): { productId?: string; size?: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem('goyunir-pending-entry');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePendingEntry(productId: string, size: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem('goyunir-pending-entry', JSON.stringify({ productId, size }));
  } catch {}
}

function clearPendingEntry() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem('goyunir-pending-entry');
  } catch {}
}

function notify(detail: { id?: string; type: string; message: string; persist?: boolean }) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('goyunir-notify', { detail }));
}

export default function Storefront({ initialSlug }: { initialSlug?: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<string>('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  // When a customer is signed in, the entry-form email field is locked to their
  // account email so an alternate address can't be used on raffle/FCFS entries.
  const [accountEmail, setAccountEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // "Add to bag" runs a server duplicate-entry lookup that can take a moment
  // on a slow connection — this makes the button show a spinner while it runs
  // instead of looking like the tap did nothing.
  const [cartBusy, setCartBusy] = useState(false);
  // Promo validation is an async network call too; same treatment.
  const [promoBusy, setPromoBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [cart, setCart] = useState<any[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [raffleEndsAt, setRaffleEndsAt] = useState<number | null>(null);
  // Raw cycle-end anchor used ONLY to trigger the draw (may be in the past on
  // load — e.g. a recurring raffle mid-cycle whose timer already ended — which
  // nudges the server to draw right away). The DISPLAY anchor (`raffleEndsAt`)
  // can be the next cycle's timer while this is past.
  const [raffleDueAt, setRaffleDueAt] = useState<number | null>(null);
  const [countdownLabel, setCountdownLabel] = useState('');
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [promoMsg, setPromoMsg] = useState('');
  const [promoValid, setPromoValid] = useState<boolean | null>(null);
  const [encryptionHealthy, setEncryptionHealthy] = useState(true);
  const [showPromoField, setShowPromoField] = useState(false);
  const [countdownPulse, setCountdownPulse] = useState(false);
  const [mapboxHint, setMapboxHint] = useState('');
  // Admin-configurable gallery behaviour (auto-advance + slow zoom). Filled from
  // /api/store → config.gallery with sensible defaults for a premium look.
  const [gallerySettings, setGallerySettings] = useState<any>({
    autoPlay: true,
    intervalSeconds: 4,
    zoom: true,
    zoomDurationSeconds: 14,
  });
  // Rewards economy (admin → Settings → Rewards & Points): used to show the
  // "You'll earn X points" incentive on the product page + cart. Absent →
  // rewards are not advertised.
  const [rewardsCfg, setRewardsCfg] = useState<{ purchasePointsPerDollar?: number } | null>(null);

  // Remembers which product is currently loaded so re-fetches of the SAME product
  // (e.g. the countdown-zero refresh) never reset the visitor's selected size or
  // flip the gallery back to photo 1. Only a real product switch resets those.
  const productIdRef = useRef<string>('');
  // Per-size raffle configs mean the countdown depends on the SELECTED size. The
  // anchor is recomputed by an effect on [product, selectedSize]; these refs
  // bridge the fetch (which knows the store timezone from the payload) to that
  // effect without another network round-trip.
  const storeTimezoneRef = useRef<string>(String(GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles'));
  const selectedSizeRef = useRef<string>('');
  // Guards the draw-trigger block (notify + re-fetch) so it fires at most once per
  // product + cycle boundary, re-arming after DRAW_TRIGGER_REARM_MS. Persists across
  // effect re-runs — the old local `notified` flag reset on every re-run, which let a
  // re-fetch that returned the same due anchor loop forever.
  const dueHandledRef = useRef<{ productId: string; anchor: number; at: number }>({ productId: '', anchor: NaN, at: 0 });

  // Live Mapbox autofill hint (drives the small status line under the shipping
  // field). Updated whenever lib/mapbox-autofill.ts refreshes its status, plus a
  // safety poll: the SDK's attach loop can finish after the last status event,
  // or React can replace the shipping input node and drop the attach side
  // effects. Re-reading the live status every ~1.2s makes the hint converge to
  // the real DOM state (getMapboxStatus() also restarts the attach retry loop
  // when eligible inputs exist but nothing is attached yet).
  useEffect(() => {
    const sync = () => {
      const s = getMapboxStatus();
      if (s.status === 'active') setMapboxHint(s.tokenRejected ? 'token-rejected' : (s.attached ? 'autofill-on' : 'autofill-off'));
      else if (s.status === 'no-token') setMapboxHint('no-token');
      else setMapboxHint('');
    };
    sync();
    window.addEventListener('goyunir-mapbox-status', sync);
    const poll = window.setInterval(sync, 1200);
    return () => {
      window.removeEventListener('goyunir-mapbox-status', sync);
      window.clearInterval(poll);
    };
  }, []);

  // Live theme palette. Initialized from the server-baked /admin → Settings
  // theme (no flash) and upgraded to whatever is saved in /admin → Settings
  // (served through `/api/store` → config → themeColors). This makes page
  // background, card backgrounds/borders, border radius, and card text colors
  // editable from the admin portal without a redeploy.
  const liveCtx = useLiveTheme();
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  // Storefront copy overrides — admin → Settings → Storefront copy. A non-empty
  // value overrides the built-in labels (entry CTA etc.).
  const [copySettings, setCopySettings] = useState<Record<string, any>>(liveCtx?.copy || {});
  // Header action label ("Bag" vs "Cart"). The admin value is mirrored into
  // localStorage by SiteChrome; reading it here during RENDER caused a React
  // hydration mismatch (#418 — SSR says "cart", client says "bag") whenever the
  // saved value was "bag". Read it in an effect instead so both server and
  // client render "cart", then converge after mount.
  const [actionMode, setActionMode] = useState<'cart' | 'bag'>('cart');
  useEffect(() => {
    try {
      if (window.localStorage.getItem('goyunir-header-action-mode') === 'bag') setActionMode('bag');
    } catch {
      /* ignore storage errors */
    }
  }, []);
  const actionLabel = actionMode === 'bag' ? 'bag' : 'cart';

  const fetchProduct = useCallback(async (slug: string, force = false) => {
    try {
      // Route through fetchStoreJson: dedupes with the rest of the site,
      // serves a stale payload instantly on repeat visits, and retries
      // timeouts once — so a slow connection shows the product fast.
      // `force` (used right after a countdown hits zero) bypasses the cache so
      // the page sees the product's post-drop state instead of a stale snapshot.
      const data = await fetchStoreJson<any>(`/api/store?slug=${slug}`, force ? { force: true } : undefined);
      if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      if (data?.config?.gallery) setGallerySettings((prev: any) => ({ ...prev, ...data.config.gallery }));
      if (data?.config?.copy) setCopySettings((prev) => ({ ...prev, ...data.config.copy }));
      if (data?.config?.rewards) setRewardsCfg(data.config.rewards);
      if (data.product) {
        setProduct(data.product);
        // The countdown anchors are resolved per product+size (see the effect on
        // [product, selectedSize] below); here we only carry over the store
        // timezone so that effect parses naive wall-clock strings correctly.
        storeTimezoneRef.current = String(data?.config?.dropSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles');
        const cats = data.product.priceCategories || [];
        // Preserve the visitor's size selection across re-fetches. A re-fetch
        // fires right after a countdown-zero draw trigger, and blindly resetting
        // `selectedSize` to the first category made the size chips appear to
        // "switch by themselves" the instant the visitor picked a different size.
        // Only choose a default when the current selection is empty or no longer
        // valid for THIS product.
        const nextProductId = String(data.product.id || '');
        const isSameProduct = productIdRef.current === nextProductId;
        productIdRef.current = nextProductId;
        setSelectedSize((prev) => {
          if (prev && cats.some((cat: any) => cat.size === prev)) return prev;
          return cats.length > 0 ? cats[0].size : prev;
        });
        // Only reset the gallery when the visitor actually switched products —
        // never on a same-product re-fetch (which would also flicker the photo
        // back to image 1 every time the countdown re-syncs).
        if (!isSameProduct) setSelectedImageIndex(0);
      } else {
        setError('Product not found');
      }
    } catch {
      setError('Failed to load product');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllProducts = useCallback(async () => {
    try {
      const data = await fetchStoreJson<any>('/api/store');
      if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      if (data?.config?.gallery) setGallerySettings((prev: any) => ({ ...prev, ...data.config.gallery }));
      if (data?.config?.copy) setCopySettings((prev) => ({ ...prev, ...data.config.copy }));
      if (data?.config?.rewards) setRewardsCfg(data.config.rewards);
      const all = Array.isArray(data.allProducts) ? data.allProducts : [];
      const sortFn = (a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name));
      let display = [...all]
        .filter((p: any) => p.isActive === true && p.isArchived !== true && p.isUpcoming !== true)
        .sort(sortFn);
      // Home-page fallback: when nothing is live, surface upcoming/archived so
      // the store never renders an empty grid while drops sit hidden.
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
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (initialSlug) {
      fetchProduct(initialSlug);
      return;
    }

    fetchAllProducts().then((products) => {
      if (products.length > 0) {
        router.push(`/${products[0].slug}`);
      } else {
        setLoading(false);
        setError('No products available');
      }
    });
  }, [initialSlug, fetchProduct, fetchAllProducts, router]);

  useEffect(() => {
    if (!product) return;
    const cats = product.priceCategories || [];
    if (cats.length > 0 && !cats.some((cat: any) => cat.size === selectedSize)) {
      setSelectedSize(cats[0].size);
    }
  }, [product, selectedSize]);

  // ── Per-size countdown anchors ─────────────────────────────────────────────
  // The displayed countdown AND the draw-trigger anchor depend on the SELECTED
  // size (each raffle size can have its own releaseEndsAt + schedule). Recompute
  // whenever the product or the selection changes. Archived products have no
  // countdown. Per-size override wins over product-level; the "new raffle"
  // timer (nextReleaseEndsAt) is only a display anchor while the raw cycle end
  // stays the trigger anchor so the draw engine is nudged exactly when the
  // timer the visitor saw hits zero.
  useEffect(() => {
    if (!product) return;
    const size = selectedSize || String((product.priceCategories || [])[0]?.size || '');
    selectedSizeRef.current = size;
    if (product.isArchived) {
      setRaffleEndsAt(null);
      setRaffleDueAt(null);
      return;
    }
    const anchors = resolveProductAnchors({ product, config: { dropSchedule: { timezone: storeTimezoneRef.current } } }, size);
    const storeTz = storeTimezoneRef.current;
    const anchorMs = anchors.drawAnchor ? dropTimestampToMsOrNaN(anchors.drawAnchor, storeTz) : NaN;
    const dueMs = anchors.dueAnchor ? dropTimestampToMsOrNaN(anchors.dueAnchor, storeTz) : NaN;
    setRaffleEndsAt(Number.isFinite(anchorMs) && anchorMs > 0 ? anchorMs : null);
    setRaffleDueAt(Number.isFinite(dueMs) && dueMs > 0 ? dueMs : null);
  }, [product, selectedSize]);

  // Attach Mapbox address autofill once the product (and its address input) is
  // rendered. The helper is a singleton, so calling it from multiple components
  // is safe; the SDK only loads when a token is configured.
  useEffect(() => {
    if (!product) return;
    ensureMapboxAutofill();
  }, [product]);

  // Elegant auto-advancing gallery: slowly cycles through the product photos
  // while a Ken Burns zoom plays, exactly like a high-end storefront. Hovering
  // pauses so collectors can take their time. Configurable in /admin → Settings.
  const imgCount = Array.isArray(product?.images) ? product.images.filter(Boolean).length : 0;
  const autoPlayOn = gallerySettings?.autoPlay !== false && imgCount > 1;
  const galleryIntervalMs = Math.max(2, Number(gallerySettings?.intervalSeconds) || 4) * 1000;
  const zoomSeconds = Math.max(4, Number(gallerySettings?.zoomDurationSeconds) || 14);
  const zoomOn = gallerySettings?.zoom !== false;
  const [galleryPaused, setGalleryPaused] = useState(false);
  useEffect(() => {
    if (!autoPlayOn || galleryPaused) return;
    const timer = window.setInterval(() => {
      setSelectedImageIndex((prev) => (prev + 1) % imgCount);
    }, galleryIntervalMs);
    return () => window.clearInterval(timer);
  }, [autoPlayOn, galleryPaused, galleryIntervalMs, imgCount]);

  // The gallery box is full-width (up to 560px) × 280px. Its exact pixel width
  // is measured so admin crop settings can be applied 1:1 (the crop region maps
  // onto this box).
  const galleryBoxRef = useRef<HTMLDivElement | null>(null);
  const [galleryBoxWidth, setGalleryBoxWidth] = useState(0);
  useEffect(() => {
    const el = galleryBoxRef.current;
    if (!el) return;
    const update = () => setGalleryBoxWidth(el.clientWidth || 0);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Natural dimensions of the currently-shown photo (images only) — used to
  // apply the admin crop 1:1 onto the measured gallery box.
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const list = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
    const current = list[selectedImageIndex] || list[0] || '';
    if (!current || isVideoMedia(current)) {
      setNaturalDims(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNaturalDims({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    };
    img.src = current;
    return () => {
      cancelled = true;
    };
  }, [selectedImageIndex, product?.images]);

  // Swipe / drag navigation for the product gallery. Vertical drags still scroll
  // the page (touchAction 'pan-y'); horizontal drags switch photos with a live
  // drag preview and a spring-back when the gesture isn't far enough.
  //
  // ROBUSTNESS: the drag is tracked with a ref-based state machine + WINDOW-level
  // pointerup/pointercancel listeners. The old per-element handlers could get
  // "stuck" on desktop: if the mouse button was released anywhere other than
  // directly over the gallery (fast drag off the element, released outside the
  // browser, a lost pointer capture), the pointerup never fired and the photo
  // stayed dragged while the cursor kept trying to scroll. Window listeners end
  // the drag no matter where the pointer is released, and the pointer capture is
  // explicitly released so the browser can never keep hijacking the pointer.
  const [dragOffset, setDragOffset] = useState(0);
  const [galleryDragging, setGalleryDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; active: boolean; pointerId: number; touch: boolean }>({ startX: 0, startY: 0, active: false, pointerId: -1, touch: false });
  const lastDragDxRef = useRef(0);
  const endDragRef = useRef<((() => void) & { cleanup?: () => void }) | null>(null);

  useEffect(() => {
    return () => {
      if (endDragRef.current && endDragRef.current.cleanup) endDragRef.current.cleanup();
    };
  }, []);

  const onGalleryPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (imgCount <= 1) return;
    // Ignore secondary mouse buttons (right-click) — never start a drag on those.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, touch: e.pointerType === 'touch' };
    setGalleryPaused(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture can throw if the pointer is already gone — the window listeners below still end the drag */ }
    const endDrag = () => {
      const s = dragStateRef.current;
      const finalDx = lastDragDxRef.current;
      if (s.active && Math.abs(finalDx) > 52) {
        if (finalDx < 0) setSelectedImageIndex((prev) => (prev + 1) % imgCount);
        else setSelectedImageIndex((prev) => (prev - 1 + imgCount) % imgCount);
      }
      dragStateRef.current = { startX: 0, startY: 0, active: false, pointerId: -1, touch: false };
      lastDragDxRef.current = 0;
      setGalleryDragging(false);
      setDragOffset(0);
      // Mouse users resume autoplay via onMouseLeave (hover pauses); touch swipes
      // release the pause here so the carousel keeps cycling.
      if (s.touch) setGalleryPaused(false);
    };
    const handleWindowUp = () => {
      endDragRef.current?.cleanup?.();
      // Release the capture so the browser pointer is never left trapped.
      try {
        const el = document.getElementById('goyunir-gallery-surface');
        if (el && dragStateRef.current.pointerId >= 0) el.releasePointerCapture(dragStateRef.current.pointerId);
      } catch { /* already released */ }
      endDrag();
    };
    const handleBlur = () => {
      endDragRef.current?.cleanup?.();
      endDrag();
    };
    endDrag.cleanup = () => {
      window.removeEventListener('pointerup', handleWindowUp);
      window.removeEventListener('pointercancel', handleWindowUp);
      window.removeEventListener('blur', handleBlur);
    };
    window.addEventListener('pointerup', handleWindowUp);
    window.addEventListener('pointercancel', handleWindowUp);
    window.addEventListener('blur', handleBlur);
    endDragRef.current = endDrag;
  };

  const onGalleryPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (imgCount <= 1) return;
    if (dragStateRef.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragStateRef.current.startX;
    const dy = e.clientY - dragStateRef.current.startY;
    if (!dragStateRef.current.active) {
      // Only claim the gesture once it's clearly horizontal (not a page scroll).
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        dragStateRef.current.active = true;
        setGalleryDragging(true);
      } else {
        return;
      }
    }
    lastDragDxRef.current = dx;
    setDragOffset(dx);
  };

  const onGalleryPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (imgCount <= 1) return;
    if (dragStateRef.current.pointerId !== e.pointerId) return;
    lastDragDxRef.current = e.clientX - dragStateRef.current.startX;
    endDragRef.current?.cleanup?.();
    endDragRef.current?.();
  };

  const prevImage = () => {
    setGalleryPaused(true);
    setSelectedImageIndex((prev) => (prev - 1 + imgCount) % imgCount);
  };
  const nextImage = () => {
    setGalleryPaused(true);
    setSelectedImageIndex((prev) => (prev + 1) % imgCount);
  };

  // Always-current cart mirror so helper functions can safely prune items from
  // any closure (e.g. the setup-success effect) without stale state. Declared
  // BEFORE the effects so closures can reference it freely.
  const cartRef = useRef<Array<{ productId: string; size: string }>>([]);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  /**
   * Remove every cart line matching productId+size. Used when the customer
   * enters a raffle / buys a direct item through the product page instead of
   * the bag — the item is now either being entered or purchased, so it must not
   * linger in the bag where it could be double-processed.
   */
  const removeItemFromCart = (productId: string, size: string) => {
    const current = cartRef.current;
    const next = current.filter((entry) => !(entry.productId === productId && entry.size === size));
    if (next.length !== current.length) {
      cartRef.current = next;
      setCart(next);
      writeStoredCart(next);
    }
  };

  /**
   * Remove cart lines whose product no longer exists in Redis (e.g. after the
   * operator wipes/rebuilds the store) or whose size was removed. The bag must
   * never show items that don't exist anywhere on the backend.
   */
  const pruneStaleCart = (items: any[], products: any[]): any[] => {
    if (!Array.isArray(items)) return [];
    const byId = new Map(products.map((p) => [String(p?.id || ''), p]));
    return items.filter((item) => {
      const product = byId.get(String(item?.productId || ''));
      if (!product) return false;
      const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
      return cats.some((c: any) => String(c?.size) === String(item?.size));
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = readStoredCart();
    setCart(stored);

    const draft = readCheckoutDetails();
    if (draft.email) setEmail(draft.email);
    if (draft.address) setAddress(draft.address);

    // Re-validate a stored promo against the LIVE promo table. After a Redis
    // wipe/rebuild the old code no longer exists, so the "✓ applied" state must
    // not survive — otherwise the UI claims a promo is applied that isn't.
    const storedPromo = String(window.localStorage.getItem('goyunir-promo-code') || '').trim().toUpperCase();
    if (storedPromo) {
      fetch(`/api/promo/validate?code=${encodeURIComponent(storedPromo)}&quiet=1`)
        .then((res) => res.json())
        .then((data) => {
          if (data?.valid === true) {
            setPromoCode(storedPromo);
          } else {
            try { window.localStorage.removeItem('goyunir-promo-code'); } catch { /* noop */ }
            setPromoCode('');
            setPromoValid(false);
          }
        })
        .catch(() => {
          // Network hiccup — keep the code but don't claim it's applied.
          setPromoCode('');
        });
    }

    // Prune cart lines that no longer exist (products/sizes gone after a
    // wipe/rebuild or archive). Runs against the live /api/store snapshot.
    fetchStoreJson('/api/store')
      .then((data: any) => {
        const products = Array.isArray(data?.allProducts) ? data.allProducts : [];
        const pruned = pruneStaleCart(stored, products);
        if (pruned.length !== stored.length) {
          setCart(pruned);
          writeStoredCart(pruned);
        }
      })
      .catch(() => {});
  }, []);

  // Lock the entry email field to the signed-in customer's account email. Runs
  // once on mount: if `/api/auth/me` reports a session, the account email wins
  // over any locally-stored draft so an alternate address can't be used.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => {
        if (cancelled || !data?.user?.email) return;
        const locked = String(data.user.email).trim().toLowerCase();
        setAccountEmail(locked);
        setEmail(locked);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    writeCheckoutDetails(email, address);
  }, [email, address]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const code = promoCode.trim().toUpperCase();
    if (code) window.localStorage.setItem('goyunir-promo-code', code);
  }, [promoCode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const incomingPromo = String(params.get('ref') || params.get('promo') || '').trim().toUpperCase();
    if (incomingPromo) {
      window.localStorage.setItem('goyunir-promo-code', incomingPromo);
      setPromoCode(incomingPromo);
      fetch('/api/promo/validate/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: incomingPromo }),
      }).catch(() => {});
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!initialSlug || typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const setupState = params.get('setup');
    const purchaseState = params.get('purchase');
    if (!sessionId) {
      if (setupState === 'cancel') {
        // The customer backed out of card setup — a direct entry was never
        // secured, so forget the pending-entry marker (and the cart line stays
        // pruned; they can re-add if they change their mind).
        clearPendingEntry();
        setMessage('Card setup was cancelled before the entry was secured.');
        notify({ id: 'stripe-cancel', type: 'error', message: 'Card setup was cancelled before the entry was secured.' });
      }
      if (purchaseState === 'cancel') {
        try { window.sessionStorage.removeItem('goyunir-cart-checkout'); } catch {}
        setMessage('Checkout was cancelled before payment completed.');
        notify({ id: 'stripe-cancel', type: 'error', message: 'Checkout was cancelled before payment completed.' });
      }
      return;
    }

    const clearQuery = () => {
      const cleanUrl = `${window.location.pathname}`;
      window.history.replaceState({}, '', cleanUrl);
    };

    if (setupState === 'success') {
      fetch('/api/checkout/confirm-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then((res) => res.json())
        .then((data) => {
          const msg = data.message || 'Your entry is locked in.';
          setMessage(msg);
          if (data.alreadyEntered) {
            notify({ id: 'entry-locked', type: 'info', message: msg, persist: true });
          } else {
            notify({ id: 'entry-locked', type: 'success', message: msg, persist: true });
          }
          clearQuery();
          // Entries are now secured — drop the prepared raffle items from the bag.
          if (data.success) {
            const viaCartCheckout = (() => {
              try { return window.sessionStorage.getItem('goyunir-cart-checkout') === 'true'; } catch { return false; }
            })();
            try { window.sessionStorage.removeItem('goyunir-cart-checkout'); } catch {}
            if (viaCartCheckout) {
              // Whole cart was checked out through the drawer: every raffle line
              // in it is now a real entry — remember them so "Add to bag" blocks
              // re-adding, then clear the cart.
              try {
                const items = readStoredCart();
                items.forEach((item) => {
                  if ((item.checkoutMode || '').toUpperCase() === 'RAFFLE' || String(item.productType || '').toLowerCase() === 'raffle') {
                    markEnteredLedger(String(item.productId || ''), String(item.size || ''));
                  }
                });
              } catch {}
              setCart([]);
              writeStoredCart([]);
            } else {
              // Direct product-page entry: the matching line was already pruned
              // when the entry started. Mark it as entered so it can't be
              // re-added to the bag this session.
              const pending = readPendingEntry();
              if (pending?.productId && pending.size) {
                markEnteredLedger(pending.productId, pending.size);
                removeItemFromCart(pending.productId, pending.size);
              }
              clearPendingEntry();
            }
          } else {
            clearPendingEntry();
          }
          // Mixed carts (raffle + direct items) continue into the FCFS payment
          // session after the raffle card setup is confirmed.
          try {
            const pendingPaymentUrl = window.sessionStorage.getItem('goyunir-pending-payment-url');
            if (pendingPaymentUrl && /^https?:\/\//i.test(pendingPaymentUrl)) {
              window.sessionStorage.removeItem('goyunir-pending-payment-url');
              window.location.assign(pendingPaymentUrl);
              return;
            }
          } catch {}
        })
        .catch(() => {
          setMessage('We could not verify the completed setup, but it may still have succeeded.');
          notify({ id: 'entry-locked', type: 'error', message: 'We could not verify the completed setup, but it may still have succeeded.', persist: true });
        });
      return;
    }

    if (purchaseState === 'success') {
      try { window.sessionStorage.removeItem('goyunir-cart-checkout'); } catch {}
      clearPendingEntry();
      setCart([]);
      writeStoredCart([]);
      setMessage('Purchase complete. Your order is now being prepared.');
      notify({ id: 'purchase-complete', type: 'success', message: 'Purchase complete. Your order is now being prepared.', persist: true });
      clearQuery();
    }
  }, [initialSlug]);

  const addToCart = async () => {
    if (!product) return;
    const cat = getProductPriceCategory(product, selectedSize);
    if (!cat || !isConfiguredPrice(cat.price)) {
      setMessage('Price not set for this size. Please set in admin.');
      notify({ type: 'error', message: 'This size is not ready yet.' });
      return;
    }
    const checkoutMode = getSizeCheckoutMode(product, selectedSize);
    const isRaffleEntry = checkoutMode === 'RAFFLE';

    // Block re-adding an item the customer already secured as a raffle/waitlist
    // entry this session (see markEnteredLedger). The server ALSO blocks
    // duplicates at checkout, so this is a UX gate, not the security boundary.
    if (isRaffleEntry) {
      const ledger = readEnteredLedger();
      const alreadySecured = ledger.some(
        (e) => String(e.productId || '') === String(product.id || '') && String(e.size || '') === String(selectedSize || ''),
      );
      if (alreadySecured) {
        const msg = `You're already entered for ${product.name} (${selectedSize}). Check your entry in Manage My Entry.`;
        setMessage(msg);
        notify({ type: 'info', message: msg });
        return;
      }
    }

    // The server duplicate lookup below is a network call — show a busy state
    // so the tap never looks ignored on a slow connection.
    setCartBusy(true);
    try {
      // Never stack a second raffle entry for a variant+size the email already
      // holds an active entry for. Fail-open: if the lookup errors or the
      // customer isn't signed in (401), we still allow the add so checkout is
      // never blocked — the server re-checks duplicates at payment time too.
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (isRaffleEntry && normalizedEmail) {
        try {
          const res = await fetch('/api/account/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: normalizedEmail }),
          });
          const data = await res.json();
          const entries = Array.isArray(data?.entries) ? data.entries : [];
          const terminalStates = ['WINNER_CHARGED', 'WINNER_DECLINED', 'NOT_SELECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN'];
          const alreadyEntered = entries.some(
            (entry: any) =>
              (String(entry.variant || '').toLowerCase() === String(product.name || '').toLowerCase() ||
                String(entry.variant || '').toLowerCase() === String(product.id || '').toLowerCase()) &&
              String(entry.size || '') === String(selectedSize || '') &&
              (!entry.status || String(entry.status).toUpperCase() === 'ENTERED' || !terminalStates.includes(String(entry.status).toUpperCase())),
          );
          if (alreadyEntered) {
            markEnteredLedger(String(product.id || ''), String(selectedSize || ''));
            const msg = `You're already entered for ${product.name} (${selectedSize}). Check your entry in Manage My Entry.`;
            setMessage(msg);
            notify({ type: 'info', message: msg });
            return;
          }
        } catch {
          // Fail-open: lookup failures must never block adding to the cart.
        }
      }

      const item = {
        productId: product.id,
        name: product.name,
        size: selectedSize,
        price: cat.price,
        checkoutMode: checkoutMode,
        productType: isRaffleEntry ? 'raffle' : 'fcfs',
      };
      const maxPerCart = resolveSizeLimits(product, selectedSize).maxPerCart;
      const inCartCount = cart.filter((entry) => entry.productId === product.id && entry.size === selectedSize).length;
      if (inCartCount >= maxPerCart) {
        setMessage(`Limit reached: ${maxPerCart} for ${product.name} (${selectedSize}).`);
        notify({ type: 'alert', message: `Limit reached for ${product.name}.` });
        return;
      }
      const next = [...cart, item];
      setCart(next);
      writeStoredCart(next);
      setMessage(isRaffleEntry ? `Prepared ${product.name} (${selectedSize}) for entry.` : `Added ${product.name} (${selectedSize}) to your ${actionLabel}.`);
      notify({ type: 'success', message: isRaffleEntry ? `${product.name} is ready to secure.` : `${product.name} added to your ${actionLabel}.` });
      setShowCart(true);
    } finally {
      setCartBusy(false);
    }
  };

  useEffect(() => {
    if (!raffleEndsAt && !raffleDueAt) {
      setCountdownLabel('');
      return;
    }
    let refreshTimer: number | null = null;
    const update = () => {
      const now = Date.now();
      // TRIGGER: when the RAW cycle end has passed (timer hit zero — possibly
      // before this page even loaded), tell the server to run the draw RIGHT
      // NOW. The server is idempotent (due-check + 90s per-pool cooldown), so
      // this fire-and-forget ping can never double-charge even if several
      // tabs / visitors hit zero at the same second. `notifyDropDue` retries
      // on failure, so a flaky connection can't silently miss the drop.
      //
      // A persistent ref (anchor + 4-min re-arm window) guards this block: a
      // re-fetch that returns the SAME due anchor can't re-trigger it. The old
      // per-effect `notified` flag reset on every re-run, so the very re-fetch
      // this block schedules made the effect re-run → re-notify → re-fetch in
      // an endless ~1.5s loop — and every re-fetch reset the visitor's size.
      if (raffleDueAt !== null && raffleDueAt <= now) {
        const handled = dueHandledRef.current;
        const triggerKey = String(product?.id || '');
        if (handled.productId !== triggerKey || handled.anchor !== raffleDueAt || now - handled.at > DRAW_TRIGGER_REARM_MS) {
          dueHandledRef.current = { productId: triggerKey, anchor: raffleDueAt, at: now };
          notifyDropDue({ productId: String(product?.id || ''), productName: String(product?.name || ''), slug: String(product?.slug || '') });
          // Re-anchor after the draw trigger: an "opens in" countdown (upcoming
          // product) that just hit zero means the drop OPENED — re-fetch so the
          // timer flips to counting down to releaseEndsAt. A LIVE product whose
          // releaseEndsAt just passed (or was already passed on load) gets the
          // same re-fetch so the page reflects the draw result (and any new
          // recurring-raffle timer) instead of freezing on "Raffle closed"
          // while the server works.
          if (product?.slug) {
            refreshTimer = window.setTimeout(() => {
              fetchProduct(String(product.slug), true).catch(() => {});
            }, 1500);
          }
        }
      }

      if (!raffleEndsAt) {
        setCountdownLabel('');
        return;
      }
      const diff = raffleEndsAt - now;
      if (diff <= 0) {
        // Display anchor in the past (one-shot drop done, or the next cycle's
        // timer just ended — the re-fetch above will swap in the newest one).
        setCountdownLabel('Raffle closed');
        return;
      }
      const total = Math.floor(diff / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      setCountdownLabel(`${days}d ${hours}h ${minutes}m ${seconds}s`);
      setCountdownPulse((prev) => !prev);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearInterval(timer);
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [raffleEndsAt, raffleDueAt, product, fetchProduct]);

  const handleRaffleSubmit = async () => {
    if (!email || !selectedSize) {
      setMessage('Please fill in all fields and select a size.');
      notify({ type: 'alert', message: 'Complete your details before entering.' });
      return;
    }
    const liveAddress = getAutofillAddressValue() || address;
    const addrErr = addressValidationError(liveAddress);
    if (addrErr) {
      setMessage(addrErr);
      notify({ type: 'alert', message: addrErr });
      return;
    }
    setIsSubmitting(true);
    setMessage('');
    // The customer is entering this release NOW through the product page, so the
    // same product+size must not linger in the bag where it could be entered a
    // second time through the drawer. Remember the pending line so the setup
    // success handler can mark it as entered (and the cancel handler can forget
    // it) once Stripe returns.
    removeItemFromCart(String(product.id || ''), String(selectedSize || ''));
    writePendingEntry(String(product.id || ''), String(selectedSize || ''));
    notify({ id: 'product-submit', type: 'loading', message: 'Securing encrypted entry...', persist: true });
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, size: selectedSize, email, address: liveAddress, mode: 'raffle', promoCode }),
      });
      const data = await res.json();
      if (data.alreadyEntered) {
        // Already in the pool — no Stripe session was launched, so this is a
        // friendly heads-up, not a failure. Remember it so "Add to bag" blocks
        // re-adding for the rest of this session.
        markEnteredLedger(String(product.id || ''), String(selectedSize || ''));
        clearPendingEntry();
        setMessage(data.error || "You're already entered. Good luck!");
        notify({ id: 'product-submit', type: 'info', message: data.error || "You're already entered. Good luck!", persist: true });
      } else if (res.ok && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        setEncryptionHealthy(true);
        notify({ id: 'product-submit', type: 'entered', message: 'Entry handoff is ready.' });
        window.location.href = data.url;
      } else {
        // Business errors (invalid promo, already entered, sold out...) are NOT
        // encryption failures — keep the handoff indicator honest.
        clearPendingEntry();
        setMessage(data.error || 'Failed to start checkout');
        notify({ id: 'product-submit', type: 'error', message: data.error || 'Failed to start checkout.' });
      }
    } catch {
      clearPendingEntry();
      setEncryptionHealthy(false);
      setMessage('Connection error');
      notify({ id: 'product-submit', type: 'error', message: 'Connection error.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDirectCheckout = async () => {
    if (!email || !selectedSize) {
      setMessage('Please fill in all fields and select a size.');
      notify({ type: 'alert', message: 'Complete your details before checkout.' });
      return;
    }
    const liveAddress = getAutofillAddressValue() || address;
    const addrErr = addressValidationError(liveAddress);
    if (addrErr) {
      setMessage(addrErr);
      notify({ type: 'alert', message: addrErr });
      return;
    }
    setIsSubmitting(true);
    setMessage('');
    // Direct purchase through the product page — remove the matching line from
    // the bag so it can't be bought twice (once here, once through the drawer).
    removeItemFromCart(String(product.id || ''), String(selectedSize || ''));
    notify({ id: 'product-submit', type: 'loading', message: 'Preparing secure checkout...', persist: true });
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, size: selectedSize, email, address: liveAddress, mode: 'direct', promoCode }),
      });
      const data = await res.json();
      if (res.ok && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        setEncryptionHealthy(true);
        notify({ id: 'product-submit', type: 'success', message: 'Checkout is ready.' });
        window.location.href = data.url;
      } else {
        setMessage(data.error || 'Checkout failed');
        notify({ id: 'product-submit', type: 'error', message: data.error || 'Checkout failed.' });
      }
    } catch {
      setEncryptionHealthy(false);
      setMessage('Connection error');
      notify({ id: 'product-submit', type: 'error', message: 'Connection error.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWaitlistSubmit = async () => {
    if (!email || !selectedSize) {
      setMessage('Please fill in all fields and select a size.');
      notify({ type: 'alert', message: 'Complete your details before joining the waitlist.' });
      return;
    }
    const liveAddress = getAutofillAddressValue() || address;
    const addrErr = addressValidationError(liveAddress);
    if (addrErr) {
      setMessage(addrErr);
      notify({ type: 'alert', message: addrErr });
      return;
    }
    setIsSubmitting(true);
    setMessage('');
    // Entering the waitlist through the product page — prune the matching bag
    // line and remember the pending entry so the setup success handler can mark
    // it as entered (and the cancel handler can forget it).
    removeItemFromCart(String(product.id || ''), String(selectedSize || ''));
    writePendingEntry(String(product.id || ''), String(selectedSize || ''));
    notify({ id: 'product-submit', type: 'loading', message: 'Preparing release reservation...', persist: true });
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, size: selectedSize, email, address: liveAddress, mode: 'waitlist', promoCode }),
      });
      const data = await res.json();
      if (data.alreadyEntered) {
        markEnteredLedger(String(product.id || ''), String(selectedSize || ''));
        clearPendingEntry();
        setMessage(data.error || "You're already on the list. Good luck!");
        notify({ id: 'product-submit', type: 'info', message: data.error || "You're already on the list. Good luck!", persist: true });
      } else if (res.ok && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        setEncryptionHealthy(true);
        notify({ id: 'product-submit', type: 'success', message: 'Card is ready for the release window.' });
        window.location.href = data.url;
      } else {
        clearPendingEntry();
        setMessage(data.error || 'Could not start waitlist reservation');
        notify({ id: 'product-submit', type: 'error', message: data.error || 'Could not start waitlist reservation.' });
      }
    } catch {
      clearPendingEntry();
      setEncryptionHealthy(false);
      setMessage('Connection error');
      notify({ id: 'product-submit', type: 'error', message: 'Connection error.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyPromo = async () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) {
      setPromoMsg('Enter a promo code first.');
      setPromoValid(false);
      notify({ type: 'alert', message: 'Enter a promo code first.' });
      return;
    }
    setPromoBusy(true);
    notify({ id: 'promo-apply', type: 'loading', message: 'Checking promo...', persist: true });
    try {
      const res = await fetch(`/api/promo/validate?code=${encodeURIComponent(code)}&email=${encodeURIComponent(email || '')}&productId=${encodeURIComponent(product?.id || '')}&size=${encodeURIComponent(selectedSize || '')}&orderSubtotal=${encodeURIComponent(String(price || 0))}`);
      const data = await res.json();
      if (data.valid) {
        window.localStorage.setItem('goyunir-promo-code', code);
        setPromoCode(code);
        setPromoValid(true);
        setPromoMsg(`Promo ${code} applied${data.fixedDiscountCents ? ` · $${(Number(data.fixedDiscountCents) / 100).toFixed(2)} credit` : data.customerDiscountPercent ? ` · ${data.customerDiscountPercent}% off` : ''}.`);
        notify({ id: 'promo-apply', type: 'success', message: `Promo ${code} applied.` });
        return;
      }
      setPromoValid(false);
      setPromoMsg(data.error || 'Promo is invalid.');
      notify({ id: 'promo-apply', type: 'error', message: data.error || 'Promo is invalid.' });
    } catch {
      setPromoValid(false);
      setPromoMsg('Could not validate promo right now.');
      notify({ id: 'promo-apply', type: 'error', message: 'Could not validate promo right now.' });
    } finally {
      setPromoBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: '#888' }}>
        <div style={{ width: 34, height: 34, borderRadius: 999, background: 'radial-gradient(circle, #3b82f6 0%, #a855f7 55%, transparent 72%)', animation: 'goyunirSpin 1.1s linear infinite, goyunirPulse 1.6s ease-in-out infinite' }} />
        <div style={{ fontSize: 12, letterSpacing: '2px', textTransform: 'uppercase' }}>Preparing the drop</div>
      </div>
    );
  }
  // An unknown/typo'd product URL renders the same friendly 404 page as any
  // other unmatched route. Network failures and the empty-store home state
  // keep their distinct messages below.
  if (error === 'Product not found') return <NotFoundView />;
  if (error || !product) return <div style={{ padding: 40, color: '#f87171' }}>{error || 'Product not found'}</div>;

  const priceCat = getProductPriceCategory(product, selectedSize);
  const price = priceCat?.price || 0;
  // Rewards incentive: "You'll earn X points" for the selected size. Only
  // advertised when the earn rate is configured AND the price is a real
  // configured amount (never the placeholder sentinel).
  const earnRate = Math.max(0, Number(rewardsCfg?.purchasePointsPerDollar) || 0);
  const pointsEarned = earnRate > 0 && isConfiguredPrice(price) ? Math.floor(price * earnRate) : 0;
  // Mixed-format releases: each size can be a raffle OR a direct-sale (FCFS)
  // item — e.g. a sampler sells instantly while the full bottle runs a raffle.
  // The selected size decides the CTA, the countdown and the cart line mode.
  const checkoutMode = getSizeCheckoutMode(product, selectedSize);
  const canCheckoutDirect = checkoutMode === 'FCFS';
  const isRaffleProduct = checkoutMode === 'RAFFLE';
  const hasMixedModes = hasMixedCheckoutModes(product);
  const sizeModes = sizeCheckoutModes(product);
  const mixedRaffleCount = Object.values(sizeModes).filter((m) => m === 'RAFFLE').length;
  const mixedFcfsCount = Object.values(sizeModes).filter((m) => m === 'FCFS').length;
  // Per-size trial ("sampler") presentation — the copy + math are specific to
  // the size the customer has selected (never one generic line for all sizes).
  const samplerPres = samplerPresentation(product, selectedSize);
  const fallbackImage = getFallbackImage(product);
  const galleryImages = Array.isArray(product.images) && product.images.length > 0 ? product.images.filter(Boolean) : (fallbackImage ? [fallbackImage] : []);

  // Crop support: the crop region maps 1:1 onto the measured gallery box. The
  // crop is applied ONLY when the operator customized it — the default keeps
  // the classic centered cover + Ken Burns behaviour. Each photo can carry a
  // separate Computer (wide, 2:1) and Mobile (narrow, 1.17:1) crop; the box's
  // measured aspect ratio decides which one is used.
  const galleryViewport: 'desktop' | 'mobile' =
    galleryBoxWidth > 0 && galleryBoxWidth / 280 < 1.5 ? 'mobile' : 'desktop';
  const currentCrop = pickCrop(
    Array.isArray(product?.crops) && product.crops[selectedImageIndex] ? product.crops[selectedImageIndex] : DEFAULT_CROP,
    galleryViewport,
  );
  const cropIsCustom = currentCrop.w < 0.999 || currentCrop.h < 0.999 || Math.abs(currentCrop.x - 0.5) > 0.001 || Math.abs(currentCrop.y - 0.5) > 0.001;
  const currentMediaIsVideo = isVideoMedia(galleryImages[selectedImageIndex] || galleryImages[0]);
  const inventoryRemaining = Number(product.inventoryRemaining ?? product.totalInventory ?? 0);
  const totalInventory = Number(product.totalInventory ?? 0);
  // Sold out when (a) the API reports it, (b) inventory was configured and
  // remaining hit zero, or (c) no inventory is configured but the product is
  // set to stay visible as a sold-out social-proof placeholder.
  const soldOut =
    product.soldOut === true ||
    (totalInventory > 0 && inventoryRemaining <= 0) ||
    (totalInventory === 0 && (product.soldOutBehavior || 'stay_visible') === 'stay_visible');
  const activeProductLabel = soldOut ? 'Sold out' : (product.isArchived ? 'Archived' : (product.isUpcoming ? 'Upcoming' : 'Live now'));
  // Copy resolution is per-product → global → built-in. The product admin page
  // ("Customer-facing copy") can override each line per product; leaving a field
  // empty inherits the global Settings → Storefront copy, which in turn falls
  // back to the built-in default.
  const urgencyLabel = soldOut
    ? String(product.urgencySoldOut || copySettings.urgencySoldOut || '').trim() || 'This release is fully spoken for.'
    : inventoryRemaining > 0 && inventoryRemaining <= 12
      ? `Only ${inventoryRemaining} allocations left.`
      : inventoryRemaining > 0 && inventoryRemaining <= 30
        ? `${inventoryRemaining} units remain across this release.`
        : String(product.urgencyInStock || copySettings.urgencyInStock || '').trim() || 'Handmade allocation. Low supply by design.';
  const statusStory = product.isUpcoming
    ? 'Collectors can still queue interest before the release opens publicly.'
    : product.isArchived && isRaffleProduct
      ? 'Archive placement keeps the story visible, and raffle entry can still be reopened for private audiences.'
      : product.isArchived
        ? String(product.statusArchived || copySettings.statusArchived || '').trim() || 'Archive placement preserves the release as proof of demand and collectability.'
        : String(product.statusLive || copySettings.statusLive || '').trim() || 'Reserved for collectors moving early, before the allocation tightens further.';
  const checkoutDisabled = soldOut || !selectedSize || !isConfiguredPrice(price);
  const showWaitlistOption = !isRaffleProduct && (product.isArchived || product.isUpcoming);

  // ── Adaptive trial-card palette ─────────────────────────────────────────────
  // The sampler card previously used hardcoded light-green text that vanished on
  // light themes. The card surface (cardBackground) decides which green family
  // is readable: dark surfaces get bright mint, light surfaces get deep forest.
  const cardIsLight = (() => {
    const hex = String(configPalette?.cardBackground || '#ffffff').replace('#', '');
    if (hex.length < 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return false;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.58;
  })();
  const trialColors = cardIsLight
    ? {
        cardBg: '#f0fdf4',
        cardBorder: 'rgba(21,128,61,0.30)',
        headline: '#166534',
        body: '#14532d',
        mathBg: 'rgba(21,128,61,0.06)',
        mathBorder: 'rgba(21,128,61,0.22)',
        mathDim: '#15803d',
        mathStrong: '#14532d',
        credit: '#15803d',
        note: '#3f6212',
        barTrack: 'rgba(21,128,61,0.16)',
        barFill: '#16a34a',
        chipBg: 'rgba(21,128,61,0.10)',
        chipBorder: 'rgba(21,128,61,0.42)',
        chipText: '#15803d',
        nudgeText: '#166534',
        nudgeBg: 'rgba(21,128,61,0.06)',
        nudgeBorder: 'rgba(21,128,61,0.20)',
      }
    : {
        cardBg: 'rgba(34,197,94,0.10)',
        cardBorder: 'rgba(34,197,94,0.30)',
        headline: '#4ade80',
        body: '#d1fae5',
        mathBg: 'rgba(34,197,94,0.12)',
        mathBorder: 'rgba(34,197,94,0.24)',
        mathDim: '#d1fae5',
        mathStrong: '#ffffff',
        credit: '#86efac',
        note: '#bbf7d0',
        barTrack: 'rgba(34,197,94,0.20)',
        barFill: '#4ade80',
        chipBg: 'rgba(34,197,94,0.12)',
        chipBorder: 'rgba(34,197,94,0.50)',
        chipText: '#4ade80',
        nudgeText: '#86efac',
        nudgeBg: 'rgba(34,197,94,0.08)',
        nudgeBorder: 'rgba(34,197,94,0.22)',
      };
  // Mode pills (RAFFLE / FCFS badges on the title + size chips): bright variants
  // on dark cards, deep ink variants on light cards so they stay readable.
  const modePill = cardIsLight
    ? {
        raffleBg: 'rgba(180,83,9,0.12)',
        raffleText: '#92400e',
        raffleBorder: 'rgba(180,83,9,0.35)',
        fcfsBg: 'rgba(29,78,216,0.10)',
        fcfsText: '#1e40af',
        fcfsBorder: 'rgba(29,78,216,0.35)',
      }
    : {
        raffleBg: 'rgba(245,158,11,0.16)',
        raffleText: '#fbbf24',
        raffleBorder: 'rgba(245,158,11,0.45)',
        fcfsBg: 'rgba(59,130,246,0.16)',
        fcfsText: '#93c5fd',
        fcfsBorder: 'rgba(59,130,246,0.45)',
      };

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, padding: `${Math.round(24 * contentSpacingScale(configPalette))}px 16px ${Math.round(72 * contentSpacingScale(configPalette))}px` }}>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: Math.round(16 * contentSpacingScale(configPalette)) }}>
        <section style={{ borderRadius: themeRadius(configPalette, 26), overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency), backgroundImage: cardSheen, boxShadow: cardShadowStyle(configPalette, 16) }}>
          <div
            id="goyunir-gallery-surface"
            ref={galleryBoxRef}
            onMouseEnter={() => setGalleryPaused(true)}
            onMouseLeave={() => { if (!dragStateRef.current.active) setGalleryPaused(false); }}
            onPointerDown={onGalleryPointerDown}
            onPointerMove={onGalleryPointerMove}
            onPointerUp={onGalleryPointerEnd}
            onPointerCancel={onGalleryPointerEnd}
            style={{ height: 280, position: 'relative', overflow: 'hidden', cursor: galleryImages.length > 1 ? (galleryDragging ? 'grabbing' : 'grab') : 'default', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTapHighlightColor: 'transparent' }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                transform: galleryDragging && dragOffset ? `translateX(${dragOffset}px)` : 'none',
                transition: galleryDragging ? 'none' : 'transform 260ms cubic-bezier(.22,1,.36,1)',
              }}
            >
              {currentMediaIsVideo ? (
                /* Video gallery item — plays inline with controls; videos are
                   never cropped (the admin crop tool applies to photos only). */
                <video
                  src={galleryImages[selectedImageIndex] || galleryImages[0]}
                  controls
                  playsInline
                  loop
                  muted
                  preload="metadata"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#0a0a0c' }}
                />
              ) : cropIsCustom && naturalDims && galleryBoxWidth > 0 ? (
                /* Admin crop applied — the crop region maps onto the box EXACTLY
                   as the admin preview showed it (desktop/mobile). */
                <img
                  src={galleryImages[selectedImageIndex] || galleryImages[0]}
                  alt={product.name}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{
                    position: 'absolute',
                    ...coverStyle(naturalDims.w, naturalDims.h, galleryBoxWidth, 280, currentCrop),
                    maxWidth: 'none',
                    maxHeight: 'none',
                    pointerEvents: 'none',
                  }}
                />
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    inset: -16,
                    background: `url(${galleryImages[selectedImageIndex] || galleryImages[0]}) center/cover`,
                    animation: zoomOn ? `goyunirKenburns ${zoomSeconds}s ease-in-out infinite alternate` : 'none',
                    willChange: 'transform',
                  }}
                />
              )}
            </div>
            {galleryImages.length > 1 && (
              <>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); prevImage(); }}
                  aria-label="Previous photo"
                  style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 32, height: 32, borderRadius: 999, border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(0,0,0,0.35)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, zIndex: 2, lineHeight: 1 }}
                >&#8249;</button>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); nextImage(); }}
                  aria-label="Next photo"
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 32, height: 32, borderRadius: 999, border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(0,0,0,0.35)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, zIndex: 2, lineHeight: 1 }}
                >&#8250;</button>
              </>
            )}
            {galleryImages.length > 1 && autoPlayOn && (
              <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 5, alignItems: 'center' }}>
                {galleryImages.map((_img: string, index: number) => (
                  <button
                    key={`dot-${index}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setSelectedImageIndex(index); }}
                    aria-label={`View photo ${index + 1}`}
                    style={{ width: 7, height: 7, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer', background: index === selectedImageIndex ? '#ffffff' : 'rgba(255,255,255,0.4)' }}
                  />
                ))}
              </div>
            )}
            {galleryImages.length > 1 && !autoPlayOn && (
              <div style={{ position: 'absolute', left: 12, bottom: 12, fontSize: 9, letterSpacing: '2px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.35)', padding: '4px 8px', borderRadius: 999 }}>Swipe</div>
            )}
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: soldOut ? '#fbbf24' : configPalette.accentBlue }}>{activeProductLabel}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {hasMixedModes && (
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.7px', padding: '3px 7px', borderRadius: 999, background: 'color-mix(in srgb, #a855f7 16%, transparent)', color: cardIsLight ? '#7e22ce' : '#d8b4fe', border: cardIsLight ? '1px solid rgba(126,34,206,0.35)' : '1px solid rgba(168,85,247,0.45)' }} title={`${mixedRaffleCount} size(s) run a raffle · ${mixedFcfsCount} sell instantly`}>MIXED</span>
                )}
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.7px', padding: '3px 7px', borderRadius: 999, background: canCheckoutDirect ? modePill.fcfsBg : modePill.raffleBg, color: canCheckoutDirect ? modePill.fcfsText : modePill.raffleText, border: `1px solid ${canCheckoutDirect ? modePill.fcfsBorder : modePill.raffleBorder}` }}>
                  {canCheckoutDirect ? 'FCFS' : 'RAFFLE'}
                </span>
              </div>
            </div>
            <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: 0, color: configPalette.cardTextMain }}>{product.name}</h1>
            {visibleProductCategories(product.categories, liveCtx?.catalog?.categories).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {visibleProductCategories(product.categories, liveCtx?.catalog?.categories).map((cat: string) => (
                  <span key={cat} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 999, background: `color-mix(in srgb, ${configPalette.accentPurple} 14%, transparent)`, color: configPalette.accentPurple, border: `1px solid color-mix(in srgb, ${configPalette.accentPurple} 30%, transparent)` }}>
                    {cat}
                  </span>
                ))}
              </div>
            )}
            <p style={{ margin: 0, color: configPalette.cardTextMuted, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{product.desc}</p>
            {(product.showUrgencyLine !== false || product.showStatusLine !== false) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', borderRadius: themeRadius(configPalette, 16), background: `color-mix(in srgb, ${configPalette.cardTextMain} 4%, ${configPalette.cardBackground})`, border: `1px solid ${soldOut ? 'rgba(251,191,36,0.28)' : configPalette.cardBorder}` }}>
                {product.showUrgencyLine !== false && (
                  <div style={{ fontSize: 11, color: soldOut ? '#fde68a' : configPalette.cardTextMain, whiteSpace: 'pre-line' }}>{urgencyLabel}</div>
                )}
                {product.showStatusLine !== false && (
                  <div style={{ fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{product.isArchived ? 'This release is archived, but future returns can still be pre-registered here so collectors stay ahead of the next opening.' : statusStory}</div>
                )}
              </div>
            )}
            {pointsEarned > 0 && !soldOut && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: configPalette.cardTextMuted, padding: '8px 12px', borderRadius: themeRadius(configPalette, 12), background: `color-mix(in srgb, ${configPalette.accentBlue} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${configPalette.accentBlue} 26%, transparent)` }}>
                <span style={{ fontSize: 13 }}>⭐</span>
                <span>Earn <strong style={{ color: configPalette.accentBlue }}>{pointsEarned.toLocaleString()} points</strong> on this size — redeem for store credit at checkout.</span>
              </div>
            )}
            {hasMixedModes && product.showMixedRibbon !== false && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, lineHeight: 1.5, color: configPalette.cardTextMuted, padding: '10px 12px', borderRadius: themeRadius(configPalette, 14), background: `color-mix(in srgb, #a855f7 7%, ${configPalette.cardBackground})`, border: cardIsLight ? '1px solid rgba(126,34,206,0.25)' : '1px solid rgba(168,85,247,0.30)' }}>
                <span style={{ fontSize: 13, lineHeight: 1 }}>🎟</span>
                {(() => {
                  // Copy resolution is per-product → global (Settings → Storefront
                  // copy) → built-in sentence. A template may use {raffle}/{fcfs}
                  // tokens which become the raffle and instant-buy size counts.
                  const template = String(product.mixedFormatRibbon || copySettings.mixedFormatRibbon || '').trim();
                  if (template) {
                    return (
                      <span style={{ whiteSpace: 'pre-line' }}>
                        {template.replace(/\{raffle\}/g, String(mixedRaffleCount)).replace(/\{fcfs\}/g, String(mixedFcfsCount))}
                      </span>
                    );
                  }
                  return (
                    <span>
                      This release mixes formats — <strong style={{ color: cardIsLight ? '#92400e' : '#fbbf24' }}>{mixedRaffleCount} raffle size{mixedRaffleCount === 1 ? '' : 's'}</strong> and{' '}
                      <strong style={{ color: cardIsLight ? '#1e40af' : '#93c5fd' }}>{mixedFcfsCount} instant-buy size{mixedFcfsCount === 1 ? '' : 's'}</strong>. Pick a size above to see its option.
                    </span>
                  );
                })()}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {galleryImages.map((image: string, index: number) => (
                <button key={`${image}-${index}`} onClick={() => setSelectedImageIndex(index)} style={{ width: 54, height: 54, borderRadius: 10, border: selectedImageIndex === index ? `1px solid ${configPalette.accentPurple}` : `1px solid ${configPalette.cardBorder}`, background: isVideoMedia(image) ? '#0b0b0d' : `url(${image}) center/cover`, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#888', overflow: 'hidden' }} title={isVideoMedia(image) ? 'Video' : `Photo ${index + 1}`}>
                  {isVideoMedia(image) ? '▶' : null}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section style={{ borderRadius: themeRadius(configPalette, 20), border: `1px solid ${configPalette.cardBorder}`, background: configPalette.cardBackground, padding: 14, color: configPalette.cardTextMain }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.cardTextMain || '#fff' }}>Select size</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {(product.priceCategories || []).map((cat: any) => {
                const chipIsSample = isSamplerSize(product, cat.size);
                const chipBadge = chipIsSample
                  ? String((product.samplerSizes || []).find((s: any) => String(s?.size || '').trim().toLowerCase() === String(cat.size || '').trim().toLowerCase())?.label || 'Sample')
                  : '';
                const chipMode = getSizeCheckoutMode(product, cat.size);
                const accent = configPalette.checkoutCtaButton || '#635bff';
                const chipSelected = selectedSize === cat.size;
                return (
                  <button key={cat.size} type="button" onClick={() => setSelectedSize(cat.size)} style={{ padding: '7px 10px', borderRadius: 999, border: chipSelected ? `1px solid ${accent}` : (chipIsSample ? trialColors.chipBorder : `1px solid ${configPalette.cardBorder}`), background: chipSelected ? accent : (chipIsSample ? trialColors.chipBg : 'transparent'), color: chipSelected ? '#ffffff' : (configPalette.cardTextMain || '#fff'), cursor: 'pointer', fontSize: 12, fontWeight: chipSelected ? 700 : 500, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {cat.size} {cat.price > 0 ? `($${cat.price})` : ''}
                    <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 999, background: chipSelected ? 'rgba(255,255,255,0.22)' : (chipMode === 'FCFS' ? modePill.fcfsBg : modePill.raffleBg), border: chipSelected ? '1px solid rgba(255,255,255,0.4)' : (chipMode === 'FCFS' ? modePill.fcfsBorder : modePill.raffleBorder), color: chipSelected ? '#ffffff' : (chipMode === 'FCFS' ? modePill.fcfsText : modePill.raffleText) }}>
                      {chipMode === 'FCFS' ? 'buy' : 'raffle'}
                    </span>
                    {chipIsSample && (
                      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 999, background: chipSelected ? 'rgba(255,255,255,0.22)' : trialColors.chipBg, border: chipSelected ? '1px solid rgba(255,255,255,0.4)' : trialColors.chipBorder, color: chipSelected ? '#ffffff' : trialColors.chipText }}>🧪 {chipBadge}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {samplerPres.selected.isSampler && (
              <div style={{ marginTop: 10, padding: '13px 14px', borderRadius: themeRadius(configPalette, 14), background: trialColors.cardBg, border: `1px solid ${trialColors.cardBorder}`, fontSize: 11.5, color: trialColors.body, lineHeight: 1.6 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: trialColors.headline, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  🧪 {samplerPres.selected.headline}
                  {hasMixedModes && samplerPres.selected.isSampler && (
                    <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.6px', padding: '2px 7px', borderRadius: 999, background: modePill.fcfsBg, color: modePill.fcfsText, border: `1px solid ${modePill.fcfsBorder}` }}>INSTANT BUY</span>
                  )}
                </div>
                <div>{samplerPres.selected.body}</div>
                {samplerPres.selected.math && (
                  <div style={{ marginTop: 10, padding: '10px 11px', borderRadius: 10, background: trialColors.mathBg, border: `1px solid ${trialColors.mathBorder}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: trialColors.mathDim }}>{samplerPres.selected.badge === 'Sample' ? 'Sample' : samplerPres.selected.badge} · <strong>{formatMoneyCents(samplerPres.selected.math.samplePriceCents)}</strong></span>
                      <span style={{ color: trialColors.credit }}>credit −<strong>{formatMoneyCents(samplerPres.selected.math.creditCents)}</strong></span>
                      <span style={{ color: trialColors.mathStrong, fontWeight: 800 }}>{samplerPres.selected.math.fullSize} <strong>{formatMoneyCents(samplerPres.selected.math.remainingCents)}</strong></span>
                    </div>
                    <div style={{ marginTop: 8, height: 5, borderRadius: 999, background: trialColors.barTrack, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, samplerPres.selected.math.pctCovered)}%`, height: '100%', background: trialColors.barFill, borderRadius: 999 }} />
                    </div>
                    <div style={{ marginTop: 5, fontSize: 9.5, color: trialColors.credit, letterSpacing: '0.4px' }}>
                      Your credit covers {samplerPres.selected.math.pctCovered}% of the {samplerPres.selected.math.fullSize}
                    </div>
                  </div>
                )}
                {samplerPres.selected.note && (
                  <div style={{ marginTop: 8, color: trialColors.note, fontSize: 11, lineHeight: 1.55 }}>{samplerPres.selected.note}</div>
                )}
              </div>
            )}
            {!samplerPres.selected.isSampler && samplerPres.nudge && (
              <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 12, background: trialColors.nudgeBg, border: `1px solid ${trialColors.nudgeBorder}`, fontSize: 11, color: trialColors.nudgeText, lineHeight: 1.55 }}>
                🧪 Want to try it first? The {samplerPres.nudge.size} is {formatMoneyCents(samplerPres.nudge.priceCents)} and includes a {formatMoneyCents(samplerPres.nudge.creditCents)} credit after delivery{samplerPres.nudge.fullSize ? ` toward the ${samplerPres.nudge.fullSize}` : ''}.
              </div>
            )}
          </div>

          {isRaffleProduct && !product.isArchived && countdownLabel && (
            <div style={{ marginBottom: 10, fontSize: 12, color: configPalette.cardTextMuted, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: countdownPulse ? '#facc15' : '#fef08a', boxShadow: countdownPulse ? '0 0 0 4px rgba(250,204,21,0.15)' : '0 0 0 1px rgba(254,240,138,0.08)', transition: 'all 180ms ease' }} />
              <span>{product.isUpcoming ? 'Release opens in' : 'Raffle ends in'}: <strong>{countdownLabel}</strong></span>
            </div>
          )}

          {/* Mapbox address autofill requires the field to live inside a <form>. */}
          <form onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              type="email"
              autoComplete="email"
              placeholder="email@domain.com"
              value={accountEmail || email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={Boolean(accountEmail)}
              readOnly={Boolean(accountEmail)}
              title={accountEmail ? 'Signed in — using your account email' : undefined}
              style={{
                flex: 1,
                minWidth: 180,
                padding: 12,
                borderRadius: 12,
                background: accountEmail
                  ? `color-mix(in srgb, ${configPalette.cardTextMuted} 12%, ${configPalette.cardBackground})`
                  : `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`,
                border: `1px solid ${configPalette.cardBorder}`,
                color: accountEmail ? configPalette.cardTextMuted : configPalette.cardTextMain,
                cursor: accountEmail ? 'not-allowed' : 'text',
                opacity: accountEmail ? 0.8 : 1,
              }}
            />
            <input type="text" autoComplete="shipping street-address" placeholder="Full shipping address (street, city, state, ZIP, country)" value={address} onChange={(e) => setAddress(e.target.value)} style={{ flex: 1, minWidth: 220, padding: 12, borderRadius: 12, background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain }} />
          </form>
          {(mapboxHint === 'autofill-on' || mapboxHint === 'autofill-off' || mapboxHint === 'no-token' || mapboxHint === 'token-rejected') && (
          <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: mapboxHint === 'autofill-on' ? '#34d399' : mapboxHint === 'autofill-off' ? '#fbbf24' : '#f87171' }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: mapboxHint === 'autofill-on' ? '#22c55e' : mapboxHint === 'autofill-off' ? '#f59e0b' : '#ef4444', boxShadow: `0 0 0 2px ${mapboxHint === 'autofill-on' ? 'rgba(34,197,94,0.16)' : mapboxHint === 'autofill-off' ? 'rgba(245,158,11,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
            {mapboxHint === 'autofill-on'
              ? 'Use address dropdown'
              : mapboxHint === 'autofill-off'
                ? 'Address autofill off — enter your full address manually'
                : mapboxHint === 'no-token'
                  ? 'Address autofill off (no Mapbox token) — enter manually'
                  : mapboxHint === 'token-rejected'
                    ? 'Address autofill error — enter manually'
                    : ''}
          </div>
          )}

          <div style={{ marginBottom: 8 }}>
            {showPromoField ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input type="text" placeholder="Promo code" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} style={{ flex: 1, minWidth: 180, padding: 12, borderRadius: 12, background: `color-mix(in srgb, ${configPalette.cardTextMain} 6%, ${configPalette.cardBackground})`, border: `1px solid ${promoValid === false ? '#ef4444' : promoValid === true ? '#22c55e' : configPalette.cardBorder}`, color: configPalette.cardTextMain }} />
                <button onClick={applyPromo} disabled={promoBusy} style={{ padding: '10px 14px', borderRadius: 10, border: `1px solid ${configPalette.cardBorder}`, background: configPalette.cardBackground, color: configPalette.cardTextMain, fontWeight: 700, cursor: promoBusy ? 'not-allowed' : 'pointer', opacity: promoBusy ? 0.6 : 1 }}>{promoBusy ? 'Checking…' : 'Apply'}</button>
                <button onClick={() => setShowPromoField(false)} style={{ padding: '10px 12px', borderRadius: 10, border: 'none', background: 'transparent', color: configPalette.cardTextMuted, fontSize: 12, cursor: 'pointer' }}>Close</button>
              </div>
            ) : promoCode ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: promoValid === false ? '#fca5a5' : '#86efac' }}>
                  {promoValid === false ? `"${promoCode}" not applied` : `✓ ${promoCode} applied`}
                </span>
                <button onClick={() => setShowPromoField(true)} style={{ border: 'none', background: 'transparent', color: configPalette.cardTextMuted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>Change</button>
                <button
                  onClick={() => {
                    setPromoCode('');
                    setPromoValid(null);
                    setPromoMsg('');
                    window.localStorage.removeItem('goyunir-promo-code');
                  }}
                  style={{ border: 'none', background: 'transparent', color: '#fca5a5', fontSize: 12, cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <button onClick={() => setShowPromoField(true)} style={{ padding: '9px 0', border: 'none', background: 'transparent', color: configPalette.cardTextMuted, fontSize: 12, cursor: 'pointer' }}>Add promo or promoter credit</button>
            )}
          </div>
          {promoMsg && <div style={{ marginBottom: 8, fontSize: 11, color: promoValid === false ? '#fca5a5' : '#86efac' }}>{promoMsg}</div>}
          <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: encryptionHealthy ? '#34d399' : '#f87171' }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: encryptionHealthy ? '#22c55e' : '#ef4444', boxShadow: `0 0 0 2px ${encryptionHealthy ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
            {encryptionHealthy ? 'Encrypted payment setup' : 'Encryption check failed'}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isRaffleProduct && (
              <button onClick={handleRaffleSubmit} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '13px 16px', borderRadius: 999, background: `linear-gradient(135deg, ${configPalette.checkoutCtaButton || '#635bff'}, color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 72%, #000))`, color: '#fff', border: '1px solid rgba(255,255,255,0.28)', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', fontSize: 12, boxShadow: `0 10px 28px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08), 0 0 24px color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 45%, transparent)`, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: isSubmitting || checkoutDisabled ? 0.6 : 1 }}>
                {soldOut ? 'Sold out' : isSubmitting ? (<><ButtonSpinner /> Processing</>) : product.isArchived ? 'Re-enter for future return' : (String(copySettings.entryCta || '').trim() || 'Enter allocation')}
              </button>
            )}
            {canCheckoutDirect && (
              <>
                <button onClick={handleDirectCheckout} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '13px 16px', borderRadius: 999, background: `linear-gradient(135deg, ${configPalette.checkoutCtaButton || '#635bff'}, color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 72%, #000))`, color: '#ffffff', border: '1px solid rgba(255,255,255,0.28)', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', fontSize: 12, boxShadow: `0 10px 28px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08), 0 0 24px color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 45%, transparent)`, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: isSubmitting || checkoutDisabled ? 0.6 : 1 }}>
                  {soldOut ? 'Sold out' : isSubmitting ? (<><ButtonSpinner /> Processing</>) : `Secure piece · $${price.toFixed(2)}`}
                </button>
                {showWaitlistOption && (
                  <button onClick={handleWaitlistSubmit} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '12px 14px', borderRadius: 999, background: configPalette.cardBackground, color: configPalette.cardTextMain, border: `1px solid ${configPalette.cardBorder}`, fontWeight: 700, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: isSubmitting || checkoutDisabled ? 0.6 : 1 }}>
                    {soldOut ? 'Sold out' : isSubmitting ? (<><ButtonSpinner /> Processing</>) : product.isArchived ? 'Reserve for next opening' : 'Reserve for launch'}
                  </button>
                )}
              </>
            )}
            {(canCheckoutDirect || isRaffleProduct) && <button onClick={addToCart} disabled={checkoutDisabled || cartBusy} style={{ padding: '12px 16px', borderRadius: 999, background: configPalette.cardBorder, color: configPalette.cardTextMain, border: 'none', cursor: checkoutDisabled || cartBusy ? 'not-allowed' : 'pointer', opacity: checkoutDisabled || cartBusy ? 0.6 : 1 }}>{cartBusy ? (<><ButtonSpinner light={false} /> Checking…</>) : `Add to ${actionLabel}`}</button>}
          </div>

          {message && <div style={{ marginTop: 10, fontSize: 12, color: '#f5c542' }}>{message}</div>}
        </section>

        {product.showNotesSection !== false && (product.notes || []).length > 0 && (
        <section style={{ borderRadius: themeRadius(configPalette, 20), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency), backgroundImage: cardSheen, padding: 14, color: configPalette.cardTextMain }}>
          <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.cardTextMuted, marginBottom: 8 }}>Why this drop matters</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(product.notes || []).map((note: any, index: number) => (
              <div key={`${note.label}-${index}`} style={{ borderRadius: themeRadius(configPalette, 16), background: `color-mix(in srgb, ${configPalette.cardTextMain} 4%, ${configPalette.cardBackground})`, padding: 14, border: `1px solid ${configPalette.cardBorder}` }}>
                <div style={{ fontSize: 10, color: configPalette.accentPurple, textTransform: 'uppercase', letterSpacing: '2px', marginBottom: 4 }}>{note.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, color: configPalette.cardTextMain }}>{note.name}</div>
                <div style={{ fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.55, whiteSpace: 'pre-line' }}>{note.text}</div>
              </div>
            ))}
          </div>
        </section>
        )}

        {showCart && cart.length > 0 && (
          <section style={{ borderRadius: themeRadius(configPalette, 20), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency), backgroundImage: cardSheen, padding: 14, color: configPalette.cardTextMain }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.cardTextMuted, marginBottom: 8 }}>Cart</div>
            {cart.map((item, index) => (
              <div key={`${item.name}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0' }}>
                <span>{item.name} · {item.size}</span>
                <span>${item.price.toFixed(2)}</span>
              </div>
            ))}
            <button onClick={() => window.dispatchEvent(new CustomEvent('goyunir-open-cart'))} style={{ marginTop: 8, padding: '10px 14px', borderRadius: 999, background: configPalette.textMain, color: configPalette.primaryBackground, border: 'none', fontWeight: 700 }}>Review prepared bag</button>
          </section>
        )}
      </div>
    </main>
  );
}
