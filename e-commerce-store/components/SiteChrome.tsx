'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { useLiveTheme } from '@/components/ThemeProvider';
import { ensureMapboxAutofill, getAutofillAddressValue, getMapboxStatus } from '@/lib/mapbox-autofill';
import { validateShippingAddress } from '@/lib/address-validation';
import { neutralBrandName } from '@/lib/env';
import { themeRadius } from '@/lib/storefront-config';

type CartItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
  productType?: string;
  checkoutMode?: 'RAFFLE' | 'FCFS';
};

/**
 * Address quality gate for checkout. The validator requires a COMPLETE
 * shippable address (street # + name, city, state, ZIP, country) — see
 * lib/address-validation.ts. Its short message guides the customer to the
 * address dropdown, which always fills a full, shippable address.
 */
function addressValidationError(address: string): string | null {
  return validateShippingAddress(address);
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

/**
 * Small inline spinner for buttons mid-request (paired with the global
 * press-down animation so a tap is NEVER visually unanswered).
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

/**
 * Pick a readable foreground color for the top bar given its background.
 * Text/border/icon colors on the header used to be hardcoded white, which made
 * light presets (white header) unreadable. This computes relative luminance and
 * returns near-black text on light backgrounds and near-white on dark ones.
 */
function readableTextOn(bg: string): string {
  const hex = normalizeHex(bg, '');
  if (!hex) return '#f5f5f7';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return '#f5f5f7';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.58 ? '#0a0a0c' : '#f5f5f7';
}

/**
 * Mix a chrome/surface color to the configured transparency (0-100) via
 * color-mix. Chrome surfaces stay readable (min 40%); the drawer keeps ~92% so
 * the modal doesn't turn into a full-blown glass panel.
 */
function chromeBackground(color: string, alphaPct: number, fallback: string, minPct = 40): string {
  const c = String(color || '').trim();
  if (!c) return fallback;
  const raw = Number(alphaPct);
  const safe = clamp(Number.isFinite(raw) ? raw : 94, minPct, 100);
  return safe >= 100 ? c : `color-mix(in srgb, ${c} ${safe}%, transparent)`;
}

/** Radial-gradient paint for a glow orb at the given opacity. */
function orbGradient(color: string, opacity: number, fallback: string, edgeRatio = 0.38) {
  const hex = normalizeHex(color, fallback);
  return `radial-gradient(circle, ${hex}${alphaHex(opacity)} 0%, ${hex}${alphaHex(opacity * edgeRatio)} 42%, transparent 72%)`;
}

/**
 * Resolve an orb's configured opacity for the cart-drawer glow. Respects an
 * explicit 0 (no glow) and never boosts the value. The drawer used to hardcode
 * +6/+10/+12 opacity boosts on 84-86% drawer-sized orb divs with negative
 * offsets — the result was huge clipped colour blobs with hard edges where the
 * drawer's `overflow: hidden` boundary cut through the still-strong part of the
 * gradients. The drawer now uses the exact admin-configured opacities.
 */
function orbGlowOpacity(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
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

/**
 * Remove cart lines whose product no longer exists in Redis (e.g. after the
 * operator wipes/rebuilds the store) or whose size was removed. The bag must
 * never show items that don't exist anywhere on the backend.
 */
function pruneStaleCart(items: CartItem[], products: any[]): CartItem[] {
  if (!Array.isArray(items)) return [];
  const byId = new Map(products.map((p) => [String(p?.id || ''), p]));
  return items.filter((item) => {
    const product = byId.get(String(item?.productId || ''));
    if (!product) return false;
    const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
    return cats.some((c: any) => String(c?.size) === String(item?.size));
  });
}

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  // Live /admin → Settings theme is baked into SSR via the root layout's
  // ThemeProvider, so the top bar and chrome render with the saved colors on
  // the first paint (no flash), then the /api/store fetch keeps them fresh.
  const liveCtx = useLiveTheme();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutEmail, setCheckoutEmail] = useState('');
  const [checkoutAddress, setCheckoutAddress] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [cartMsg, setCartMsg] = useState('');
  const [theme, setTheme] = useState<any>(liveCtx?.themeColors || null);
  const [branding, setBranding] = useState<any>(liveCtx?.branding || null);
  const [orbs, setOrbs] = useState<any>(liveCtx?.orbs || null);
  // Footer links/copyright — all editable from /admin → Settings → Footer and
  // served through /api/store → config.brandFooterData. The footer NEVER
  // hardcodes social URLs or a brand name.
  const [footerSettings, setFooterSettings] = useState<Record<string, string> | null>(liveCtx?.footer || null);
  // Storefront copy overrides — admin → Settings → Storefront copy. A non-empty
  // value overrides the built-in labels (cart title, footer tagline/support email).
  const [copySettings, setCopySettings] = useState<Record<string, any>>(liveCtx?.copy || {});
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
        // Re-validate against the LIVE promo table so a code that no longer
        // exists (e.g. after a Redis wipe/rebuild) never shows as applied.
        fetch(`/api/promo/validate?code=${encodeURIComponent(storedPromo)}&quiet=1`)
          .then((res) => res.json())
          .then((data) => {
            if (data?.valid === true) {
              setPromoCode(storedPromo);
            } else {
              try { window.localStorage.removeItem('goyunir-promo-code'); } catch { /* noop */ }
              setPromoCode('');
            }
          })
          .catch(() => setPromoCode(''));
      }
    }

    fetchStoreJson('/api/store')
      .then((data) => {
        setTheme(data?.config?.themeColors || null);
        setBranding(data?.config?.branding || null);
        setOrbs(data?.config?.orbs || null);
        if (data?.config?.brandFooterData) setFooterSettings(data.config.brandFooterData);
        if (data?.config?.copy) setCopySettings((prev) => ({ ...prev, ...data.config.copy }));
        // Prune cart lines whose product/size no longer exists on the backend
        // (wipe/rebuild or archive) so the bag never shows ghost items.
        const products = Array.isArray(data?.activeProducts) ? data.activeProducts : [];
        const current = readCart();
        const pruned = pruneStaleCart(current, products);
        if (pruned.length !== current.length) {
          setCart(pruned);
          writeCart(pruned);
        }
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
  // --ui-radius/--ui-chrome-alpha/--ui-surface-alpha) instantly in sync with
  // whatever is saved in /admin → Settings.
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    const radius = Number(theme.borderRadius) >= 0 ? `${Number(theme.borderRadius)}px` : '12px';
    root.style.setProperty('--ui-radius', radius);
    root.style.setProperty('--background', theme.primaryBackground || '#0a0a0a');
    root.style.setProperty('--foreground', theme.textMain || '#ffffff');
    root.style.setProperty('--ui-chrome-alpha', String(clamp(Number(theme.chromeTransparency ?? 94), 0, 100)));
    root.style.setProperty('--ui-surface-alpha', String(clamp(Number(theme.surfaceTransparency ?? 100), 0, 100)));
    document.body.style.background = theme.primaryBackground || '#0a0a0a';
    document.body.style.color = theme.textMain || '#ffffff';
    if (theme.fontFamily) document.body.style.fontFamily = theme.fontFamily;
  }, [theme]);

  useEffect(() => {
    writeCheckoutDetails(checkoutEmail, checkoutAddress);
  }, [checkoutEmail, checkoutAddress]);

  // Detect the signed-in session so the header can show the green account
  // indicator and the cart drawer can lock the email to the session address.
  // Fails silently — signed-out visitors just see the normal account icon.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.user?.email) {
          setSignedIn(true);
          setSignedInEmail(String(data.user.email));
        } else {
          setSignedIn(false);
          setSignedInEmail('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSignedIn(false);
          setSignedInEmail('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Signed-in customers always check out with their session email. Prefill it
  // only when the field is empty so a draft the customer typed keeps winning.
  useEffect(() => {
    if (signedIn && signedInEmail && !checkoutEmail) {
      setCheckoutEmail(signedInEmail);
    }
  }, [signedIn, signedInEmail, checkoutEmail]);

  const total = cart.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const hasItems = cart.length > 0;
  const hasRaffleItems = cart.some((item) => (item.checkoutMode || '').toUpperCase() === 'RAFFLE' || String(item.productType || '').toLowerCase() === 'raffle');
  const hasFcfsItems = cart.some((item) => (item.checkoutMode || '').toUpperCase() === 'FCFS' || String(item.productType || '').toLowerCase() === 'fcfs');
  const checkoutLabel = hasRaffleItems ? (hasFcfsItems ? 'Secure entries & pay' : 'Secure entries') : 'Checkout now';

  const checkoutCart = async () => {
    if (!hasItems) return;
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
        // Remember that this checkout came from the whole bag: the confirm-setup
        // success handler on the product page uses this to clear the ENTIRE cart
        // (and mark every secured raffle line as entered) instead of only
        // pruning the single product-page line.
        try { window.sessionStorage.setItem('goyunir-cart-checkout', 'true'); } catch {}
        // Mixed carts (raffle entries + direct items) create two sessions: first
        // the raffle card-setup (secures the entries), then the FCFS payment.
        // Remember the follow-up payment URL so the confirm-setup flow can pick
        // it up when the customer returns from Stripe.
        if (data.paymentUrl) {
          try {
            window.sessionStorage.setItem('goyunir-pending-payment-url', data.paymentUrl);
          } catch {}
        }
        window.location.assign(data.url);
        return;
      }
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

  // Full palette for the chrome/cart drawer — starts at the build-time config and
  // upgrades to whatever /admin → Settings has saved (theme state is set from
  // /api/store → config → themeColors). Keeps drawer/card text editable.
  const liveTheme = { ...GOYUNIR_STORE_SUITE.themeColors, ...(theme || {}) } as Record<string, any>;
  const chromeAlpha = clamp(Number(liveTheme.chromeTransparency ?? 94), 0, 100);
  const headerBg = chromeBackground(liveTheme.cardBackground, chromeAlpha, 'rgba(8,8,10,0.94)');
  const drawerBg = chromeBackground(liveTheme.cardBackground, Math.max(chromeAlpha, 92), '#0b0b0f', 92);
  const drawerText = liveTheme.cardTextMain || '#ffffff';
  const drawerTextMuted = liveTheme.cardTextMuted || '#a1a1aa';
  // Readable foreground for the top bar: hardcoded white text is invisible on
  // light presets (e.g. white header), so derive it from the header background.
  const headerText = readableTextOn(liveTheme.cardBackground);
  const headerMode = String(branding?.headerMode || 'both').toLowerCase();
  const showBrandText = headerMode !== 'logo';
  const showBrandLogo = headerMode !== 'text';
  const headerActionMode = String(branding?.headerActionMode || 'cart').toLowerCase();
  const actionTitle = headerActionMode === 'bag' ? 'Bag' : 'Cart';
  // Top-bar brand: admin → Settings → Branding wins; the env fallback (BRAND_NAME /
  // NEXT_PUBLIC_SITE_NAME) is used when Redis is empty; never a hardcoded brand.
  const brandName = String(branding?.brandName || branding?.shareTitle || neutralBrandName());
  const brandFont = String(branding?.brandFontFamily || '').trim() || undefined;
  // Admin-configurable logo size. When the top bar shows ONLY the logo we use a
  // larger default so it reads like a proper wordmark instead of a favicon.
  const logoWidth = Number(branding?.logoWidth) > 0 ? Number(branding.logoWidth) : headerMode === 'logo' ? 44 : 28;
  const logoHeight = Number(branding?.logoHeight) > 0 ? Number(branding.logoHeight) : headerMode === 'logo' ? 44 : 28;
  const logoTransparent =
    branding?.logoTransparent === true || String(branding?.logoTransparent || '').toLowerCase() === 'true';

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
          <Link
            href="/catalog"
            prefetch={false}
            aria-label="Catalog & search"
            title="Catalog & search"
            style={{ height: 42, padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 999, background: 'rgba(255,255,255,0.07)', border: `1px solid ${headerText === '#0a0a0c' ? 'rgba(10,10,12,0.18)' : 'rgba(255,255,255,0.12)'}`, color: headerText, textDecoration: 'none', boxShadow: '0 10px 24px rgba(0,0,0,0.16)', fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            MORE
          </Link>
        </div>

        <Link
          href="/"
          prefetch={false}
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            fontWeight: 800,
            letterSpacing: '3.5px',
            fontSize: '11px',
            textTransform: 'uppercase',
            color: headerText,
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
            <img src={branding.logoUrl} alt={brandName} style={{ width: logoWidth, height: logoHeight, borderRadius: logoTransparent ? 0 : 6, objectFit: logoTransparent ? 'contain' : 'cover', display: 'block' }} />
          ) : null)}
          {showBrandText ? <span style={{ fontFamily: brandFont, fontSize: Number(branding?.brandFontSize) > 0 ? `${Number(branding.brandFontSize)}px` : '11px' }}>{brandName}</span> : null}
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flex: 1 }}>
          <Link
            href="/account"
            prefetch={false}
            aria-label={signedIn ? 'Your account (signed in)' : 'Account'}
            title={signedIn ? 'Your account (signed in)' : 'Account'}
            style={{
              width: 42,
              height: 42,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.07)',
              border: signedIn ? '1px solid rgba(34,197,94,0.35)' : (headerText === '#0a0a0c' ? '1px solid rgba(10,10,12,0.18)' : '1px solid rgba(255,255,255,0.12)'),
              color: headerText,
              textDecoration: 'none',
              boxShadow: '0 10px 24px rgba(0,0,0,0.16)',
              position: 'relative',
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
            {signedIn ? <span style={{ position: 'absolute', right: 2, bottom: 2, width: 10, height: 10, borderRadius: 999, background: '#22c55e', boxShadow: '0 0 0 2px rgba(8,8,10,0.9)' }} /> : null}
          </Link>
          <button
            onClick={() => setCartOpen(true)}
            aria-label={actionTitle}
            title={actionTitle}
            style={{ width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, border: headerText === '#0a0a0c' ? '1px solid rgba(10,10,12,0.18)' : '1px solid rgba(255,255,255,0.12)', background: hasItems ? '#f3f4f6' : 'rgba(255,255,255,0.07)', color: hasItems ? '#09090b' : headerText, cursor: 'pointer', boxShadow: '0 10px 24px rgba(0,0,0,0.16)', position: 'relative' }}
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

      <footer style={{ background: chromeBackground(liveTheme.primaryBackground, chromeAlpha, 'rgba(8,8,10,0.96)'), borderTop: '1px solid rgba(255,255,255,0.08)', padding: '38px 20px 58px', textAlign: 'center', color: liveTheme.textMuted || '#71717a', fontSize: 12, position: 'relative', zIndex: 10 }}>
        <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Link href="/terms" prefetch={false} style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Terms</Link>
            <Link href="/privacy" prefetch={false} style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Privacy</Link>
            <Link href="/shipping" prefetch={false} style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Shipping</Link>
            <Link href="/account" prefetch={false} style={{ color: liveTheme.textMuted || '#71717a', textDecoration: 'none' }}>Manage My Entry</Link>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
            {(() => {
              const ig = String(footerSettings?.instagramLink || '').trim();
              const tt = String(footerSettings?.tiktokLink || '').trim();
              const mail = String(copySettings.supportEmail || footerSettings?.supportEmail || '').trim();
              const linkStyle = { color: liveTheme.textMuted || '#71717a', textDecoration: 'none' } as const;
              return (
                <>
                  {ig ? <a href={ig} target="_blank" rel="noreferrer" style={linkStyle}>Instagram</a> : null}
                  {tt ? <a href={tt} target="_blank" rel="noreferrer" style={linkStyle}>TikTok</a> : null}
                  {mail ? <a href={`mailto:${mail}`} style={linkStyle}>{mail}</a> : null}
                </>
              );
            })()}
          </div>
          {String(copySettings.footerTagline || '').trim() ? (
            <div style={{ fontSize: 11, lineHeight: 1.6, color: liveTheme.textMuted || '#71717a', maxWidth: 420, margin: '0 auto' }}>{String(copySettings.footerTagline).trim()}</div>
          ) : null}
          <div style={{ color: liveTheme.textMuted || '#71717a', fontSize: 10 }}>
            © {new Date().getFullYear()} {String(footerSettings?.corporateEntityCopyright || branding?.brandName || branding?.shareTitle || 'ALL RIGHTS RESERVED.')}
          </div>
        </div>
      </footer>

      {cartOpen && (
        <div onClick={() => setCartOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(event) => event.stopPropagation()} style={{ width: 'min(92vw, 360px)', height: '100%', position: 'relative', overflow: 'hidden', background: drawerBg, borderLeft: '1px solid rgba(255,255,255,0.08)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', color: drawerText }}>
            {/* Orb glows inside the cart drawer — mirrors the storefront glow so
                the animated background orbs stay visible while the drawer is open
                (the drawer paints above the page-level orb layer). */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
              {orbsEnabled && primaryOrb.enabled !== false && (
                <div style={{ position: 'absolute', top: '6%', right: '4%', width: '56%', height: '56%', borderRadius: '999px', background: orbGradient(primaryOrb.color, orbGlowOpacity(primaryOrb.opacity, 16), '#3b82f6') }} />
              )}
              {orbsEnabled && secondaryOrb.enabled !== false && (
                <div style={{ position: 'absolute', left: '4%', bottom: '6%', width: '54%', height: '54%', borderRadius: '999px', background: orbGradient(secondaryOrb.color, orbGlowOpacity(secondaryOrb.opacity, 26), '#a855f7') }} />
              )}
              {orbsEnabled && tertiaryOrb.enabled !== false && (
                <div style={{ position: 'absolute', right: '14%', bottom: '26%', width: '34%', height: '34%', borderRadius: '999px', background: orbGradient(tertiaryOrb.color, orbGlowOpacity(tertiaryOrb.opacity, 12), '#ffd79b') }} />
              )}
            </div>
            <div style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '18px 16px', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: liveTheme.accentBlue || '#7dd3fc' }}>{actionTitle}</div>
                <div style={{ fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', color: drawerText }}>{String(copySettings.cartTitle || '').trim() || 'Review items'}</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: drawerTextMuted, borderRadius: 999, padding: '8px 10px', cursor: 'pointer' }}>Close</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cart.length === 0 ? (
                <div style={{ border: '1px dashed rgba(255,255,255,0.12)', borderRadius: themeRadius(liveTheme, 20), padding: 18, color: drawerTextMuted, fontSize: 13, lineHeight: 1.6 }}>
                  Your {actionTitle.toLowerCase()} is empty. Add direct-purchase items from a product page to review them here.
                </div>
              ) : (
                cart.map((item, index) => (
                  <div key={`${item.productId}-${item.size}-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: themeRadius(liveTheme, 18), padding: 12, background: 'rgba(255,255,255,0.04)' }}>
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
                    readOnly={signedIn}
                    disabled={signedIn}
                    placeholder="email@domain.com"
                    style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: signedIn ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.3)', color: signedIn ? drawerTextMuted : drawerText, fontSize: 12, cursor: signedIn ? 'not-allowed' : 'text' }}
                  />
                  {signedIn && signedInEmail ? (
                    <div style={{ fontSize: 10, color: drawerTextMuted, lineHeight: 1.4 }}>Signed in as {signedInEmail} — email can&apos;t be changed here.</div>
                  ) : null}
                  <input autoComplete="shipping street-address" type="text" value={checkoutAddress} onChange={(e) => setCheckoutAddress(e.target.value)} placeholder="Full shipping address (street, city, state, ZIP, country)" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.3)', color: drawerText, fontSize: 12 }} />
                  {(mapboxHint === 'autofill-on' || mapboxHint === 'autofill-off' || mapboxHint === 'no-token' || mapboxHint === 'token-rejected') && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: mapboxHint === 'autofill-on' ? '#34d399' : mapboxHint === 'autofill-off' ? '#fbbf24' : '#f87171' }}>
                      <span style={{ width: 6, height: 6, borderRadius: 999, background: mapboxHint === 'autofill-on' ? '#22c55e' : mapboxHint === 'autofill-off' ? '#f59e0b' : '#ef4444' }} />
                      {mapboxHint === 'autofill-on'
                        ? 'Use address dropdown'
                        : mapboxHint === 'autofill-off'
                          ? 'Address autofill off — enter manually'
                          : mapboxHint === 'no-token'
                            ? 'Address autofill off — enter manually'
                            : 'Address autofill error — enter manually'}
                    </div>
                  )}
                  {showPromoField ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={promoCode}
                        onChange={(e) => {
                          const next = e.target.value.toUpperCase().trim();
                          setPromoCode(next);
                          window.localStorage.setItem('goyunir-promo-code', next);
                        }}
                        placeholder="Promo code (optional)"
                        style={{ flex: 1, minWidth: 150, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.3)', color: drawerText, fontSize: 12 }}
                      />
                      <button onClick={() => setShowPromoField(false)} style={{ border: 'none', background: 'transparent', color: drawerTextMuted, fontSize: 12, cursor: 'pointer' }}>Close</button>
                    </div>
                  ) : promoCode ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#86efac' }}>✓ {promoCode} applied</span>
                      <button onClick={() => setShowPromoField(true)} style={{ border: 'none', background: 'transparent', color: drawerTextMuted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>Change</button>
                      <button
                        onClick={() => {
                          setPromoCode('');
                          window.localStorage.removeItem('goyunir-promo-code');
                        }}
                        style={{ border: 'none', background: 'transparent', color: '#fca5a5', fontSize: 12, cursor: 'pointer' }}
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setShowPromoField(true)} style={{ alignSelf: 'flex-start', padding: '4px 0', border: 'none', background: 'transparent', color: drawerTextMuted, fontSize: 12, cursor: 'pointer' }}>Add promo or promoter credit</button>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: encryptionHealthy ? '#34d399' : '#f87171' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: encryptionHealthy ? '#22c55e' : '#ef4444', boxShadow: `0 0 0 2px ${encryptionHealthy ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
                    {encryptionHealthy ? 'Encrypted checkout' : 'Encryption check failed'}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>These details stay remembered across product and cart checkout so collectors do not need to repeat themselves.</div>
                </form>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={checkoutCart} disabled={checkoutBusy || !hasItems} style={{ flex: 1, textAlign: 'center', padding: '12px 14px', borderRadius: 999, background: liveTheme.textMain || '#f3f4f6', color: liveTheme.primaryBackground || '#09090b', border: 'none', textDecoration: 'none', fontWeight: 700, fontSize: 13, cursor: checkoutBusy || !hasItems ? 'not-allowed' : 'pointer', opacity: checkoutBusy || !hasItems ? 0.6 : 1 }}>
                  {checkoutBusy ? (<><ButtonSpinner light={false} /> Starting…</>) : checkoutLabel}
                </button>
                <button onClick={() => { setCart([]); writeCart([]); }} style={{ padding: '12px 14px', borderRadius: 999, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: drawerTextMuted, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Clear</button>
              </div>
              {cartMsg && <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 12 }}>{cartMsg}</div>}
            </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}