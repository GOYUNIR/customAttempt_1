'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

const CART_KEY = 'goyunir-cart';

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

export default function Storefront({ initialSlug }: { initialSlug?: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<any>(null);
  const [allProducts, setAllProducts] = useState<any[]>([]);
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

  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  const fetchProduct = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`/api/store?slug=${slug}`);
      const data = await res.json();
      if (data.product) {
        setProduct(data.product);
        const drawAnchor = data?.config?.dropSchedule?.targetEndDateTime;
        const anchorMs = drawAnchor ? new Date(drawAnchor).getTime() : NaN;
        setRaffleEndsAt(Number.isFinite(anchorMs) ? anchorMs : null);
        const cats = data.product.priceCategories || [];
        if (cats.length > 0) setSelectedSize(cats[0].size);
        setSelectedImageIndex(0);
      } else {
        setError('Product not found');
      }
    } catch (e) {
      setError('Failed to load product');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/store');
      const data = await res.json();
      const sorted = Array.isArray(data.activeProducts)
        ? [...data.activeProducts].sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)))
        : [];
      setAllProducts(sorted);
      return sorted;
    } catch (e) {
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

  useEffect(() => {
    setCart(readStoredCart());
  }, []);

  useEffect(() => {
    if (!initialSlug || typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const setupState = params.get('setup');
    const purchaseState = params.get('purchase');
    if (!sessionId) {
      if (setupState === 'cancel') setMessage('Card setup was cancelled before the entry was secured.');
      if (purchaseState === 'cancel') setMessage('Checkout was cancelled before payment completed.');
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
          setMessage(data.message || 'Your entry is locked in.');
          clearQuery();
        })
        .catch(() => setMessage('We could not verify the completed setup, but it may still have succeeded.'));
      return;
    }

    if (purchaseState === 'success') {
      setCart([]);
      writeStoredCart([]);
      setMessage('Purchase complete. Your order is now being prepared.');
      clearQuery();
    }
  }, [initialSlug]);

  const addToCart = () => {
    if (!product) return;
    const cat = getProductPriceCategory(product, selectedSize);
    if (!cat || cat.price <= 0) {
      setMessage('Price not set for this size. Please set in admin.');
      return;
    }
    const item = {
      productId: product.id,
      name: product.name,
      size: selectedSize,
      price: cat.price,
      checkoutMode: checkoutMode,
      productType: checkoutMode === 'FCFS' ? 'fcfs' : 'raffle',
    };
    const maxPerCart = Math.max(1, Number(product.maxPerCart || product.maxPerEmail || 1));
    const inCartCount = cart.filter((entry) => entry.productId === product.id && entry.size === selectedSize).length;
    if (inCartCount >= maxPerCart) {
      setMessage(`Limit reached: ${maxPerCart} for ${product.name} (${selectedSize}).`);
      return;
    }
    const next = [...cart, item];
    setCart(next);
    writeStoredCart(next);
    setMessage(`Added ${product.name} (${selectedSize}) to cart`);
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
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [raffleEndsAt]);

  const handleRaffleSubmit = async () => {
    if (!email || !address || !selectedSize) {
      setMessage('Please fill in all fields and select a size.');
      return;
    }
    setIsSubmitting(true);
    setMessage('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, size: selectedSize, email, address, mode: 'raffle' }),
      });
      const data = await res.json();
      if (res.ok && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        window.location.href = data.url;
      } else {
        setMessage(data.error || 'Failed to start checkout');
      }
    } catch (e) {
      setMessage('Connection error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDirectCheckout = async () => {
    if (!email || !address || !selectedSize) {
      setMessage('Please fill in all fields and select a size.');
      return;
    }
    setIsSubmitting(true);
    setMessage('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, size: selectedSize, email, address, mode: 'direct' }),
      });
      const data = await res.json();
      if (res.ok && typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        window.location.href = data.url;
      } else {
        setMessage(data.error || 'Checkout failed');
      }
    } catch (e) {
      setMessage('Connection error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) return <div style={{ padding: 40, color: '#888' }}>Loading...</div>;
  if (error || !product) return <div style={{ padding: 40, color: '#f87171' }}>{error || 'Product not found'}</div>;

  const priceCat = getProductPriceCategory(product, selectedSize);
  const price = priceCat?.price || 0;
  const checkoutMode = String(product.checkoutMode || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE';
  const canCheckoutDirect = checkoutMode === 'FCFS';
  const isRaffleProduct = checkoutMode === 'RAFFLE';
  const fallbackImage = getFallbackImage(product);
  const galleryImages = Array.isArray(product.images) && product.images.length > 0 ? product.images.filter(Boolean) : (fallbackImage ? [fallbackImage] : []);
  const activeProductLabel = product.isArchived ? 'Archived' : (product.isUpcoming ? 'Upcoming' : 'Live now');

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: configPalette.primaryBackground, color: configPalette.textMain, padding: '16px 14px 60px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <section style={{ borderRadius: 24, overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: '#111116' }}>
          <div style={{ height: 280, background: `url(${galleryImages[selectedImageIndex] || galleryImages[0]}) center/cover` }} />
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>{activeProductLabel}</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>{checkoutMode}</div>
            </div>
            <h1 style={{ fontSize: 24, fontFamily: 'serif', margin: 0 }}>{product.name}</h1>
            <p style={{ margin: 0, color: '#c9c9d3', fontSize: 13, lineHeight: 1.6 }}>{product.desc}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {galleryImages.map((image: string, index: number) => (
                <button key={`${image}-${index}`} onClick={() => setSelectedImageIndex(index)} style={{ width: 54, height: 54, borderRadius: 10, border: selectedImageIndex === index ? `1px solid ${configPalette.accentPurple}` : `1px solid ${configPalette.cardBorder}`, background: `url(${image}) center/cover`, cursor: 'pointer' }} />
              ))}
            </div>
          </div>
        </section>

        <section style={{ borderRadius: 20, border: `1px solid ${configPalette.cardBorder}`, background: '#111116', padding: 14 }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.textMuted }}>Select size</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {(product.priceCategories || []).map((cat: any) => (
                <button key={cat.size} onClick={() => setSelectedSize(cat.size)} style={{ padding: '8px 12px', borderRadius: 999, border: selectedSize === cat.size ? `1px solid ${configPalette.textMain}` : `1px solid ${configPalette.cardBorder}`, background: selectedSize === cat.size ? configPalette.textMain : 'transparent', color: selectedSize === cat.size ? configPalette.primaryBackground : configPalette.textMain, cursor: 'pointer', fontSize: 12 }}>
                  {cat.size} {cat.price > 0 ? `($${cat.price})` : ''}
                </button>
              ))}
            </div>
          </div>

          {isRaffleProduct && countdownLabel && (
            <div style={{ marginBottom: 10, fontSize: 12, color: '#c9c9d3' }}>
              Raffle ends in: <strong>{countdownLabel}</strong>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 180, padding: 10, borderRadius: 10, background: '#09090b', border: `1px solid ${configPalette.cardBorder}`, color: '#fff' }} />
            <input type="text" placeholder="Shipping address" value={address} onChange={(e) => setAddress(e.target.value)} style={{ flex: 1, minWidth: 180, padding: 10, borderRadius: 10, background: '#09090b', border: `1px solid ${configPalette.cardBorder}`, color: '#fff' }} />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isRaffleProduct && (
              <button onClick={handleRaffleSubmit} disabled={isSubmitting || !selectedSize || price <= 0} style={{ flex: 1, minWidth: 140, padding: '12px 14px', borderRadius: 999, background: configPalette.checkoutCtaButton, color: '#fff', border: 'none', fontWeight: 700, cursor: isSubmitting ? 'not-allowed' : 'pointer' }}>
                {isSubmitting ? 'Processing...' : 'Enter raffle'}
              </button>
            )}
            {canCheckoutDirect && (
              <button onClick={handleDirectCheckout} disabled={isSubmitting || !selectedSize || price <= 0} style={{ flex: 1, minWidth: 140, padding: '12px 14px', borderRadius: 999, background: '#34c759', color: '#000', border: 'none', fontWeight: 700, cursor: isSubmitting ? 'not-allowed' : 'pointer' }}>
                {isSubmitting ? 'Processing...' : `Buy now $${price.toFixed(2)}`}
              </button>
            )}
            {canCheckoutDirect && <button onClick={addToCart} disabled={!selectedSize || price <= 0} style={{ padding: '12px 16px', borderRadius: 999, background: '#333', color: '#fff', border: 'none', cursor: !selectedSize || price <= 0 ? 'not-allowed' : 'pointer' }}>Add to cart</button>}
          </div>

          {message && <div style={{ marginTop: 10, fontSize: 12, color: '#f5c542' }}>{message}</div>}
        </section>

        <section style={{ borderRadius: 20, border: `1px solid ${configPalette.cardBorder}`, background: '#111116', padding: 14 }}>
          <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>Why this drop matters</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(product.notes || []).map((note: any, index: number) => (
              <div key={`${note.label}-${index}`} style={{ borderRadius: 16, background: '#09090b', padding: 12, border: `1px solid ${configPalette.cardBorder}` }}>
                <div style={{ fontSize: 10, color: configPalette.accentPurple, textTransform: 'uppercase', letterSpacing: '2px', marginBottom: 4 }}>{note.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{note.name}</div>
                <div style={{ fontSize: 12, color: '#c8c8cf', lineHeight: 1.55 }}>{note.text}</div>
              </div>
            ))}
          </div>
        </section>

        {showCart && cart.length > 0 && (
          <section style={{ borderRadius: 20, border: `1px solid ${configPalette.cardBorder}`, background: '#111116', padding: 14 }}>
            <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>Cart</div>
            {cart.map((item, index) => (
              <div key={`${item.name}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0' }}>
                <span>{item.name} · {item.size}</span>
                <span>${item.price.toFixed(2)}</span>
              </div>
            ))}
            <button onClick={() => window.dispatchEvent(new CustomEvent('goyunir-open-cart'))} style={{ marginTop: 8, padding: '10px 14px', borderRadius: 999, background: '#fff', color: '#000', border: 'none', fontWeight: 700 }}>Open header cart</button>
          </section>
        )}
      </div>
    </main>
  );
}
