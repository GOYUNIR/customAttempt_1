'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

function getProductPriceCategory(product: any, size: string) {
  const cats = product.priceCategories || [];
  return cats.find((c: any) => c.size === size) || null;
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
  const [isRaffleMode, setIsRaffleMode] = useState(true);
  const [isCheckoutMode, setIsCheckoutMode] = useState(false);

  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  const fetchProduct = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`/api/store/config?slug=${slug}`);
      const data = await res.json();
      if (data.product) {
        setProduct(data.product);
        const cats = data.product.priceCategories || [];
        if (cats.length > 0) setSelectedSize(cats[0].size);
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
      const res = await fetch('/api/store/config');
      const data = await res.json();
      if (data.activeProducts) setAllProducts(data.activeProducts);
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    if (initialSlug) {
      fetchProduct(initialSlug);
    } else {
      fetchAllProducts().then(() => {
        if (allProducts.length > 0) {
          router.push(`/${allProducts[0].slug}`);
        } else {
          setLoading(false);
          setError('No products available');
        }
      });
    }
    fetchAllProducts();
  }, [initialSlug, fetchProduct, fetchAllProducts, router, allProducts.length]);

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
      stripeId: cat.stripeId,
      winnerTiers: cat.winnerTiers,
    };
    setCart([...cart, item]);
    setMessage(`Added ${product.name} (${selectedSize}) to cart`);
    setShowCart(true);
  };

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
        body: JSON.stringify({
          productId: product.id,
          size: selectedSize,
          email,
          address,
          mode: 'raffle',
        }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
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
      const res = await fetch('/api/checkout/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          size: selectedSize,
          email,
          address,
        }),
      });
      const data = await res.json();
      if (res.ok && data.paymentIntentId) {
        setMessage('Payment successful! Order placed.');
        setCart([]);
        setShowCart(false);
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
  const winnerTiers = priceCat?.winnerTiers || '0';

  return (
    <main style={{ minHeight: 'calc(100vh - 56px)', background: '#0a0a0a', color: '#fff', padding: '20px 16px 60px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div>
          <h1 style={{ fontSize: 24, fontFamily: 'serif', marginBottom: 4 }}>{product.name}</h1>
          <p style={{ color: '#888', fontSize: 13 }}>{product.tagline}</p>
          <p style={{ color: '#aaa', fontSize: 14, margin: '8px 0' }}>{product.desc}</p>
        </div>

        <div style={{ margin: '16px 0' }}>
          <label style={{ fontSize: 12, color: '#888' }}>Select Size</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {(product.priceCategories || []).map((cat: any) => (
              <button
                key={cat.size}
                onClick={() => setSelectedSize(cat.size)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  border: selectedSize === cat.size ? '1px solid #fff' : '1px solid #333',
                  background: selectedSize === cat.size ? '#fff' : 'transparent',
                  color: selectedSize === cat.size ? '#000' : '#aaa',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {cat.size} {cat.price > 0 ? `($${cat.price})` : ''}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="radio"
              checked={isRaffleMode}
              onChange={() => { setIsRaffleMode(true); setIsCheckoutMode(false); }}
            />
            Raffle (enter draw)
          </label>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="radio"
              checked={isCheckoutMode}
              onChange={() => { setIsCheckoutMode(true); setIsRaffleMode(false); }}
            />
            Buy Now (direct)
          </label>
        </div>

        <div style={{ margin: '12px 0' }}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', padding: 10, borderRadius: 8, background: '#16161a', border: '1px solid #222', color: '#fff', marginBottom: 8 }}
          />
          <input
            type="text"
            placeholder="Shipping Address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            style={{ width: '100%', padding: 10, borderRadius: 8, background: '#16161a', border: '1px solid #222', color: '#fff' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {isRaffleMode && (
            <button
              onClick={handleRaffleSubmit}
              disabled={isSubmitting || !selectedSize || price <= 0}
              style={{
                flex: 1,
                padding: 12,
                borderRadius: 30,
                background: configPalette.checkoutCtaButton,
                color: '#fff',
                border: 'none',
                fontWeight: 700,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Processing...' : 'Enter Raffle'}
            </button>
          )}
          {isCheckoutMode && (
            <button
              onClick={handleDirectCheckout}
              disabled={isSubmitting || !selectedSize || price <= 0}
              style={{
                flex: 1,
                padding: 12,
                borderRadius: 30,
                background: '#34c759',
                color: '#000',
                border: 'none',
                fontWeight: 700,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Processing...' : `Buy Now $${price.toFixed(2)}`}
            </button>
          )}
          <button
            onClick={addToCart}
            disabled={!selectedSize || price <= 0}
            style={{
              padding: '12px 20px',
              borderRadius: 30,
              background: '#333',
              color: '#fff',
              border: 'none',
              cursor: !selectedSize || price <= 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Add to Cart
          </button>
        </div>

        {message && <p style={{ marginTop: 12, fontSize: 12, color: '#edb210' }}>{message}</p>}

        {showCart && cart.length > 0 && (
          <div style={{ marginTop: 20, borderTop: '1px solid #222', paddingTop: 16 }}>
            <h3 style={{ fontSize: 14 }}>Cart ({cart.length})</h3>
            {cart.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                <span>{item.name} ({item.size})</span>
                <span>${item.price.toFixed(2)}</span>
              </div>
            ))}
            <button
              onClick={() => {
                setMessage('Multi‑item cart checkout coming soon');
              }}
              style={{ marginTop: 8, padding: '8px 16px', borderRadius: 20, background: '#fff', color: '#000', border: 'none', fontWeight: 600 }}
            >
              Checkout Cart (${cart.reduce((sum, i) => sum + i.price, 0).toFixed(2)})
            </button>
          </div>
        )}
      </div>
    </main>
  );
}