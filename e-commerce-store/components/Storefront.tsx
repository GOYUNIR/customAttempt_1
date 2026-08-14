'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { useLiveTheme } from '@/components/ThemeProvider';
import { ensureMapboxAutofill, getAutofillAddressValue, getMapboxStatus, isMapboxAutofillActive } from '@/lib/mapbox-autofill';
import { validateShippingAddress } from '@/lib/address-validation';
import { isConfiguredPrice, surfaceBackground } from '@/lib/storefront-config';
import NotFoundView from '@/components/NotFoundView';

const CART_KEY = 'goyunir-cart';
const CHECKOUT_DETAILS_KEY = 'goyunir-checkout-details';

/**
 * Address quality gate for checkout. The validator requires a COMPLETE
 * shippable address (street # + name, city, state, ZIP, country) — see
 * lib/address-validation.ts. Mapbox autofill suggestions fill the whole
 * address, so when autofill is live we add a hint to pick a suggestion.
 */
function addressValidationError(address: string): string | null {
  const error = validateShippingAddress(address);
  if (!error) return null;
  const hint = isMapboxAutofillActive()
    ? ' Tip: pick a complete address from the autofill suggestions as you type — partial addresses can\'t be shipped to.'
    : '';
  return error + hint;
}

function getProductPriceCategory(product: any, size: string) {
  const cats = product.priceCategories || [];
  return cats.find((c: any) => c.size === size) || null;
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [cart, setCart] = useState<any[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [raffleEndsAt, setRaffleEndsAt] = useState<number | null>(null);
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
  const uiRadius = (fallback: number) => {
    const r = Number(configPalette.borderRadius);
    return Number.isFinite(r) && r >= 0 ? `${r}px` : `${fallback}px`;
  };
  const actionMode = typeof window !== 'undefined' ? (window.localStorage.getItem('goyunir-header-action-mode') === 'bag' ? 'bag' : 'cart') : 'cart';
  const actionLabel = actionMode === 'bag' ? 'bag' : 'cart';

  const fetchProduct = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`/api/store?slug=${slug}`);
      const data = await res.json();
      if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      if (data?.config?.gallery) setGallerySettings((prev: any) => ({ ...prev, ...data.config.gallery }));
      if (data.product) {
        setProduct(data.product);
        if (data.product.isArchived) {
          setRaffleEndsAt(null);
        } else {
          const now = Date.now();
          const releaseEndsAt = data.product.releaseEndsAt;
          const releaseMs = releaseEndsAt ? new Date(releaseEndsAt).getTime() : NaN;
          // A live (non-upcoming) drop should count down to its release end
          // while that's still in the future; if it has already passed, fall
          // back to the configured drop-schedule anchor so a live allocation
          // never shows a misleading "closed" countdown.
          let drawAnchor: string | undefined;
          if (data.product.isUpcoming) {
            drawAnchor = data.product.goLiveAt || data.product.releaseEndsAt;
          } else if (Number.isFinite(releaseMs) && releaseMs > now) {
            drawAnchor = data.product.releaseEndsAt;
          } else {
            drawAnchor =
              data?.config?.dropSchedule?.targetEndDateTime ||
              data?.config?.dropSchedule?.countdownEndsAt ||
              data.product.releaseEndsAt ||
              undefined;
          }
          const anchorMs = drawAnchor ? new Date(drawAnchor).getTime() : NaN;
          setRaffleEndsAt(Number.isFinite(anchorMs) && anchorMs > 0 ? anchorMs : null);
        }
        const cats = data.product.priceCategories || [];
        if (cats.length > 0) setSelectedSize(cats[0].size);
        setSelectedImageIndex(0);
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
      const res = await fetch('/api/store');
      const data = await res.json();
      if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
      if (data?.config?.gallery) setGallerySettings((prev: any) => ({ ...prev, ...data.config.gallery }));
      const sorted = Array.isArray(data.activeProducts)
        ? [...data.activeProducts].sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)))
        : [];
      return sorted;
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
    fetch('/api/store')
      .then((res) => res.json())
      .then((data) => {
        const products = Array.isArray(data?.activeProducts) ? data.activeProducts : [];
        const pruned = pruneStaleCart(stored, products);
        if (pruned.length !== stored.length) {
          setCart(pruned);
          writeStoredCart(pruned);
        }
      })
      .catch(() => {});
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
    const checkoutMode = String(product.checkoutMode || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE';
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
    const maxPerCart = Math.max(1, Number(product.maxPerCart || product.maxPerEmail || 1));
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
  };

  useEffect(() => {
    if (!raffleEndsAt) {
      setCountdownLabel('');
      return;
    }
    const update = () => {
      const diff = raffleEndsAt - Date.now();
      if (diff <= 0) {
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
    return () => window.clearInterval(timer);
  }, [raffleEndsAt]);

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
  const checkoutMode = String(product.checkoutMode || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE';
  const canCheckoutDirect = checkoutMode === 'FCFS';
  const isRaffleProduct = checkoutMode === 'RAFFLE';
  const fallbackImage = getFallbackImage(product);
  const galleryImages = Array.isArray(product.images) && product.images.length > 0 ? product.images.filter(Boolean) : (fallbackImage ? [fallbackImage] : []);
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
  const urgencyLabel = soldOut
    ? 'This release is fully spoken for.'
    : inventoryRemaining > 0 && inventoryRemaining <= 12
      ? `Only ${inventoryRemaining} allocations left.`
      : inventoryRemaining > 0 && inventoryRemaining <= 30
        ? `${inventoryRemaining} units remain across this release.`
        : 'Handmade allocation. Low supply by design.';
  const statusStory = product.isUpcoming
    ? 'Collectors can still queue interest before the release opens publicly.'
    : product.isArchived && isRaffleProduct
      ? 'Archive placement keeps the story visible, and raffle entry can still be reopened for private audiences.'
      : product.isArchived
        ? 'Archive placement preserves the release as proof of demand and collectability.'
        : 'Reserved for collectors moving early, before the allocation tightens further.';
  const checkoutDisabled = soldOut || !selectedSize || !isConfiguredPrice(price);
  const showWaitlistOption = !isRaffleProduct && (product.isArchived || product.isUpcoming);

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, padding: '16px 14px 60px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <section style={{ borderRadius: uiRadius(24), overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency) }}>
          <div
            onMouseEnter={() => setGalleryPaused(true)}
            onMouseLeave={() => setGalleryPaused(false)}
            style={{ height: 280, position: 'relative', overflow: 'hidden', cursor: galleryImages.length > 1 ? 'pointer' : 'default' }}
          >
            <div
              style={{
                position: 'absolute',
                inset: -16,
                background: `url(${galleryImages[selectedImageIndex] || galleryImages[0]}) center/cover`,
                animation: zoomOn ? `goyunirKenburns ${zoomSeconds}s ease-in-out infinite alternate` : 'none',
                willChange: 'transform',
              }}
            />
            {galleryImages.length > 1 && autoPlayOn && (
              <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 5, alignItems: 'center' }}>
                {galleryImages.map((_img: string, index: number) => (
                  <button
                    key={`dot-${index}`}
                    onClick={(e) => { e.stopPropagation(); setSelectedImageIndex(index); }}
                    aria-label={`View photo ${index + 1}`}
                    style={{ width: 7, height: 7, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer', background: index === selectedImageIndex ? '#ffffff' : 'rgba(255,255,255,0.4)' }}
                  />
                ))}
              </div>
            )}
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: soldOut ? '#fbbf24' : configPalette.accentBlue }}>{activeProductLabel}</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>{checkoutMode}</div>
            </div>
            <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: 0, color: configPalette.cardTextMain }}>{product.name}</h1>
            <p style={{ margin: 0, color: configPalette.cardTextMuted, fontSize: 13, lineHeight: 1.6 }}>{product.desc}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 16, background: 'rgba(255,255,255,0.03)', border: `1px solid ${soldOut ? 'rgba(251,191,36,0.28)' : 'rgba(255,255,255,0.08)'}` }}>
              <div style={{ fontSize: 11, color: soldOut ? '#fde68a' : configPalette.cardTextMain }}>{urgencyLabel}</div>
              <div style={{ fontSize: 11, color: configPalette.cardTextMuted, lineHeight: 1.5 }}>{product.isArchived ? 'This release is archived, but future returns can still be pre-registered here so collectors stay ahead of the next opening.' : statusStory}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {galleryImages.map((image: string, index: number) => (
                <button key={`${image}-${index}`} onClick={() => setSelectedImageIndex(index)} style={{ width: 54, height: 54, borderRadius: 10, border: selectedImageIndex === index ? `1px solid ${configPalette.accentPurple}` : `1px solid ${configPalette.cardBorder}`, background: `url(${image}) center/cover`, cursor: 'pointer' }} />
              ))}
            </div>
          </div>
        </section>

        <section style={{ borderRadius: uiRadius(20), border: `1px solid ${configPalette.cardBorder}`, background: configPalette.cardBackground, padding: 14, color: configPalette.cardTextMain }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.cardTextMain || '#fff' }}>Select size</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {(product.priceCategories || []).map((cat: any) => {
                const isSample = product.deliveryIncentiveEnabled === true && Array.isArray(product.deliveryIncentiveTriggerSizes) && product.deliveryIncentiveTriggerSizes.includes(cat.size);
                const accent = configPalette.checkoutCtaButton || '#635bff';
                return (
                  <button key={cat.size} onClick={() => setSelectedSize(cat.size)} style={{ padding: '8px 12px', borderRadius: 999, border: selectedSize === cat.size ? `1px solid ${accent}` : `1px solid ${configPalette.cardBorder}`, background: selectedSize === cat.size ? accent : 'transparent', color: selectedSize === cat.size ? '#ffffff' : (configPalette.cardTextMain || '#fff'), cursor: 'pointer', fontSize: 12, fontWeight: selectedSize === cat.size ? 700 : 500 }}>
                    {cat.size} {cat.price > 0 ? `($${cat.price})` : ''}
                    {isSample ? ' · Sample' : ''}
                  </button>
                );
              })}
            </div>
            {product.deliveryIncentiveEnabled === true && ((Array.isArray(product.deliveryIncentiveTriggerSizes) && product.deliveryIncentiveTriggerSizes.length > 0) || Number(product.deliveryIncentiveCreditCents || 0) > 0) && (
              <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 12, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)', fontSize: 11, color: '#86efac', lineHeight: 1.5 }}>
                🧪 Try a sample first: your {Array.isArray(product.deliveryIncentiveTriggerSizes) && product.deliveryIncentiveTriggerSizes.length > 0 ? String(product.deliveryIncentiveTriggerSizes[0]) : 'sample'} purchase is credited toward a full-size order — you only pay the difference.
                {Number(product.deliveryIncentiveCreditCents || 0) > 0 && ` Every sample order includes a $${(Number(product.deliveryIncentiveCreditCents) / 100).toFixed(0)} credit after delivery.`}
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
            <input type="email" autoComplete="email" placeholder="email@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 180, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,0.3)', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain }} />
            <input type="text" autoComplete="shipping street-address" placeholder="Full shipping address (street, city, state, ZIP, country)" value={address} onChange={(e) => setAddress(e.target.value)} style={{ flex: 1, minWidth: 220, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,0.3)', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.cardTextMain }} />
          </form>
          {(mapboxHint === 'autofill-on' || mapboxHint === 'autofill-off' || mapboxHint === 'no-token' || mapboxHint === 'token-rejected') && (
          <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: mapboxHint === 'autofill-on' ? '#34d399' : mapboxHint === 'autofill-off' ? '#fbbf24' : '#f87171' }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: mapboxHint === 'autofill-on' ? '#22c55e' : mapboxHint === 'autofill-off' ? '#f59e0b' : '#ef4444', boxShadow: `0 0 0 2px ${mapboxHint === 'autofill-on' ? 'rgba(34,197,94,0.16)' : mapboxHint === 'autofill-off' ? 'rgba(245,158,11,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
            {mapboxHint === 'autofill-on'
              ? 'Address autofill on — pick a suggestion to fill the full address'
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
                <input type="text" placeholder="Promo code" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} style={{ flex: 1, minWidth: 180, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,0.3)', border: `1px solid ${promoValid === false ? '#ef4444' : promoValid === true ? '#22c55e' : configPalette.cardBorder}`, color: configPalette.cardTextMain }} />
                <button onClick={applyPromo} style={{ padding: '10px 14px', borderRadius: 10, border: `1px solid ${configPalette.cardBorder}`, background: configPalette.cardBackground, color: configPalette.cardTextMain, fontWeight: 700, cursor: 'pointer' }}>Apply</button>
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
              <button onClick={handleRaffleSubmit} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '13px 16px', borderRadius: 999, background: `linear-gradient(135deg, ${configPalette.checkoutCtaButton || '#635bff'}, color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 72%, #000))`, color: '#fff', border: '1px solid rgba(255,255,255,0.28)', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', fontSize: 12, boxShadow: `0 10px 28px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08), 0 0 24px color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 45%, transparent)`, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: checkoutDisabled ? 0.55 : 1 }}>
                {soldOut ? 'Sold out' : isSubmitting ? 'Processing...' : product.isArchived ? 'Re-enter for future return' : 'Enter allocation'}
              </button>
            )}
            {canCheckoutDirect && (
              <>
                <button onClick={handleDirectCheckout} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '13px 16px', borderRadius: 999, background: `linear-gradient(135deg, ${configPalette.checkoutCtaButton || '#635bff'}, color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 72%, #000))`, color: '#ffffff', border: '1px solid rgba(255,255,255,0.28)', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', fontSize: 12, boxShadow: `0 10px 28px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08), 0 0 24px color-mix(in srgb, ${configPalette.checkoutCtaButton || '#635bff'} 45%, transparent)`, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: checkoutDisabled ? 0.55 : 1 }}>
                  {soldOut ? 'Sold out' : isSubmitting ? 'Processing...' : `Secure piece · $${price.toFixed(2)}`}
                </button>
                {showWaitlistOption && (
                  <button onClick={handleWaitlistSubmit} disabled={isSubmitting || checkoutDisabled} style={{ flex: 1, minWidth: 140, padding: '12px 14px', borderRadius: 999, background: configPalette.cardBackground, color: configPalette.cardTextMain, border: `1px solid ${configPalette.cardBorder}`, fontWeight: 700, cursor: isSubmitting || checkoutDisabled ? 'not-allowed' : 'pointer', opacity: checkoutDisabled ? 0.55 : 1 }}>
                    {soldOut ? 'Sold out' : isSubmitting ? 'Processing...' : product.isArchived ? 'Reserve for next opening' : 'Reserve for launch'}
                  </button>
                )}
              </>
            )}
            {(canCheckoutDirect || isRaffleProduct) && <button onClick={addToCart} disabled={checkoutDisabled} style={{ padding: '12px 16px', borderRadius: 999, background: configPalette.cardBorder, color: configPalette.cardTextMain, border: 'none', cursor: checkoutDisabled ? 'not-allowed' : 'pointer', opacity: checkoutDisabled ? 0.55 : 1 }}>Add to {actionLabel}</button>}
          </div>

          {message && <div style={{ marginTop: 10, fontSize: 12, color: '#f5c542' }}>{message}</div>}
        </section>

        <section style={{ borderRadius: uiRadius(20), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency), padding: 14, color: configPalette.cardTextMain }}>
          <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>Why this drop matters</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(product.notes || []).map((note: any, index: number) => (
              <div key={`${note.label}-${index}`} style={{ borderRadius: 16, background: 'rgba(0,0,0,0.25)', padding: 12, border: `1px solid ${configPalette.cardBorder}` }}>
                <div style={{ fontSize: 10, color: configPalette.accentPurple, textTransform: 'uppercase', letterSpacing: '2px', marginBottom: 4 }}>{note.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, color: configPalette.cardTextMain }}>{note.name}</div>
                <div style={{ fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.55 }}>{note.text}</div>
              </div>
            ))}
          </div>
        </section>

        {showCart && cart.length > 0 && (
          <section style={{ borderRadius: uiRadius(20), border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency), padding: 14, color: configPalette.cardTextMain }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>Cart</div>
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
