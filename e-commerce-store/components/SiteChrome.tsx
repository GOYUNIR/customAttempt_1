'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type CartItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
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

  useEffect(() => {
    const sync = () => setCart(readCart());
    sync();
    window.addEventListener('goyunir-cart-updated', sync as EventListener);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('goyunir-cart-updated', sync as EventListener);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const total = cart.reduce((sum, item) => sum + (Number(item.price) || 0), 0);

  return (
    <>
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '60px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(8,8,10,0.82)',
          backdropFilter: 'blur(18px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          zIndex: 100,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 700 }}>
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
            letterSpacing: '5px',
            fontSize: '12px',
            textTransform: 'uppercase',
            color: '#ffffff',
            textDecoration: 'none',
          }}
        >
          GOYUNIR
        </Link>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            onClick={() => setCartOpen(true)}
            style={{ border: '1px solid rgba(255,255,255,0.1)', background: cart.length > 0 ? '#f3f4f6' : 'transparent', color: cart.length > 0 ? '#09090b' : '#d4d4d8', borderRadius: 999, padding: '8px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: 1 }}
          >
            CART {cart.length > 0 ? `(${cart.length})` : ''}
          </button>
          <Link href="/account" style={{ color: '#71717a', textDecoration: 'none', fontSize: 11, letterSpacing: 2, fontWeight: 700 }}>ACCOUNT</Link>
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Link href="/catalog" onClick={() => setCartOpen(false)} style={{ flex: 1, textAlign: 'center', padding: '12px 14px', borderRadius: 999, background: '#f3f4f6', color: '#09090b', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>Browse catalog</Link>
                <button onClick={() => { setCart([]); writeCart([]); }} style={{ padding: '12px 14px', borderRadius: 999, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#d4d4d8', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Clear</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}