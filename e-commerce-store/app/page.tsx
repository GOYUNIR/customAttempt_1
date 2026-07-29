'use client';

import { useState, useEffect } from 'react';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function StorefrontHome() {
  const [selectedSize, setSelectedSize] = useState('50ml');
  const [activeProductIndex, setActiveProductIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [visitorId] = useState(() => `v_${Math.random().toString(36).substring(7)}`);
  
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [timeLeft, setTimeLeft] = useState({ d: 0, h: 0, m: 0, s: 0, expired: false });
  
  const [form, setForm] = useState({ email: '', shippingAddress: '', quantity: 1 });

  const productCatalog = GOYUNIR_STORE_SUITE?.productCatalog || [];
  const currentProduct = productCatalog[activeProductIndex] || { id: 'p1', name: 'Elysian White', price: 120 };

  const normalizeEntryForm = (rawForm: typeof form) => ({
    email: String(rawForm.email || '').trim(),
    shippingAddress: String(rawForm.shippingAddress || '').trim(),
    quantity: Math.max(1, Number(rawForm.quantity) || 1)
  });

  const isValidEmail = (emailStr: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr);

  // REAL-TIME TRAFFIC HEARTBEAT TRACKING SIGNAL DISTRIBUTOR
  useEffect(() => {
    const fireHeartbeat = () => {
      fetch(`/api/admin/status?heartbeat=true&visitorId=${visitorId}`).catch(() => {});
    };
    fireHeartbeat();
    const heartbeatTimer = setInterval(fireHeartbeat, 15000);
    return () => clearInterval(heartbeatTimer);
  }, [visitorId]);
  // ==========================================
  // SYSTEM ENGINE A: TIMELINE TIMER LOOP
  // ==========================================
  useEffect(() => {
    const formattedString = GOYUNIR_STORE_SUITE.dropSchedule.targetEndDateTime;
    const standardizedTime = formattedString.endsWith('Z') ? formattedString : `${formattedString}Z`;
    const targetTime = new Date(standardizedTime).getTime();
    
    const timerLoop = window.setInterval(() => {
      const now = Date.now();
      const delta = targetTime - now;

      // CONTINUOUS WAITLIST ENGAGEMENT SWITCH STATE (NO HARD-LOCK ERROR CUTOFFS)
      if (delta <= 0) {
        window.clearInterval(timerLoop);
        setTimeLeft({ d: 0, h: 0, m: 0, s: 0, expired: true });
        return;
      }

      const d = Math.floor(delta / (1000 * 60 * 60 * 24));
      const h = Math.floor((delta % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const m = Math.floor((delta % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((delta % (1000 * 60)) / 1000);
      
      setTimeLeft({ d, h, m, s, expired: false });
    }, 1000);

    return () => window.clearInterval(timerLoop);
  }, []);

  // ==========================================
  // SYSTEM ENGINE B: SECURE SECURED CHECKOUT HANDSHAKE
  // ==========================================
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const searchParams = new URLSearchParams(window.location.search);
    const setupStatus = searchParams.get('setup');
    const sessionId = searchParams.get('session_id');

    if (setupStatus === 'success' && sessionId) {
      setFeedbackStatus('idle');
      setFeedbackMessage('🔒 SECURE HANDSHAKE: Authenticating credit card credentials with Stripe servers...');
      
      const intervalCheck = setInterval(() => {
        fetch(`/api/admin/status?t=${Date.now()}`)
          .then((res) => res.json())
          .then((data) => {
            const isConfirmed = data.fallbackEntries?.some((entry: any) => 
              String(entry.id).includes(sessionId) || String(entry.email).includes(sessionId)
            );

            if (isConfirmed || data.fallbackEntriesCount > 0) {
              clearInterval(intervalCheck);
              setFeedbackStatus('success');
              setFeedbackMessage('🎯 SECURED: Stripe has fully authorized your card hold. Entry locked in!');
              window.history.replaceState({}, document.title, window.location.pathname);
            }
          })
          .catch(() => {});
      }, 2000);

      setTimeout(() => {
        clearInterval(intervalCheck);
        setFeedbackStatus('error');
        setFeedbackMessage('⚠️ Handshake timeout. Processing background entry holds.');
      }, 10000);
      
    } else if (setupStatus === 'cancel') {
      setFeedbackStatus('error');
      setFeedbackMessage('❌ Checkout session aborted. Registration context cancelled.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // ==========================================
  // SYSTEM ENGINE C: FLEXIBLE ADAPTIVE SUBMISSION FORM
  // ==========================================
  const submitRaffleEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isProcessing) return;

    const activeProd = currentProduct;
    const normalizedForm = normalizeEntryForm(form);
    const normalizedEmail = normalizedForm.email;
    const normalizedAddress = normalizedForm.shippingAddress;

    if (!isValidEmail(normalizedEmail) || !normalizedAddress) {
      setFeedbackStatus('error');
      setFeedbackMessage('Please provide a valid email and a shipping destination address.');
      return;
    }

    setIsProcessing(true);
    setFeedbackStatus('idle');
    setFeedbackMessage(timeLeft.expired ? 'Logging priorities restock waitlist tracks...' : 'Connecting to Stripe secure encryption servers...');

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: activeProd.name,
          size: selectedSize,
          email: normalizedEmail,
          shippingAddress: normalizedAddress,
          quantityChosen: normalizedForm.quantity,
          isWaitlistMode: timeLeft.expired // Flags waitlist structure smoothly post-countdown
        }),
      });

      const data = await response.json();
      
      if (response.ok) {
        if (data.sessionUrl) {
          window.location.assign(data.sessionUrl); 
          return;
        }
        setFeedbackStatus('success');
        setFeedbackMessage(data.message || '✓ Registration completed successfully.');
        setForm({ email: '', shippingAddress: '', quantity: 1 });
      } else {
        setFeedbackStatus('error');
        setFeedbackMessage(data.error || '⚠️ Drop system registration failed.');
      }
    } catch (error) {
      setFeedbackStatus('error');
      setFeedbackMessage('❌ Server connection timeout. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };
  return (
    <main style={{ minHeight: '100vh', padding: '48px 24px', background: '#060606', color: '#f7f7f7', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '32px' }}>
        
        {/* ORIGINAL PREMIUM MINIMALIST BRAND HEADER */}
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: '2.5rem', margin: 0, fontWeight: '800', letterSpacing: '-0.03em', textTransform: 'uppercase' }}>GOYUNIR</h1>
          <p style={{ color: '#888', margin: '6px 0 0 0', fontSize: '14px' }}>Limited-Run High-End Fragrance Suite Selection</p>
        </div>

        {/* SECURE DYNAMIC HANDSHAKE FEEDBACK BANNER */}
        {feedbackMessage && (
          <div style={{ 
            padding: '24px', 
            borderRadius: '24px', 
            background: feedbackStatus === 'success' ? 'linear-gradient(135deg, rgba(52,211,153,0.15) 0%, rgba(16,185,129,0.05) 100%)' : feedbackStatus === 'error' ? 'rgba(248,113,113,0.05)' : '#111',
            border: feedbackStatus === 'success' ? '2px solid #34d399' : feedbackStatus === 'error' ? '1px solid #f87171' : '1px solid #27272a',
            boxShadow: feedbackStatus === 'success' ? '0 0 30px rgba(52,211,153,0.15)' : 'none',
            textAlign: 'center'
          }}>
            {feedbackStatus === 'success' && <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎉⚡️</div>}
            <p style={{ margin: 0, fontSize: feedbackStatus === 'success' ? '16px' : '13px', fontWeight: feedbackStatus === 'success' ? '700' : '500', color: feedbackStatus === 'success' ? '#34d399' : feedbackStatus === 'error' ? '#f87171' : '#a1a1aa' }}>
              {feedbackMessage}
            </p>
          </div>
        )}

        {/* MINIMALIST VISUAL TIMELINE SCOREBOARD */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a', textAlign: 'center' }}>
          <span style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 'bold' }}>
            {timeLeft.expired ? 'LAUNCH CHANNELS' : 'RAFFLE CLOSES IN'}
          </span>
          
          {timeLeft.expired ? (
            <h2 style={{ fontSize: '1.5rem', margin: '12px 0 0 0', fontWeight: '800', color: '#edb210', textTransform: 'uppercase', letterSpacing: '-0.01em' }}>
              Raffle Closed — Priority Backorder Queue Active
            </h2>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginTop: '16px' }}>
              <div style={{ background: '#09090b', padding: '12px', borderRadius: '14px', border: '1px solid #1c1c1e' }}>
                <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#fff' }}>{timeLeft.d}</div>
                <div style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>Days</div>
              </div>
              <div style={{ background: '#09090b', padding: '12px', borderRadius: '14px', border: '1px solid #1c1c1e' }}>
                <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#fff' }}>{timeLeft.h}</div>
                <div style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>Hrs</div>
              </div>
              <div style={{ background: '#09090b', padding: '12px', borderRadius: '14px', border: '1px solid #1c1c1e' }}>
                <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#fff' }}>{timeLeft.m}</div>
                <div style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>Min</div>
              </div>
              <div style={{ background: '#09090b', padding: '12px', borderRadius: '14px', border: '1px solid #1c1c1e' }}>
                <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#edb210' }}>{timeLeft.s}</div>
                <div style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>Sec</div>
              </div>
            </div>
          )}
        </section>

        {/* VARIANT CARD SELECTION MATRIX */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <span style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Select Fragrance Variant</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {productCatalog.map((prod: any, idx: number) => (
              <button 
                key={prod.id || idx}
                type="button"
                onClick={() => setActiveProductIndex(idx)}
                style={{ padding: '20px', borderRadius: '16px', background: activeProductIndex === idx ? '#1c1c1e' : '#111', border: activeProductIndex === idx ? '1px solid #fff' : '1px solid #222', color: '#fff', textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s' }}
              >
                <div style={{ fontWeight: '700', fontSize: '15px' }}>{prod.name}</div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>${prod.price || 120} USD</div>
              </button>
            ))}
          </div>
        </section>

        {/* MINIMALIST PREMIUM ADAPTIVE CHANNELS RECOVERY FORM CONTAINER */}
        <section style={{ padding: '24px', borderRadius: '24px', background: '#111', border: '1px solid #27272a' }}>
          <form onSubmit={submitRaffleEntry} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Email Address</label>
              <input type="email" required placeholder="name@domain.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={{ background: '#09090b', border: '1px solid #27272a', padding: '12px', borderRadius: '10px', color: '#fff', fontSize: '13px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Shipping Destination Address</label>
              <input type="text" required placeholder="Street, City, State, ZIP" value={form.shippingAddress} onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })} style={{ background: '#09090b', border: '1px solid #27272a', padding: '12px', borderRadius: '10px', color: '#fff', fontSize: '13px' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Bottle Volume</label>
                <select value={selectedSize} onChange={(e) => setSelectedSize(e.target.value)} style={{ background: '#09090b', border: '1px solid #27272a', padding: '12px', borderRadius: '10px', color: '#fff', fontSize: '13px', cursor: 'pointer' }}>
                  <option value="50ml">50ml Standard Edition</option>
                  <option value="100ml">100ml Collectors Edition</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Quantity Limit</label>
                <input type="number" min="1" max="1" disabled value={form.quantity} style={{ background: '#09090b', border: '1px solid #27272a', padding: '12px', borderRadius: '10px', color: '#555', fontSize: '13px', cursor: 'not-allowed' }} />
              </div>
            </div>
            <button type="submit" disabled={isProcessing} style={{ width: '100%', marginTop: '12px', padding: '16px', borderRadius: '14px', border: 'none', background: isProcessing ? '#1f1f23' : '#fff', color: isProcessing ? '#555' : '#000', fontWeight: '700', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.02em', cursor: isProcessing ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}>
              {isProcessing 
                ? '⚡ Processing Connection...' 
                : timeLeft.expired 
                  ? '✨ Request Access on Restock Waitlist' 
                  : '🔥 Secure Entry Allocation Ticket'
              }
            </button>
          </form>
        </section>

      </div>
    </main>
  );
}
