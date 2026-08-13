'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { ensureMapboxAutofill, getAutofillAddressValue, getMapboxStatus, isMapboxAutofillActive, isMapboxVerifiedAddress } from '@/lib/mapbox-autofill';
import { validateShippingAddress } from '@/lib/address-validation';

type CartItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
  productType?: string;
  checkoutMode?: 'RAFFLE' | 'FCFS';
};

/**
 * Address quality gate for checkout. When Mapbox autofill is live the address
 * must have been picked from the dropdown suggestions; otherwise structural
 * checks still block garbage like "asdf" or "1234567890".
 */
function addressValidationError(address: string): string | null {
  const base = validateShippingAddress(address);
  if (base) return base;
  if (isMapboxAutofillActive() && !isMapboxVerifiedAddress(address)) {
    return 'Choose your shipping address from the autofill suggestions so we can verify it.';
  }
  return null;
}

const CART_KEY = 'goyunir-cart';
const CHECKOUT_DETAILS_KEY = 'goyunir-checkout-details';

// Orb system defaults — overridden at runtime by /admin → Settings → Orb Glow
// (served through `/api/store` → config.orbs). Motion uses a spring-damper so
// the orbs feel heavy and keep momentum instead of snapping to the cursor.
const DEFAULT_ORBS: any = {
  enabled: true,
  primary: { enabled: true, color: '#3b82f6', opacity: 16, size: 58 },
  secondary: { enabled: true, color: '#a855f7', opacity: 26, size: 44 },
  tertiary: { enabled: true, color: '#ffd79b', opacity: 12, size: 28 },
  fourth: { enabled: true, color: '#7dd3fc', opacity: 10, size: 36 },
  fifth: { enabled: true, color: '#f472b6', opacity: 8, size: 24 },
  motion: {
    idleEnabled: true,
    pointerEnabled: true,
    scrollEnabled: true,
    intensity: 100,
    speed: 100,
    momentum: 40,
  },
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Convert 0-100 opacity into a 2-digit hex alpha suffix for hex colors. */
function alphaHex(pct: number) {
  const v = Math.round(clamp(pct, 0, 100) * 255 / 100);
  return v.toString(16).padStart(2, '0');
}

/** Keep colors 6-digit hex so hex-alpha suffixes stay valid. */
function normalizeHex(color: any, fallback: string) {
  const s = String(color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

/** Radial-gradient paint for a glow orb at the given opacity. */
function orbGradient(color: string, opacity: number, fallback: string, edgeRatio = 0.38) {
  const hex = normalizeHex(color, fallback);
  return `radial-gradient(circle, ${hex}${alphaHex(opacity)} 0%, ${hex}${alphaHex(opacity * edgeRatio)} 42%, transparent 72%)`;
}

function readCart(): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCart(items: CartItem[]) {
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

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutEmail, setCheckoutEmail] = useState('');
  const [checkoutAddress, setCheckoutAddress] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [cartMsg, setCartMsg] = useState('');
  const [theme, setTheme] = useState<any>(null);
  const [branding, setBranding] = useState<any>(null);
  const [orbs, setOrbs] = useState<any>(null);
  const [promoCode, setPromoCode] = useState('');
  const [bannerMessage, setBannerMessage] = useState('');
  const [encryptionHealthy, setEncryptionHealthy] = useState(true);
  const [showPromoField, setShowPromoField] = useState(false);
  const [notice, setNotice] = useState<{ id?: string; type: string; message: string } | null>(null);
  const [showScrollCue, setShowScrollCue] = useState(true);
  const [mapboxHint, setMapboxHint] = useState('');
  const targetXRef = useRef(0.5);
  const targetYRef = useRef(0.35);
  const velocityXRef = useRef(0);
  const velocityYRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const lastScrollAtRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  // Background glow + top-bar orb are animated via direct DOM writes (refs) so
  // the ~60fps idle/pointer drift never triggers a React re-render of the app.
  // Motion is a spring-damper: heavy, smooth, momentum-filled, no sharp snaps.
  const easedXRef = useRef(0.5);
  const easedYRef = useRef(0.35);
  const orbVXRef = useRef(0);
  const orbVYRef = useRef(0);
  const pointerTargetXRef = useRef(0.5);
  const pointerTargetYRef = useRef(0.35);
  const lastFrameAtRef = useRef(0);
  const orbsRef = useRef<any>(null);
  const orbPrimaryRef = useRef<HTMLDivElement | null>(null);
  const orbSecondaryRef = useRef<HTMLDivElement | null>(null);
  const orbTertiaryRef = useRef<HTMLDivElement | null>(null);
  const orbFourthRef = useRef<HTMLDivElement | null>(null);
  const orbFifthRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether a finger is actively on the screen. While touching, scroll
  // motion is paused so the orbs keep following the finger instead of being
  // yanked around by the page scroll on mobile.
  const touchingRef = useRef(false);

  const showNotice = (next: { id?: string; type: string; message: string; persist?: boolean }) => {
    setNotice({ id: next.id, type: next.type, message: next.message });
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    // Regular notices hide quickly; persisted alerts (Stripe success/fail etc.)
    // stay up much longer so the customer can't miss them, then auto-dismiss.
    if (next.type !== 'loading') {
      const duration = next.persist ? 10000 : 2400;
      noticeTimerRef.current = window.setTimeout(() => setNotice((current) => (current?.id === next.id || !next.id ? null : current)), duration);
    }
  };

  // Keep the rAF loop in sync with the latest admin orb settings without
  // restarting the loop or re-rendering.
  useEffect(() => {
    orbsRef.current = orbs;
  }, [orbs]);

  // Attach Mapbox address autofill to the cart drawer's shipping field. The
  // helper is a singleton and its collection observes the document for inputs
  // added later (the drawer only mounts when opened), so this call is enough.
  useEffect(() => {
    ensureMapboxAutofill();
  }, []);

  // Live Mapbox autofill hint (drives the small status line in the cart drawer).
  // The status event + a safety poll keep the hint in sync with the real DOM:
  // the SDK's attach loop can verify after the last event fires, and React can
  // replace the shipping input node (dropping attach side effects) — re-reading
  // the live status every ~1.2s converges the hint (and restarts the attach
  // retry loop through getMapboxStatus() when inputs aren't attached yet).
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

  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    const draft = readCheckoutDetails();
    if (draft.email) setCheckoutEmail(draft.email);
    if (draft.address) setCheckoutAddress(draft.address);
    const open = () => setCartOpen(true);
    const onScroll = () => {
      const nextScroll = window.scrollY || 0;
      if (nextScroll > 120) setShowScrollCue(false);
      else if (nextScroll < 40) setShowScrollCue(true);
    };
    let lastInteraction = Date.now();
    const onPointer = (event: PointerEvent) => {
      const cfg = orbsRef.current;
      if (cfg?.motion?.pointerEnabled === false) return;
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      targetXRef.current = clamp(event.clientX / width, 0.04, 0.96);
      targetYRef.current = clamp(event.clientY / height, 0.06, 0.94);
      lastInteraction = Date.now();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchingRef.current = true;
      const cfg = orbsRef.current;
      if (cfg?.motion?.pointerEnabled === false) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      targetXRef.current = clamp(touch.clientX / width, 0.04, 0.96);
      targetYRef.current = clamp(touch.clientY / height, 0.06, 0.94);
      lastInteraction = Date.now();
    };
    const onTouchEnd = () => {
      touchingRef.current = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      touchingRef.current = true;
      const cfg = orbsRef.current;
      if (cfg?.motion?.pointerEnabled === false) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      targetXRef.current = clamp(touch.clientX / width, 0.04, 0.96);
      targetYRef.current = clamp(touch.clientY / height, 0.06, 0.94);
      lastInteraction = Date.now();
    };

    // Pushes the eased glow position straight onto the DOM (no React state),
    // which keeps the animation at 60fps without re-rendering the app. Only
    // `transform` is written on the glow orbs — transform-only updates run on
    // the compositor thread, so nothing forces a paint per frame. The orbs are
    // pre-blurred radial gradients (no `filter: blur()`), so the glow is
    // painted once and then only composited.
    const applyGlow = (x: number, y: number) => {
      const cfg = orbsRef.current;
      const motion = cfg?.motion || DEFAULT_ORBS.motion;
      const intensity = clamp((motion.intensity ?? 100) / 100, 0.2, 2.5);
      const primary = orbPrimaryRef.current;
      const secondary = orbSecondaryRef.current;
      const tertiary = orbTertiaryRef.current;
      const fourth = orbFourthRef.current;
      const fifth = orbFifthRef.current;
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      if (primary) {
        primary.style.transform = `translate3d(${((-16 + x * 68 * intensity) / 100) * vw}px, ${((-8 + y * 72 * intensity) / 100) * vh}px, 0)`;
      }
      if (secondary) {
        secondary.style.transform = `translate3d(${((56 - x * 32 * intensity) / 100) * vw}px, ${((48 - y * 26 * intensity) / 100) * vh}px, 0)`;
      }
      if (tertiary) {
        tertiary.style.transform = `translate3d(${((18 + x * 24 * intensity) / 100) * vw}px, ${((62 - y * 18 * intensity) / 100) * vh}px, 0)`;
      }
      if (fourth) {
        fourth.style.transform = `translate3d(${((-32 - x * 18 * intensity) / 100) * vw}px, ${((76 + y * 22 * intensity) / 100) * vh}px, 0)`;
      }
      if (fifth) {
        fifth.style.transform = `translate3d(${((82 + x * 16 * intensity) / 100) * vw}px, ${((18 - y * 30 * intensity) / 100) * vh}px, 0)`;
      }
    };

    let rafId = 0;
    let idleTargetX = 0.52;
    let idleTargetY = 0.42;
    let nextIdleRetargetAt = Date.now() + 2300;
    let running = true;
    // Compositor throttle: the physics runs every rAF, but we only write orb
    // transforms every other frame (~30fps). Ambient glow reads smooth at 30fps
    // and this halves the per-frame compositor work — a meaningful lag fix on
    // seeded stores with product imagery layered over the glow.
    let glowFrameCount = 0;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animateIdle = () => {
      if (!running) return;
      const cfg = orbsRef.current;
      // When orbs are switched off from /admin, stop the loop entirely so
      // it never wastes GPU/CPU on hidden elements (this was a lag source on
      // seeded stores). The loop only runs again after a full page reload.
      if (cfg && cfg.enabled === false) {
        running = false;
        return;
      }
      const nowPerf = performance.now();
      const lastFrame = lastFrameAtRef.current || nowPerf;
      const dt = Math.min(34, Math.max(8, nowPerf - lastFrame));
      lastFrameAtRef.current = nowPerf;
      const frame = dt / 16.667;

      const now = Date.now();
      const motion = cfg?.motion || DEFAULT_ORBS.motion;
      const intensity = clamp((motion.intensity ?? 100) / 100, 0.2, reducedMotion ? 0.5 : 2.5);
      const speedFactor = clamp((motion.speed ?? 100) / 100, 0.3, reducedMotion ? 0.7 : 2.2);
      const momentumFactor = clamp((motion.momentum ?? 40) / 100, 0, 1);

      const idleFor = now - lastInteraction;
      const scrollMomentumAge = now - lastScrollAtRef.current;

      // Idle drift: gently wander the raw target, never snapping.
      if (motion.idleEnabled && idleFor > 950) {
        if (now >= nextIdleRetargetAt) {
          idleTargetX = 0.16 + Math.random() * 0.68;
          idleTargetY = 0.12 + Math.random() * 0.7;
          nextIdleRetargetAt = now + 2200 + Math.random() * 2600;
        }
        const t = now / 1000;
        const microDriftX = Math.sin(t * 0.9) * 0.012 + Math.sin(t * 1.7) * 0.005;
        const microDriftY = Math.cos(t * 0.85) * 0.011 + Math.cos(t * 1.5) * 0.005;
        targetXRef.current = clamp(targetXRef.current + (idleTargetX - targetXRef.current) * 0.014 + microDriftX, 0.05, 0.95);
        targetYRef.current = clamp(targetYRef.current + (idleTargetY - targetYRef.current) * 0.014 + microDriftY, 0.08, 0.92);
      }

      // Scroll momentum: keep feeding the target while the scroll decelerates.
      if (motion.scrollEnabled && scrollMomentumAge < 2600) {
        targetXRef.current = clamp(targetXRef.current + velocityXRef.current * frame, 0.05, 0.95);
        targetYRef.current = clamp(targetYRef.current + velocityYRef.current * frame, 0.08, 0.92);
        velocityXRef.current *= Math.pow(0.97, frame);
        velocityYRef.current *= Math.pow(0.97, frame);
      }

      // Smooth the target with a low-pass filter so even sudden pointer jumps
      // glide instead of lurching the orbs.
      const targetSmooth = clamp(0.05 * speedFactor, 0.02, 0.18);
      pointerTargetXRef.current = clamp(
        pointerTargetXRef.current + (targetXRef.current - pointerTargetXRef.current) * targetSmooth * frame,
        0.05, 0.95,
      );
      pointerTargetYRef.current = clamp(
        pointerTargetYRef.current + (targetYRef.current - pointerTargetYRef.current) * targetSmooth * frame,
        0.08, 0.92,
      );

      // Spring-damper toward the smoothed target: this is what gives the orbs
      // their heavy, momentum-filled feel. Higher `momentum` = less friction,
      // so the orbs keep gliding after you stop and settle with a soft drift.
      const stiffness = 0.0022 * speedFactor;
      const friction = 0.928 + momentumFactor * 0.038;
      orbVXRef.current += (pointerTargetXRef.current - easedXRef.current) * stiffness * frame;
      orbVYRef.current += (pointerTargetYRef.current - easedYRef.current) * stiffness * frame;
      orbVXRef.current *= Math.pow(friction, frame);
      orbVYRef.current *= Math.pow(friction, frame);

      // Hard velocity cap — the orbs can never snap or teleport.
      const maxVel = 0.024 * speedFactor * (0.4 + momentumFactor);
      orbVXRef.current = clamp(orbVXRef.current, -maxVel, maxVel);
      orbVYRef.current = clamp(orbVYRef.current, -maxVel, maxVel);

      const easedX = clamp(easedXRef.current + orbVXRef.current * frame, 0.02, 0.98);
      const easedY = clamp(easedYRef.current + orbVYRef.current * frame, 0.05, 0.95);
      easedXRef.current = easedX;
      easedYRef.current = easedY;
      glowFrameCount += 1;
      if (glowFrameCount % 2 === 0) {
        applyGlow(easedX, easedY);
      }
      rafId = window.requestAnimationFrame(animateIdle);
    };

    const onScrollMotion = () => {
      const cfg = orbsRef.current;
      if (cfg?.motion?.scrollEnabled === false) return;
      // While a finger is down on a touch device the orbs follow the touch, not
      // the scroll — otherwise the scroll event fights the touch position and
      // the orbs appear to only react to the very first touch.
      if (touchingRef.current) return;
      const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
      const progress = (window.scrollY || 0) / maxScroll;
      const now = Date.now();
      const deltaY = window.scrollY - lastScrollYRef.current;
      const deltaT = Math.max(16, now - lastScrollAtRef.current || 16);
      const scrollVelocity = deltaY / deltaT;
      velocityYRef.current = clamp(velocityYRef.current + scrollVelocity * 0.62, -0.14, 0.14);
      velocityXRef.current = clamp(Math.sin(progress * Math.PI * 6) * 0.028 + scrollVelocity * 0.07, -0.08, 0.08);
      targetYRef.current = clamp(0.15 + progress * 0.7, 0.1, 0.9);
      targetXRef.current = clamp(0.5 + Math.sin(progress * Math.PI * 4) * 0.16, 0.08, 0.92);
      lastScrollYRef.current = window.scrollY || 0;
      lastScrollAtRef.current = now;
      lastInteraction = Date.now();
    };

    const params = new URLSearchParams(window.location.search);
    const incomingPromo = String(params.get('ref') || params.get('promo') || '').trim().toUpperCase();
    if (incomingPromo) {
      window.localStorage.setItem('goyunir-promo-code', incomingPromo);
      setPromoCode(incomingPromo);
      setShowPromoField(true);
      setBannerMessage(`Promoter credit ${incomingPromo} is locked for this session.`);
      fetch('/api/promo/validate/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: incomingPromo }),
      }).catch(() => {});
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      const storedPromo = String(window.localStorage.getItem('goyunir-promo-code') || '').trim().toUpperCase();
      if (storedPromo) {
        setPromoCode(storedPromo);
        setShowPromoField(true);
      }
    }

    fetchStoreJson('/api/store')
      .then((data) => {
        setTheme(data?.config?.themeColors || null);
        setBranding(data?.config?.branding || null);
        setOrbs(data?.config?.orbs || null);
      })
      .catch(() => {});

    const onNotify = (event: Event) => {
      const custom = event as CustomEvent<any>;
      const detail = custom.detail || {};
      if (detail.action === 'dismiss') {
        setNotice((current) => {
          if (!detail.id) return null;
          return current?.id === detail.id ? null : current;
        });
        return;
      }
      if (!detail.message) return;
      showNotice({
        id: detail.id,
        type: String(detail.type || 'info'),
        message: String(detail.message),
        persist: detail.persist === true,
      });
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(rafId);
      } else if (!running) {
        running = true;
        lastFrameAtRef.current = performance.now();
        rafId = window.requestAnimationFrame(animateIdle);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    window.addEventListener('goyunir-open-cart', open as EventListener);
    window.addEventListener('goyunir-cart-updated', sync as EventListener);
    window.addEventListener('storage', sync);
    window.addEventListener('goyunir-notify', onNotify as EventListener);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScrollMotion, { passive: true });
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    lastFrameAtRef.current = performance.now();
    rafId = window.requestAnimationFrame(animateIdle);
    applyGlow(easedXRef.current, easedYRef.current);
    const cueTimer = window.setTimeout(() => setShowScrollCue((current) => (current ? true : current)), 600);
    return () => {
      running = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('goyunir-open-cart', open as EventListener);
      window.removeEventListener('goyunir-cart-updated', sync as EventListener);
      window.removeEventListener('storage', sync);
      window.removeEventListener('goyunir-notify', onNotify as EventListener);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScrollMotion);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(cueTimer);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // Apply the admin-configured theme (design presets) to the live page shell.
  // Colors are consumed at build time by static pages, but this keeps the body
  // background/color/font and the design tokens (--background/--foreground/
  // --ui-radius) instantly in sync with whatever is saved in /admin → Settings.
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    const radius = Number(theme.borderRadius) >= 0 ? `${Number(theme.borderRadius)}px` : '12px';
    root.style.setProperty('--ui-radius', radius);
    root.style.setProperty('--background', theme.primaryBackground || '#0a0a0a');
    root.style.setProperty('--foreground', theme.textMain || '#ffffff');
    document.body.style.background = theme.primaryBackground || '#0a0a0a';
    document.body.style.color = theme.textMain || '#ffffff';
    if (theme.fontFamily) document.body.style.fontFamily = theme.fontFamily;
  }, [theme]);

  useEffect(() => {
    writeCheckoutDetails(checkoutEmail, checkoutAddress);
  }, [checkoutEmail, checkoutAddress]);

  const total = cart.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const hasItems = cart.length > 0;
  const hasRaffleItems = cart.some((item) => (item.checkoutMode || '').toUpperCase() === 'RAFFLE' || String(item.productType || '').toLowerCase() === 'raffle');
  const hasFcfsItems = cart.some((item) => (item.checkoutMode || '').toUpperCase() === 'FCFS' || String(item.productType || '').toLowerCase() === 'fcfs');
  const cartHasMixedModes = hasRaffleItems && hasFcfsItems;
  const raffleOnlyCart = hasRaffleItems && !hasFcfsItems;
  const checkoutLabel = raffleOnlyCart ? 'Secure entry' : 'Checkout now';

  const checkoutCart = async () => {
    if (!hasItems) return;
    if (cartHasMixedModes) {
      setCartMsg('Separate raffle entries from direct-purchase items so checkout stays simple and secure.');
      showNotice({ type: 'alert', message: 'Separate raffle entries from direct purchases.' });
      return;
    }
    if (raffleOnlyCart) {
      setCartMsg(`Raffle entries are prepared in your ${actionTitle.toLowerCase()} and secured from the product page.`);
      showNotice({ type: 'alert', message: `Use the product page to secure raffle entries in your ${actionTitle.toLowerCase()}.` });
      return;
    }
    if (!checkoutEmail) {
      setCartMsg('Enter your email to continue.');
      showNotice({ type: 'alert', message: 'Add your email first.' });
      return;
    }
    const liveAddress = getAutofillAddressValue() || checkoutAddress;
    const addrErr = addressValidationError(liveAddress);
    if (addrErr) {
      setCartMsg(addrErr);
      showNotice({ type: 'alert', message: addrErr });
      return;
    }
    setCheckoutBusy(true);
    setCartMsg('');
    showNotice({ id: 'cart-checkout', type: 'loading', message: 'Preparing secure checkout...', persist: true });
    try {
      const payload = {
        email: checkoutEmail.trim().toLowerCase(),
        address: liveAddress,
        promoCode: String(window.localStorage.getItem('goyunir-promo-code') || '').trim().toUpperCase(),
        items: cart.map((item) => ({ productId: item.productId, size: item.size, quantity: 1 })),
      };
      const res = await fetch('/api/checkout/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        setEncryptionHealthy(true);
        showNotice({ id: 'cart-checkout', type: 'success', message: 'Checkout is ready.' });
        window.location.assign(data.url);
        return;
      }
      setEncryptionHealthy(false);
      setCartMsg(data.error || 'Unable to start checkout.');
      showNotice({ id: 'cart-checkout', type: 'error', message: data.error || 'Unable to start checkout.' });
    } catch {
      setEncryptionHealthy(false);
      setCartMsg('Unable to start checkout.');
      showNotice({ id: 'cart-checkout', type: 'error', message: 'Unable to start checkout.' });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const headerBg = theme?.cardBackground || 'rgba(8,8,10,0.94)';
  // Full palette for the chrome/cart drawer — starts at the build-time config and
  // upgrades to whatever /admin → Settings has saved (theme state is set from
  // /api/store → config → themeColors). Keeps drawer/card text editable.
  const liveTheme = { ...GOYUNIR_STORE_SUITE.themeColors, ...(theme || {}) } as Record<string, any>;
  const drawerBg = liveTheme.cardBackground || '#0b0b0f';
  const drawerText = liveTheme.cardTextMain || '#ffffff';
  const drawerTextMuted = liveTheme.cardTextMuted || '#a1a1aa';
  const uiRadius = (fallback: number) => {
    const r = Number(liveTheme.borderRadius);
    return Number.isFinite(r) && r >= 0 ? `${r}px` : `${fallback}px`;
  };
  const headerMode = String(branding?.headerMode || 'both').toLowerCase();
  const showBrandText = headerMode !== 'logo';
  const showBrandLogo = headerMode !== 'text';
  const headerActionMode = String(branding?.headerActionMode || 'cart').toLowerCase();
  const actionTitle = headerActionMode === 'bag' ? 'Bag' : 'Cart';
  const actionVerb = headerActionMode === 'bag' ? 'bag' : 'cart';

  // Resolve admin-configurable orb settings (falls back to built-in defaults).
  const resolvedOrbs = orbs || DEFAULT_ORBS;
  const orbsEnabled = resolvedOrbs.enabled !== false;
  const primaryOrb = { ...DEFAULT_ORBS.primary, ...(resolvedOrbs.primary || {}) };
  const secondaryOrb = { ...DEFAULT_ORBS.secondary, ...(resolvedOrbs.secondary || {}) };
  const tertiaryOrb = { ...DEFAULT_ORBS.tertiary, ...(resolvedOrbs.tertiary || {}) };
  const fourthOrb = { ...DEFAULT_ORBS.fourth, ...(resolvedOrbs.fourth || {}) };
  const fifthOrb = { ...DEFAULT_ORBS.fifth, ...(resolvedOrbs.fifth || {}) };

  // Keep the resolved header action mode ("bag" vs "cart") in sync so the
  // storefront can read it on render. Without this, the value was only ever
  // written inside the promo-link branch with the initial render's value, so
  // the Admin "Top-right action label" setting never reached the storefront.
  useEffect(() => {
    window.localStorage.setItem('goyunir-header-action-mode', headerActionMode);
  }, [headerActionMode]);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden', background: 'linear-gradient(180deg, rgba(255,255,255,0.018), transparent 28%)' }}>
        {orbsEnabled && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 35%, rgba(255,255,255,0.022), transparent 16%)' }} />}
        {orbsEnabled && primaryOrb.enabled !== false && (
          <div ref={orbPrimaryRef} style={{ position: 'absolute', left: 0, top: 0, width: `${Number(primaryOrb.size) || 58}vw`, height: `${Number(primaryOrb.size) || 58}vw`, minWidth: 160, minHeight: 160, maxWidth: 720, maxHeight: 720, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: orbGradient(primaryOrb.color, primaryOrb.opacity, '#3b82f6'), willChange: 'transform' }} />
        )}
        {orbsEnabled && secondaryOrb.enabled !== false && (
          <div ref={orbSecondaryRef} style={{ position: 'absolute', left: 0, top: 0, width: `${Number(secondaryOrb.size) || 44}vw`, height: `${Number(secondaryOrb.size) || 44}vw`, minWidth: 120, minHeight: 120, maxWidth: 540, maxHeight: 540, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: orbGradient(secondaryOrb.color, secondaryOrb.opacity, '#a855f7'), willChange: 'transform' }} />
        )}
        {orbsEnabled && tertiaryOrb.enabled !== false && (
          <div ref={orbTertiaryRef} style={{ position: 'absolute', left: 0, top: 0, width: `${Number(tertiaryOrb.size) || 28}vw`, height: `${Number(tertiaryOrb.size) || 28}vw`, minWidth: 90, minHeight: 90, maxWidth: 340, maxHeight: 340, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: orbGradient(tertiaryOrb.color, tertiaryOrb.opacity, '#ffd79b'), willChange: 'transform' }} />
        )}
        {orbsEnabled && fourthOrb.enabled !== false && (
          <div ref={orbFourthRef} style={{ position: 'absolute', left: 0, top: 0, width: `${Number(fourthOrb.size) || 36}vw`, height: `${Number(fourthOrb.size) || 36}vw`, minWidth: 90, minHeight: 90, maxWidth: 420, maxHeight: 420, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: orbGradient(fourthOrb.color, fourthOrb.opacity, '#7dd3fc'), willChange: 'transform' }} />
        )}
        {orbsEnabled && fifthOrb.enabled !== false && (
          <div ref={orbFifthRef} style={{ position: 'absolute', left: 0, top: 0, width: `${Number(fifthOrb.size) || 24}vw`, height: `${Number(fifthOrb.size) || 24}vw`, minWidth: 70, minHeight: 70, maxWidth: 300, maxHeight: 300, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: orbGradient(fifthOrb.color, fifthOrb.opacity, '#f472b6'), willChange: 'transform' }} />
        )}
      </div>
      {bannerMessage && (
        <div style={{ position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 150, padding: '8px 12px', borderRadius: 999, background: 'rgba(10,10,12,0.92)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontSize: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
          {bannerMessage}{promoCode ? ` · ${promoCode}` : ''}
        </div>
      )}
      {notice && (
        <div style={{ position: 'fixed', top: 66, left: '50%', transform: 'translateX(-50%)', zIndex: 170, maxWidth: 'calc(100vw - 24px)' }}>
          <div
            onClick={() => setNotice(null)}
            role="alert"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 999, background: 'rgba(10,10,12,0.96)', color: '#fff', border: `1px solid ${notice.type === 'error' ? 'rgba(248,113,113,0.45)' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? 'rgba(52,211,153,0.45)' : notice.type === 'loading' ? 'rgba(125,211,252,0.45)' : 'rgba(255,255,255,0.18)'}`, fontSize: 12, boxShadow: '0 16px 40px rgba(0,0,0,0.5)', cursor: 'pointer' }}>
            <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
              {notice.type === 'loading' ? (
                <>
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 0.45, animation: 'goyunirPulse 0.9s ease-in-out infinite' }} />
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 0.75, animation: 'goyunirPulse 0.9s ease-in-out 0.15s infinite' }} />
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 1, animation: 'goyunirPulse 0.9s ease-in-out 0.3s infinite' }} />
                </>
              ) : (
                <span style={{ width: 8, height: 8, borderRadius: 999, background: notice.type === 'error' ? '#f87171' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? '#34d399' : notice.type === 'alert' ? '#facc15' : '#d4d4d8', boxShadow: `0 0 0 3px ${notice.type === 'error' ? 'rgba(248,113,113,0.2)' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? 'rgba(52,211,153,0.2)' : notice.type === 'alert' ? 'rgba(250,204,21,0.18)' : 'rgba(255,255,255,0.1)'}` }} />
              )}
            </span>
            <span>{notice.message}</span>
            <span style={{ color: '#71717a', fontSize: 11, fontWeight: 700, paddingLeft: 4 }}>✕</span>
          </div>
        </div>
      )}
      <style>{`@keyframes goyunirPulse { 0%, 80%, 100% { transform: translateY(0); opacity: .28; } 40% { transform: translateY(-1px); opacity: 1; } } @keyframes goyunirBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } } @keyframes goyunirFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }`}</style>
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          minHeight: '84px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: `${headerBg}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 12px 14px',
          zIndex: 100,
          boxSizing: 'border-box',
          transform: 'translateY(0)',
          transition: 'transform 160ms ease',
          overflow: 'hidden',
          boxShadow: '0 18px 50px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-start', flex: 1 }}>
          <Link href="/catalog" aria-label="Catalog" style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', color: '#f5f5f5', textDecoration: 'none', boxShadow: '0 10px 24px rgba(0,0,0,0.16)' }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" /><path d="M8 9h8" /><path d="M8 13h5" /></svg>
          </Link>
          <Link href="/catalog" aria-label="Search" style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', color: '#d4d4d8', textDecoration: 'none', boxShadow: '0 10px 24px rgba(0,0,0,0.16)' }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6" /><path d="m20 20-4.2-4.2" /></svg>
          </Link>
        </div>

        <Link
          href="/"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            fontWeight: 800,
            letterSpacing: '3.5px',
            fontSize: '11px',
            textTransform: 'uppercase',
            color: '#ffffff',
            textDecoration: 'none',
            maxWidth: '38%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 6px',
          }}
        >
          {showBrandLogo && (branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={branding?.shareTitle || 'GOYUNIR'} style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'cover', display: 'block' }} />
          ) : null)}
          {showBrandText ? <span>{branding?.shareTitle || 'GOYUNIR'}</span> : null}
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flex: 1 }}>
          <Link href="/account" aria-label="Account" style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', color: '#d4d4d8', textDecoration: 'none', boxShadow: '0 10px 24px rgba(0,0,0,0.16)' }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
          </Link>
          <button
            onClick={() => setCartOpen(true)}
            aria-label={actionTitle}
            title={actionTitle}
            style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: hasItems ? '#f3f4f6' : 'rgba(255,255,255,0.07)', color: hasItems ? '#09090b' : '#f5f5f5', cursor: 'pointer', boxShadow: '0 10px 24px rgba(0,0,0,0.16)', position: 'relative' }}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M3 4h2l2.4 9.2a1 1 0 0 0 1 .8h8.4a1 1 0 0 0 1-.8L17 7H7" /></svg>
            {cart.length > 0 ? <span style={{ position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, padding: '0 4px', fontSize: 10, borderRadius: 999, background: '#7dd3fc', color: '#07121f', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{cart.length}</span> : null}
          </button>
        </div>
      </header>

      <div style={{ paddingTop: '92px', minHeight: '100vh' }}>{children}</div>

      <div style={{ position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)', zIndex: 90, opacity: showScrollCue ? 1 : 0, pointerEvents: 'none', transition: 'opacity 220ms ease' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 0', color: '#f5f5f5', fontSize: 10, letterSpacing: '2px', textTransform: 'uppercase', opacity: 0.9 }}>
          <span style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.35)' }} />
          <span>Keep scrolling</span>
          <span style={{ fontSize: 12, animation: 'goyunirFloat 1.2s ease-in-out infinite' }}>↓</span>
        </div>
      </div>

      <footer style={{ background: liveTheme.primaryBackground || 'rgba(8,8,10,0.96)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '38px 20px 58px', textAlign: 'center', color: liveTheme.textMuted || '#71717a', fontSize: 12, position: 'relative', zIndex: 10 }}>
        <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Link href="/terms" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Terms</Link>
            <Link href="/privacy" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Privacy</Link>
            <Link href="/shipping" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Shipping</Link>
            <Link href="/account" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Manage My Entry</Link>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
            <a href="https://instagram.com/goyunir" target="_blank" rel="noreferrer" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Instagram</a>
            <a href="https://tiktok.com/goyunir" target="_blank" rel="noreferrer" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>TikTok</a>
            <a href="mailto:goyunir.support@gmail.com" style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>goyunir.support@gmail.com</a>
          </div>
          <div style={{ color: liveTheme.textMuted || '#71717a', fontSize: 10 }}>
            © {new Date().getFullYear()} GOYUNIR ALL RIGHTS RESERVED.
          </div>
        </div>
      </footer>

      {cartOpen && (
        <div onClick={() => setCartOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(event) => event.stopPropagation()} style={{ width: 'min(92vw, 360px)', height: '100%', background: drawerBg, borderLeft: '1px solid rgba(255,255,255,0.08)', padding: '18px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', color: drawerText }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: liveTheme.accentBlue || '#7dd3fc' }}>{actionTitle}</div>
                <div style={{ fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', color: drawerText }}>Review items</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: drawerTextMuted, borderRadius: 999, padding: '8px 10px', cursor: 'pointer' }}>Close</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cart.length === 0 ? (
                <div style={{ border: '1px dashed rgba(255,255,255,0.12)', borderRadius: uiRadius(20), padding: 18, color: drawerTextMuted, fontSize: 13, lineHeight: 1.6 }}>
                  Your {actionTitle.toLowerCase()} is empty. Add direct-purchase items from a product page to review them here.
                </div>
              ) : (
                cart.map((item, index) => (
                  <div key={`${item.productId}-${item.size}-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: uiRadius(18), padding: 12, background: 'rgba(255,255,255,0.04)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: drawerText }}>{item.name}</div>
                        <div style={{ fontSize: 11, color: drawerTextMuted, marginTop: 3 }}>{item.size}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: drawerText }}>${Number(item.price || 0).toFixed(2)}</div>
                        <button
                          onClick={() => {
                            const next = cart.filter((_, currentIndex) => currentIndex !== index);
                            setCart(next);
                            writeCart(next);
                          }}
                          style={{ marginTop: 6, border: 'none', background: 'transparent', color: '#fca5a5', fontSize: 11, cursor: 'pointer' }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 14, paddingTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: drawerTextMuted, marginBottom: 12 }}>
                <span>Total</span>
                <strong>${total.toFixed(2)}</strong>
              </div>
              {hasItems && (
                <form onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                  <input
                    type="email"
                    autoComplete="email"
                    value={checkoutEmail}
                    onChange={(e) => setCheckoutEmail(e.target.value)}
                    placeholder="name@example.com"
                    style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.3)', color: drawerText, fontSize: 12 }}
                  />
                  <input autoComplete="shipping street-address" type="text" value={checkoutAddress} onChange={(e) => setCheckoutAddress(e.target.value)} placeholder="Shipping address" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.3)', color: drawerText, fontSize: 12 }} />
                  {mapboxHint === 'autofill-on' && (
                    <div style={{ fontSize: 10, color: '#34d399' }}>✓ Address autofill is on — start typing to pick your address.</div>
                  )}
                  {mapboxHint === 'autofill-off' && (
                    <div style={{ fontSize: 10, color: '#fbbf24' }}>Address autofill could not attach right now — you can enter your address manually.</div>
                  )}
                  {mapboxHint === 'no-token' && (
                    <div style={{ fontSize: 10, color: '#f87171' }}>Address autofill is off (Mapbox token not configured) — enter your address manually.</div>
                  )}
                  {mapboxHint === 'token-rejected' && (
                    <div style={{ fontSize: 10, color: '#f87171' }}>Mapbox is rejecting the autofill token — open the console / <code>window.__GOYUNIR_MAPBOX__</code> for the exact error, or enter your address manually.</div>
                  )}
                  {!showPromoField ? (
                    <button type="button" onClick={() => setShowPromoField(true)} style={{ alignSelf: 'flex-start', padding: '4px 0', border: 'none', background: 'transparent', color: drawerTextMuted, fontSize: 12, cursor: 'pointer' }}>Add promo or promoter credit</button>
                  ) : (
                    <input
                      type="text"
                      value={promoCode}
                      onChange={(e) => {
                        const next = e.target.value.toUpperCase().trim();
                        setPromoCode(next);
                        window.localStorage.setItem('goyunir-promo-code', next);
                      }}
                      placeholder="Promo code (optional)"
                      style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.3)', color: drawerText, fontSize: 12 }}
                    />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: encryptionHealthy ? '#34d399' : '#f87171' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: encryptionHealthy ? '#22c55e' : '#ef4444', boxShadow: `0 0 0 2px ${encryptionHealthy ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
                    {encryptionHealthy ? 'Encrypted checkout' : 'Encryption check failed'}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>These details stay remembered across product and cart checkout so collectors do not need to repeat themselves.</div>
                </form>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={checkoutCart} disabled={checkoutBusy || !hasItems || raffleOnlyCart} style={{ flex: 1, textAlign: 'center', padding: '12px 14px', borderRadius: 999, background: liveTheme.textMain || '#f3f4f6', color: liveTheme.primaryBackground || '#09090b', border: 'none', textDecoration: 'none', fontWeight: 700, fontSize: 13, cursor: checkoutBusy || !hasItems || raffleOnlyCart ? 'not-allowed' : 'pointer' }}>
                  {checkoutBusy ? 'Starting…' : checkoutLabel}
                </button>
                <button onClick={() => { setCart([]); writeCart([]); }} style={{ padding: '12px 14px', borderRadius: 999, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: drawerTextMuted, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Clear</button>
              </div>
              {cartMsg && <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 12 }}>{cartMsg}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}