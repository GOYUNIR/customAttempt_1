'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fetchStoreJson } from '@/lib/client-store-cache';

type CartItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
  productType?: string;
  checkoutMode?: 'RAFFLE' | 'FCFS';
};

const CART_KEY = 'goyunir-cart';
const CHECKOUT_DETAILS_KEY = 'goyunir-checkout-details';

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
  const [promoCode, setPromoCode] = useState('');
  const [bannerMessage, setBannerMessage] = useState('');
  const [encryptionHealthy, setEncryptionHealthy] = useState(true);
  const [showPromoField, setShowPromoField] = useState(false);
  const [notice, setNotice] = useState<{ id?: string; type: string; message: string } | null>(null);
  const [showScrollCue, setShowScrollCue] = useState(true);
  const targetXRef = useRef(0.5);
  const targetYRef = useRef(0.35);
  const velocityXRef = useRef(0);
  const velocityYRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const lastScrollAtRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  // Background glow is animated via direct DOM writes (refs) so the ~60fps
  // idle/pointer drift never triggers a React re-render of the whole app.
  const easedXRef = useRef(0.5);
  const easedYRef = useRef(0.35);
  const orbPrimaryRef = useRef<HTMLDivElement | null>(null);
  const orbSecondaryRef = useRef<HTMLDivElement | null>(null);
  const orbTertiaryRef = useRef<HTMLDivElement | null>(null);

  const showNotice = (next: { id?: string; type: string; message: string; persist?: boolean }) => {
    setNotice({ id: next.id, type: next.type, message: next.message });
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    if (!next.persist && next.type !== 'loading') {
      noticeTimerRef.current = window.setTimeout(() => setNotice((current) => (current?.id === next.id || !next.id ? null : current)), 2400);
    }
  };

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
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    let lastInteraction = Date.now();
    const onPointer = (event: PointerEvent) => {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      targetXRef.current = clamp(event.clientX / width, 0.04, 0.96);
      targetYRef.current = clamp(event.clientY / height, 0.06, 0.94);
      lastInteraction = Date.now();
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      targetXRef.current = clamp(touch.clientX / width, 0.04, 0.96);
      targetYRef.current = clamp(touch.clientY / height, 0.06, 0.94);
      lastInteraction = Date.now();
    };

    // Pushes the eased glow position straight onto the DOM (no React state),
    // which keeps the animation at 60fps without re-rendering the app. The
    // CSS variables live on <html> so both the background glow and the header
    // accent glow can read them.
    const applyGlow = (x: number, y: number) => {
      const primary = orbPrimaryRef.current;
      const secondary = orbSecondaryRef.current;
      const tertiary = orbTertiaryRef.current;
      if (!primary || !secondary || !tertiary) return;
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      document.documentElement.style.setProperty('--glow-x', `${15 + x * 70}%`);
      document.documentElement.style.setProperty('--glow-y', `${8 + y * 55}%`);
      primary.style.transform = `translate3d(${((-16 + x * 68) / 100) * vw}px, ${((-8 + y * 72) / 100) * vh}px, 0)`;
      secondary.style.transform = `translate3d(${((56 - x * 32) / 100) * vw}px, ${((48 - y * 26) / 100) * vh}px, 0)`;
      tertiary.style.transform = `translate3d(${((18 + x * 24) / 100) * vw}px, ${((62 - y * 18) / 100) * vh}px, 0)`;
    };

    let rafId = 0;
    let idleTargetX = 0.52;
    let idleTargetY = 0.42;
    let nextIdleRetargetAt = Date.now() + 2300;
    let running = true;
    const animateIdle = () => {
      if (!running) return;
      const now = Date.now();
      const idleFor = now - lastInteraction;
      const scrollMomentumAge = now - lastScrollAtRef.current;
      if (scrollMomentumAge < 2600) {
        targetXRef.current = clamp(targetXRef.current + velocityXRef.current, 0.05, 0.95);
        targetYRef.current = clamp(targetYRef.current + velocityYRef.current, 0.08, 0.92);
        velocityXRef.current *= 0.98;
        velocityYRef.current *= 0.98;
      }
      if (idleFor > 950) {
        if (now >= nextIdleRetargetAt) {
          idleTargetX = 0.18 + Math.random() * 0.64;
          idleTargetY = 0.14 + Math.random() * 0.68;
          nextIdleRetargetAt = now + 1600 + Math.random() * 2600;
        }
        const t = now / 1000;
        const microDriftX = Math.sin(t * 1.1) * 0.014 + Math.sin(t * 2.1) * 0.005;
        const microDriftY = Math.cos(t * 1.05) * 0.013 + Math.cos(t * 1.8) * 0.005;
        targetXRef.current = clamp(targetXRef.current + (idleTargetX - targetXRef.current) * 0.02 + microDriftX, 0.05, 0.95);
        targetYRef.current = clamp(targetYRef.current + (idleTargetY - targetYRef.current) * 0.02 + microDriftY, 0.08, 0.92);
      }
      const easedX = clamp(easedXRef.current + (targetXRef.current - easedXRef.current) * 0.06, 0.05, 0.95);
      const easedY = clamp(easedYRef.current + (targetYRef.current - easedYRef.current) * 0.06, 0.08, 0.92);
      easedXRef.current = easedX;
      easedYRef.current = easedY;
      applyGlow(easedX, easedY);
      rafId = window.requestAnimationFrame(animateIdle);
    };

    const onScrollMotion = () => {
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
    window.addEventListener('touchmove', onTouchMove, { passive: true });
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
      window.removeEventListener('touchmove', onTouchMove);
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(cueTimer);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

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
    if (!checkoutEmail || !checkoutAddress) {
      setCartMsg('Enter your email and shipping address to continue.');
      showNotice({ type: 'alert', message: 'Add your email and shipping address first.' });
      return;
    }
    setCheckoutBusy(true);
    setCartMsg('');
    showNotice({ id: 'cart-checkout', type: 'loading', message: 'Preparing secure checkout...', persist: true });
    try {
      const payload = {
        email: checkoutEmail.trim().toLowerCase(),
        address: checkoutAddress.trim(),
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

  const headerAccent = theme?.accentBlue || '#7dd3fc';
  const headerBg = theme?.cardBackground || 'rgba(8,8,10,0.82)';
  const headerMode = String(branding?.headerMode || 'both').toLowerCase();
  const showBrandText = headerMode !== 'logo';
  const showBrandLogo = headerMode !== 'text';
  const headerActionMode = String(branding?.headerActionMode || 'cart').toLowerCase();
  const actionTitle = headerActionMode === 'bag' ? 'Bag' : 'Cart';
  const actionVerb = headerActionMode === 'bag' ? 'bag' : 'cart';

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
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at var(--glow-x, 50%) var(--glow-y, 35%), rgba(255,255,255,0.022), transparent 16%)' }} />
        <div ref={orbPrimaryRef} style={{ position: 'absolute', left: 0, top: 0, width: '58vw', height: '58vw', minWidth: 280, minHeight: 280, maxWidth: 620, maxHeight: 620, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: `${headerAccent}22`, filter: 'blur(48px)', willChange: 'transform', opacity: 0.95 }} />
        <div ref={orbSecondaryRef} style={{ position: 'absolute', left: 0, top: 0, width: '44vw', height: '44vw', minWidth: 220, minHeight: 220, maxWidth: 480, maxHeight: 480, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: 'rgba(168,85,247,0.18)', filter: 'blur(54px)', willChange: 'transform', opacity: 0.92 }} />
        <div ref={orbTertiaryRef} style={{ position: 'absolute', left: 0, top: 0, width: '28vw', height: '28vw', minWidth: 140, minHeight: 140, maxWidth: 280, maxHeight: 280, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: 'rgba(255,244,214,0.09)', filter: 'blur(34px)', willChange: 'transform', opacity: 0.9 }} />
      </div>
      {bannerMessage && (
        <div style={{ position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 150, padding: '8px 12px', borderRadius: 999, background: 'rgba(10,10,12,0.92)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontSize: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
          {bannerMessage}{promoCode ? ` · ${promoCode}` : ''}
        </div>
      )}
      {notice && (
        <div style={{ position: 'fixed', top: 66, left: '50%', transform: 'translateX(-50%)', zIndex: 170, pointerEvents: 'none' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '9px 13px', borderRadius: 999, background: 'rgba(10,10,12,0.94)', color: '#fff', border: `1px solid ${notice.type === 'error' ? 'rgba(248,113,113,0.28)' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? 'rgba(52,211,153,0.24)' : notice.type === 'loading' ? 'rgba(125,211,252,0.24)' : 'rgba(255,255,255,0.1)'}`, fontSize: 12, boxShadow: '0 16px 40px rgba(0,0,0,0.34)', backdropFilter: 'blur(16px)' }}>
            <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
              {notice.type === 'loading' ? (
                <>
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 0.45, animation: 'goyunirPulse 0.9s ease-in-out infinite' }} />
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 0.75, animation: 'goyunirPulse 0.9s ease-in-out 0.15s infinite' }} />
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: '#7dd3fc', opacity: 1, animation: 'goyunirPulse 0.9s ease-in-out 0.3s infinite' }} />
                </>
              ) : (
                <span style={{ width: 7, height: 7, borderRadius: 999, background: notice.type === 'error' ? '#f87171' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? '#34d399' : notice.type === 'alert' ? '#facc15' : '#d4d4d8', boxShadow: `0 0 0 2px ${notice.type === 'error' ? 'rgba(248,113,113,0.16)' : notice.type === 'success' || notice.type === 'won' || notice.type === 'entered' ? 'rgba(52,211,153,0.16)' : notice.type === 'alert' ? 'rgba(250,204,21,0.14)' : 'rgba(255,255,255,0.08)'}` }} />
              )}
            </span>
            <span>{notice.message}</span>
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
          backdropFilter: 'blur(18px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 12px 14px',
          zIndex: 100,
          boxSizing: 'border-box',
          transform: 'translateY(0)',
          transition: 'transform 160ms ease, backdrop-filter 220ms ease',
          backgroundImage: `radial-gradient(circle at var(--glow-x, 50%) -20%, ${headerAccent}33, transparent 35%)`,
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

      <footer style={{ background: 'rgba(8,8,10,0.96)', backdropFilter: 'blur(18px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '38px 20px 58px', textAlign: 'center', color: '#71717a', fontSize: 12, position: 'relative', zIndex: 10 }}>
        <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Link href="/terms" style={{ color: '#71717a', textDecoration: 'none' }}>Terms</Link>
            <Link href="/privacy" style={{ color: '#71717a', textDecoration: 'none' }}>Privacy</Link>
            <Link href="/shipping" style={{ color: '#71717a', textDecoration: 'none' }}>Shipping</Link>
            <Link href="/account" style={{ color: '#71717a', textDecoration: 'none' }}>Manage My Entry</Link>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
            <a href="https://instagram.com/goyunir" target="_blank" rel="noreferrer" style={{ color: '#52525b', textDecoration: 'none' }}>Instagram</a>
            <a href="https://tiktok.com/goyunir" target="_blank" rel="noreferrer" style={{ color: '#52525b', textDecoration: 'none' }}>TikTok</a>
            <a href="mailto:goyunir.support@gmail.com" style={{ color: '#52525b', textDecoration: 'none' }}>goyunir.support@gmail.com</a>
          </div>
          <div style={{ color: '#3f3f46', fontSize: 10 }}>
            © {new Date().getFullYear()} GOYUNIR ALL RIGHTS RESERVED.
          </div>
        </div>
      </footer>

      {cartOpen && (
        <div onClick={() => setCartOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(event) => event.stopPropagation()} style={{ width: 'min(92vw, 360px)', height: '100%', background: '#0b0b0f', borderLeft: '1px solid rgba(255,255,255,0.08)', padding: '18px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: '#7dd3fc' }}>{actionTitle}</div>
                <div style={{ fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', color: '#fff' }}>Review items</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#d4d4d8', borderRadius: 999, padding: '8px 10px', cursor: 'pointer' }}>Close</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cart.length === 0 ? (
                <div style={{ border: '1px dashed rgba(255,255,255,0.12)', borderRadius: 20, padding: 18, color: '#a1a1aa', fontSize: 13, lineHeight: 1.6 }}>
                  Your {actionTitle.toLowerCase()} is empty. Add direct-purchase items from a product page to review them here.
                </div>
              ) : (
                cart.map((item, index) => (
                  <div key={`${item.productId}-${item.size}-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, padding: 12, background: '#111116' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{item.name}</div>
                        <div style={{ fontSize: 11, color: '#a1a1aa', marginTop: 3 }}>{item.size}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>${Number(item.price || 0).toFixed(2)}</div>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#d4d4d8', marginBottom: 12 }}>
                <span>Total</span>
                <strong>${total.toFixed(2)}</strong>
              </div>
              {hasItems && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                  <input autoComplete="shipping street-address" type="text" value={checkoutAddress} onChange={(e) => setCheckoutAddress(e.target.value)} placeholder="Shipping address" style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#09090b', color: '#fff', fontSize: 12 }} />
                  <input
                    type="email"
                    value={checkoutEmail}
                    onChange={(e) => setCheckoutEmail(e.target.value)}
                    placeholder="Email"
                    style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#09090b', color: '#fff', fontSize: 12 }}
                  />
                  {!showPromoField ? (
                    <button onClick={() => setShowPromoField(true)} style={{ alignSelf: 'flex-start', padding: '4px 0', border: 'none', background: 'transparent', color: '#c8c8cf', fontSize: 12, cursor: 'pointer' }}>Add promo or promoter credit</button>
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
                      style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#09090b', color: '#fff', fontSize: 12 }}
                    />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: encryptionHealthy ? '#34d399' : '#f87171' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: encryptionHealthy ? '#22c55e' : '#ef4444', boxShadow: `0 0 0 2px ${encryptionHealthy ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'}` }} />
                    {encryptionHealthy ? 'Encrypted checkout' : 'Encryption check failed'}
                  </div>
                  <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>These details stay remembered across product and cart checkout so collectors do not need to repeat themselves.</div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={checkoutCart} disabled={checkoutBusy || !hasItems || raffleOnlyCart} style={{ flex: 1, textAlign: 'center', padding: '12px 14px', borderRadius: 999, background: '#f3f4f6', color: '#09090b', border: 'none', textDecoration: 'none', fontWeight: 700, fontSize: 13, cursor: checkoutBusy || !hasItems || raffleOnlyCart ? 'not-allowed' : 'pointer' }}>
                  {checkoutBusy ? 'Starting…' : checkoutLabel}
                </button>
                <button onClick={() => { setCart([]); writeCart([]); }} style={{ padding: '12px 14px', borderRadius: 999, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#d4d4d8', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Clear</button>
              </div>
              {cartMsg && <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 12 }}>{cartMsg}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}