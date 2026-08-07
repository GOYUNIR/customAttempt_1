'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

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
  const [scrollY, setScrollY] = useState(0);
  const [pointerX, setPointerX] = useState(0.5);
  const [pointerY, setPointerY] = useState(0.35);
  const [theme, setTheme] = useState<any>(null);
  const [branding, setBranding] = useState<any>(null);
  const [promoCode, setPromoCode] = useState('');
  const [bannerMessage, setBannerMessage] = useState('');
  const [encryptionHealthy, setEncryptionHealthy] = useState(true);
  const [showPromoField, setShowPromoField] = useState(false);
  const targetXRef = useRef(0.5);
  const targetYRef = useRef(0.35);
  const velocityXRef = useRef(0);
  const velocityYRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const lastScrollAtRef = useRef(0);

  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    const draft = readCheckoutDetails();
    if (draft.email) setCheckoutEmail(draft.email);
    if (draft.address) setCheckoutAddress(draft.address);
    const open = () => setCartOpen(true);
    const onScroll = () => setScrollY(window.scrollY || 0);
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
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

    let rafId = 0;
    let lastInteraction = Date.now();
    let idleTargetX = 0.52;
    let idleTargetY = 0.42;
    let nextIdleRetargetAt = Date.now() + 2300;
    const animateIdle = () => {
      const now = Date.now();
      const idleFor = now - lastInteraction;
      const scrollMomentumAge = now - lastScrollAtRef.current;
      if (scrollMomentumAge < 2200) {
        targetXRef.current = clamp(targetXRef.current + velocityXRef.current, 0.05, 0.95);
        targetYRef.current = clamp(targetYRef.current + velocityYRef.current, 0.08, 0.92);
        velocityXRef.current *= 0.962;
        velocityYRef.current *= 0.962;
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
      setPointerX((prev) => clamp(prev + (targetXRef.current - prev) * 0.095, 0.05, 0.95));
      setPointerY((prev) => clamp(prev + (targetYRef.current - prev) * 0.095, 0.08, 0.92));
      rafId = window.requestAnimationFrame(animateIdle);
    };

    const onScrollMotion = () => {
      const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
      const progress = (window.scrollY || 0) / maxScroll;
      const now = Date.now();
      const deltaY = window.scrollY - lastScrollYRef.current;
      const deltaT = Math.max(16, now - lastScrollAtRef.current || 16);
      const scrollVelocity = deltaY / deltaT;
      velocityYRef.current = clamp(velocityYRef.current + scrollVelocity * 0.36, -0.08, 0.08);
      velocityXRef.current = clamp(Math.sin(progress * Math.PI * 6) * 0.018 + scrollVelocity * 0.045, -0.05, 0.05);
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

    fetch('/api/store')
      .then((res) => res.json())
      .then((data) => {
        setTheme(data?.config?.themeColors || null);
        setBranding(data?.config?.branding || null);
      })
      .catch(() => {});

    window.addEventListener('goyunir-open-cart', open as EventListener);
    window.addEventListener('goyunir-cart-updated', sync as EventListener);
    window.addEventListener('storage', sync);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScrollMotion, { passive: true });
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    rafId = window.requestAnimationFrame(animateIdle);
    return () => {
      window.removeEventListener('goyunir-open-cart', open as EventListener);
      window.removeEventListener('goyunir-cart-updated', sync as EventListener);
      window.removeEventListener('storage', sync);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScrollMotion);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('touchmove', onTouchMove);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    writeCheckoutDetails(checkoutEmail, checkoutAddress);
  }, [checkoutEmail, checkoutAddress]);

  const total = cart.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const hasItems = cart.length > 0;
  const cartIsFcfsOnly = cart.every((item) => (item.checkoutMode || '').toUpperCase() !== 'RAFFLE' && String(item.productType || '').toLowerCase() !== 'raffle');

  const checkoutCart = async () => {
    if (!hasItems) return;
    if (!cartIsFcfsOnly) {
      setCartMsg('Raffle items cannot be purchased in cart. Enter raffle from the product page.');
      return;
    }
    if (!checkoutEmail || !checkoutAddress) {
      setCartMsg('Enter your email and shipping address to continue.');
      return;
    }
    setCheckoutBusy(true);
    setCartMsg('');
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
        window.location.assign(data.url);
        return;
      }
      setEncryptionHealthy(false);
      setCartMsg(data.error || 'Unable to start checkout.');
    } catch {
      setEncryptionHealthy(false);
      setCartMsg('Unable to start checkout.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const headerAccent = theme?.accentBlue || '#7dd3fc';
  const headerBg = theme?.cardBackground || 'rgba(8,8,10,0.82)';
  const glowX = 15 + pointerX * 70;
  const glowY = 8 + pointerY * 55;
  const blurBoost = Math.min(10, Math.floor(scrollY / 60));
  const orbPrimaryX = -16 + pointerX * 68;
  const orbPrimaryY = -8 + pointerY * 72;
  const orbSecondaryX = 56 - pointerX * 32;
  const orbSecondaryY = 48 - pointerY * 26;
  const orbTertiaryX = 18 + pointerX * 24;
  const orbTertiaryY = 62 - pointerY * 18;

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden', background: 'linear-gradient(180deg, rgba(255,255,255,0.018), transparent 28%)' }}>
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(circle at ${glowX}% ${glowY}%, rgba(255,255,255,0.022), transparent 16%)` }} />
        <div style={{ position: 'absolute', width: '58vw', height: '58vw', minWidth: 280, minHeight: 280, maxWidth: 620, maxHeight: 620, left: `${orbPrimaryX}%`, top: `${orbPrimaryY}%`, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: `${headerAccent}22`, filter: 'blur(48px)', willChange: 'transform,left,top', opacity: 0.95 }} />
        <div style={{ position: 'absolute', width: '44vw', height: '44vw', minWidth: 220, minHeight: 220, maxWidth: 480, maxHeight: 480, left: `${orbSecondaryX}%`, top: `${orbSecondaryY}%`, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: 'rgba(168,85,247,0.18)', filter: 'blur(54px)', willChange: 'transform,left,top', opacity: 0.92 }} />
        <div style={{ position: 'absolute', width: '28vw', height: '28vw', minWidth: 140, minHeight: 140, maxWidth: 280, maxHeight: 280, left: `${orbTertiaryX}%`, top: `${orbTertiaryY}%`, transform: 'translate3d(0,0,0)', borderRadius: '999px', background: 'rgba(255,244,214,0.09)', filter: 'blur(34px)', willChange: 'transform,left,top', opacity: 0.9 }} />
      </div>
      {bannerMessage && (
        <div style={{ position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 150, padding: '8px 12px', borderRadius: 999, background: 'rgba(10,10,12,0.92)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', fontSize: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
          {bannerMessage}{promoCode ? ` · ${promoCode}` : ''}
        </div>
      )}
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          minHeight: '60px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: `${headerBg}`,
          backdropFilter: `blur(${18 + blurBoost}px)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          zIndex: 100,
          boxSizing: 'border-box',
          transform: `translateY(${Math.min(8, scrollY * 0.02)}px)`,
          transition: 'transform 160ms ease, backdrop-filter 220ms ease',
          backgroundImage: `radial-gradient(circle at ${glowX}% -20%, ${headerAccent}33, transparent 35%)`,
        }}
      >
        <div style={{ display: 'flex', gap: 10, fontSize: 10, letterSpacing: 1.4, fontWeight: 700, flexWrap: 'wrap', maxWidth: '34%', alignItems: 'center' }}>
          <Link href="/catalog" style={{ color: '#d4d4d8', textDecoration: 'none' }}>CATALOG</Link>
          <span style={{ color: '#4b5563', userSelect: 'none' }}>|</span>
          <Link href="/story" style={{ color: '#71717a', textDecoration: 'none' }}>STORY</Link>
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
          }}
        >
          {branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={branding?.shareTitle || 'GOYUNIR'} style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'cover', display: 'block' }} />
          ) : null}
          <span>GOYUNIR</span>
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', maxWidth: '34%' }}>
          <Link href="/account" style={{ color: '#a1a1aa', textDecoration: 'none', fontSize: 10, letterSpacing: 1.6, fontWeight: 700 }}>ACCOUNT</Link>
          {promoCode && <span style={{ color: '#6b7280', fontSize: 9, letterSpacing: 1, maxWidth: 62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{promoCode}</span>}
          <span style={{ color: '#4b5563', userSelect: 'none' }}>|</span>
          <button
            onClick={() => setCartOpen(true)}
            style={{ border: '1px solid rgba(255,255,255,0.1)', background: hasItems ? '#f3f4f6' : 'transparent', color: hasItems ? '#09090b' : '#d4d4d8', borderRadius: 999, padding: '7px 11px', fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}
          >
            CART {cart.length > 0 ? `(${cart.length})` : ''}
          </button>
        </div>
      </header>

      <div style={{ paddingTop: '60px', minHeight: '100vh' }}>{children}</div>

      <footer style={{ background: 'rgba(8,8,10,0.96)', backdropFilter: 'blur(18px)', borderTop: '1px solid rgba(255,255,255,0.08)', padding: '28px 20px 22px', textAlign: 'center', color: '#71717a', fontSize: 12, position: 'relative', zIndex: 10 }}>
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
                <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: '#7dd3fc' }}>Cart</div>
                <div style={{ fontSize: 22, fontFamily: 'Georgia, Times New Roman, serif', color: '#fff' }}>Review items</div>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#d4d4d8', borderRadius: 999, padding: '8px 10px', cursor: 'pointer' }}>Close</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cart.length === 0 ? (
                <div style={{ border: '1px dashed rgba(255,255,255,0.12)', borderRadius: 20, padding: 18, color: '#a1a1aa', fontSize: 13, lineHeight: 1.6 }}>
                  Your cart is empty. Add direct-purchase items from a product page to review them here.
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
                <button onClick={checkoutCart} disabled={checkoutBusy || !hasItems} style={{ flex: 1, textAlign: 'center', padding: '12px 14px', borderRadius: 999, background: '#f3f4f6', color: '#09090b', border: 'none', textDecoration: 'none', fontWeight: 700, fontSize: 13, cursor: checkoutBusy || !hasItems ? 'not-allowed' : 'pointer' }}>
                  {checkoutBusy ? 'Starting…' : 'Checkout now'}
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