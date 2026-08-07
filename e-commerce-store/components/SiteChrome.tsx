'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type CartItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
  productType?: string;
  checkoutMode?: 'RAFFLE' | 'FCFS';
};

const CART_KEY = 'goyunir-cart';

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

export default function SiteChrome({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutEmail, setCheckoutEmail] = useState('');
  const [checkoutAddress, setCheckoutAddress] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [cartMsg, setCartMsg] = useState('');
  const [scrollY, setScrollY] = useState(0);
  const [pointerX, setPointerX] = useState(0.5);
  const [theme, setTheme] = useState<any>(null);

  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    const open = () => setCartOpen(true);
    const onScroll = () => setScrollY(window.scrollY || 0);
    const onPointer = (event: PointerEvent) => {
      const width = window.innerWidth || 1;
      setPointerX(Math.max(0, Math.min(1, event.clientX / width)));
    };

    fetch('/api/store')
      .then((res) => res.json())
      .then((data) => setTheme(data?.config?.themeColors || null))
      .catch(() => {});

    window.addEventListener('goyunir-open-cart', open as EventListener);
    window.addEventListener('goyunir-cart-updated', sync as EventListener);
    window.addEventListener('storage', sync);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onPointer, { passive: true });
    return () => {
      window.removeEventListener('goyunir-open-cart', open as EventListener);
      window.removeEventListener('goyunir-cart-updated', sync as EventListener);
      window.removeEventListener('storage', sync);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointer);
    };
  }, []);

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
        items: cart.map((item) => ({ productId: item.productId, size: item.size, quantity: 1 })),
      };
      const res = await fetch('/api/checkout/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      setCartMsg(data.error || 'Unable to start checkout.');
    } catch {
      setCartMsg('Unable to start checkout.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const headerAccent = theme?.accentBlue || '#7dd3fc';
  const headerBg = theme?.cardBackground || 'rgba(8,8,10,0.82)';
  const glowX = 15 + pointerX * 70;
  const blurBoost = Math.min(10, Math.floor(scrollY / 60));

  return (
    <>
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
        <div style={{ display: 'flex', gap: 10, fontSize: 10, letterSpacing: 1.4, fontWeight: 700, flexWrap: 'wrap', maxWidth: '34%' }}>
          <Link href="/catalog" style={{ color: '#d4d4d8', textDecoration: 'none' }}>CATALOG</Link>
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
          }}
        >
          GOYUNIR
        </Link>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', maxWidth: '34%' }}>
          <Link href="/account" style={{ color: '#a1a1aa', textDecoration: 'none', fontSize: 10, letterSpacing: 1.6, fontWeight: 700 }}>ACCOUNT</Link>
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
                  <input
                    type="email"
                    value={checkoutEmail}
                    onChange={(e) => setCheckoutEmail(e.target.value)}
                    placeholder="Email"
                    style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#09090b', color: '#fff', fontSize: 12 }}
                  />
                  <input
                    type="text"
                    value={checkoutAddress}
                    onChange={(e) => setCheckoutAddress(e.target.value)}
                    placeholder="Shipping address"
                    style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: '#09090b', color: '#fff', fontSize: 12 }}
                  />
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