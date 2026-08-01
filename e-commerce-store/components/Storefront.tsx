'use client';
import { useRef, useEffect, useState } from 'react';
import { useScroll, useTransform, motion, AnimatePresence } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  getProductPrice,
  getVisibleProducts,
  getNextDrawTimestampForSchedule,
  resolveProductSchedule,
  getAvailableSizes,
} from '@/lib/storefront-config';
import { EntryFormState, isValidEmail, normalizeEntryForm } from '@/lib/validation';

interface TimeLeftState {
  d: number;
  h: number;
  m: number;
  s: number;
  expired: boolean;
}

export default function Storefront({ initialSlug }: { initialSlug?: string }) {
  const searchParams = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [archivedProductIds, setArchivedProductIds] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/catalog/status')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.archivedProductIds)) setArchivedProductIds(data.archivedProductIds);
      })
      .catch(() => {});
  }, []);

  const allVisible = getVisibleProducts(GOYUNIR_STORE_SUITE).filter(
    (p) => !archivedProductIds.includes(p.id),
  );

  const requestedProduct = initialSlug
    ? GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.slug === initialSlug)
    : undefined;
  const requestedIsArchived = requestedProduct
    ? archivedProductIds.includes(requestedProduct.id)
    : false;

  const sizes = getAvailableSizes(GOYUNIR_STORE_SUITE);
  const defaultSize =
    sizes.includes('100ml') && searchParams?.get('size') === '100ml' ? '100ml' : sizes[0] || '50ml';

  const [activeProductIndex, setActiveProductIndex] = useState(() => {
    if (requestedProduct && !requestedIsArchived) {
      const idx = allVisible.findIndex((p) => p.id === requestedProduct.id);
      if (idx >= 0) return idx;
    }
    const firstVisibleIndex = allVisible.findIndex((product) => product.isActive !== false);
    return firstVisibleIndex >= 0 ? firstVisibleIndex : 0;
  });

  const [selectedSize, setSelectedSize] = useState(defaultSize);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>({ email: '', shippingAddress: '', quantity: 1 });
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [timeLeft, setTimeLeft] = useState<TimeLeftState>({ d: 0, h: 0, m: 0, s: 0, expired: false });
  const [socialProofDisplay, setSocialProofDisplay] = useState(GOYUNIR_STORE_SUITE.socialProof.baseCount);

  const TOTAL_IMAGES = GOYUNIR_STORE_SUITE.animationMechanics.totalFramesToLoad;
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const heroContent = GOYUNIR_STORE_SUITE.heroContent;

  const currentProduct =
    requestedProduct && requestedIsArchived
      ? requestedProduct
      : allVisible[activeProductIndex] ?? allVisible[0] ?? GOYUNIR_STORE_SUITE.productCatalog[0];

  const isCurrentArchived = archivedProductIds.includes(currentProduct?.id);
  const effectiveSchedule = resolveProductSchedule(GOYUNIR_STORE_SUITE, currentProduct);

  // Keep highlighted button in sync with the URL slug (e.g. /obsidian-void)
  useEffect(() => {
    if (!initialSlug) return;
    const idx = allVisible.findIndex((p) => p.slug === initialSlug);
    if (idx >= 0 && idx !== activeProductIndex) {
      setActiveProductIndex(idx);
    }
  }, [initialSlug, archivedProductIds.join(',')]);

  useEffect(() => {
    if (typeof window === 'undefined' || !currentProduct?.slug) return;
    const path = `/${currentProduct.slug}`;
    if (window.location.pathname !== path) {
      window.history.replaceState({}, '', path + window.location.search);
    }
  }, [currentProduct?.slug]);

  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end end'] });
  const cycles = Math.max(1, GOYUNIR_STORE_SUITE.animationMechanics.spinCyclesTopToCheckout);
  const spinRange = 0.85;
  const framePositions: number[] = [0];
  const frameValues: number[] = [1];
  for (let i = 1; i <= cycles * 2; i++) {
    framePositions.push((spinRange / (cycles * 2)) * i);
    frameValues.push(i % 2 === 1 ? TOTAL_IMAGES : 1);
  }
  const frameIndex = useTransform(scrollYProgress, framePositions, frameValues);
  const bottleOpacity = useTransform(scrollYProgress, [0.72, 0.92], [1, 0]);
  const scrollIndicatorOpacity = useTransform(scrollYProgress, [0, 0.05], [1, 0]);

  useEffect(() => {
    const handleNavigationFix = () => setIsProcessing(false);
    window.addEventListener('popstate', handleNavigationFix);
    return () => window.removeEventListener('popstate', handleNavigationFix);
  }, []);

  useEffect(() => {
    if (!feedbackMessage) return;
    if (feedbackStatus === 'loading') {
      const stallTimer = setTimeout(() => {
        setFeedbackStatus('error');
        setFeedbackMessage('This is taking longer than expected. Check your connection and try again.');
      }, 12000);
      return () => clearTimeout(stallTimer);
    }
    const dismissTimer = setTimeout(() => setFeedbackMessage(''), 6000);
    return () => clearTimeout(dismissTimer);
  }, [feedbackMessage, feedbackStatus]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let tabTokenId = window.sessionStorage.getItem('goyunir_device_fingerprint');
    if (!tabTokenId) {
      tabTokenId = 'usr_' + Math.random().toString(36).substring(2, 9);
      window.sessionStorage.setItem('goyunir_device_fingerprint', tabTokenId);
    }
    const syncLiveAnalytics = () => {
      fetch(`/api/analytics/heartbeat?visitorId=${tabTokenId}`)
        .then((res) => res.json())
        .then((data) => {
          if (typeof data.socialProofDisplay === 'number') setSocialProofDisplay(data.socialProofDisplay);
        })
        .catch(() => {});
    };
    let liveTelemetryTimer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!liveTelemetryTimer) {
        syncLiveAnalytics();
        liveTelemetryTimer = setInterval(syncLiveAnalytics, 25000);
      }
    };
    const stop = () => {
      if (liveTelemetryTimer) {
        clearInterval(liveTelemetryTimer);
        liveTelemetryTimer = null;
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      const isSuccess = sp.get('setup') === 'success';
      const isCancel = sp.get('setup') === 'cancel';
      const sessionId = sp.get('session_id');
      if (isSuccess && sessionId) {
        setFeedbackStatus('loading');
        setFeedbackMessage('Confirming your entry…');
        fetch('/api/checkout/confirm-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then(async (res) => {
            const data = await res.json();
            if (res.ok && data.success) {
              setFeedbackStatus('success');
              setFeedbackMessage(data.message || 'Your entry is locked in. Good luck on the drop!');
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              setFeedbackStatus('error');
              setFeedbackMessage(data.error || 'There was an issue confirming your payment details.');
            }
          })
          .catch(() => {
            setFeedbackStatus('error');
            setFeedbackMessage('Unable to reach verification servers.');
          });
      }
      if (isCancel) {
        setFeedbackStatus('error');
        setFeedbackMessage('Payment setup was canceled. Complete checkout to secure your entry.');
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);

  useEffect(() => {
    const targetTime = getNextDrawTimestampForSchedule(effectiveSchedule);
    const timerLoop = window.setInterval(() => {
      const now = Date.now();
      const delta = targetTime - now;
      if (delta <= 0 || isCurrentArchived) {
        setTimeLeft({ d: 0, h: 0, m: 0, s: 0, expired: true });
        window.clearInterval(timerLoop);
        return;
      }
      const d = Math.floor(delta / 86400000);
      const h = Math.floor((delta % 86400000) / 3600000);
      const m = Math.floor((delta % 3600000) / 60000);
      const s = Math.floor((delta % 60000) / 1000);
      setTimeLeft({ d, h, m, s, expired: false });
    }, 1000);
    return () => window.clearInterval(timerLoop);
  }, [
    effectiveSchedule.mode,
    effectiveSchedule.targetEndDateTime,
    effectiveSchedule.drawDayOfWeek,
    effectiveSchedule.drawDayOfMonth,
    effectiveSchedule.drawHour,
    effectiveSchedule.drawMinute,
    effectiveSchedule.timezone,
    isCurrentArchived,
  ]);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context || !canvasRef.current) return;
    const preloadedImages: HTMLImageElement[] = [];
    canvasRef.current.width = 600;
    canvasRef.current.height = 600;
    const drawFrame = (img: HTMLImageElement) => {
      if (img.complete && img.naturalWidth > 0) {
        context.clearRect(0, 0, 600, 600);
        context.drawImage(img, 0, 0, 600, 600);
      }
    };
    for (let i = 1; i <= TOTAL_IMAGES; i += 1) {
      const img = new Image();
      img.src = `/images/${currentProduct.prefix}_${i}.jpg`;
      img.onload = () => {
        if (i === 1) drawFrame(img);
      };
      preloadedImages.push(img);
    }
    const unsubscribe = frameIndex.on('change', (value) => {
      const index = Math.min(Math.max(Math.round(value), 1), TOTAL_IMAGES);
      const activeFrameImage = preloadedImages[index - 1];
      if (activeFrameImage) drawFrame(activeFrameImage);
    });
    return () => unsubscribe();
  }, [frameIndex, activeProductIndex, TOTAL_IMAGES, currentProduct.prefix, currentProduct.id]);

  const submitRaffleEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isProcessing) return;
    const normalizedForm = normalizeEntryForm(form);
    if (!isValidEmail(normalizedForm.email) || !normalizedForm.shippingAddress) {
      setFeedbackStatus('error');
      setFeedbackMessage('Please provide a valid email and a shipping address.');
      return;
    }
    setIsProcessing(true);
    setFeedbackStatus('loading');
    setFeedbackMessage(
      timeLeft.expired || isCurrentArchived ? 'Saving your entry for the next window…' : 'Securing your entry…',
    );
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: currentProduct.name,
          size: selectedSize,
          email: normalizedForm.email,
          shippingAddress: normalizedForm.shippingAddress,
          quantityChosen: normalizedForm.quantity,
          isWaitlistMode: timeLeft.expired || isCurrentArchived,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        if (data.sessionUrl) {
          window.location.assign(data.sessionUrl);
          return;
        }
        setFeedbackStatus('success');
        setFeedbackMessage(data.message || '✓ Entry secured successfully.');
        setForm({ email: '', shippingAddress: '', quantity: 1 });
      } else {
        setFeedbackStatus('error');
        setFeedbackMessage(data.error || data.message || 'Drop registration failed.');
      }
    } catch (error) {
      setFeedbackStatus('error');
      setFeedbackMessage(error instanceof Error ? `Connection failed: ${error.message}` : 'Connection timeout.');
    } finally {
      setIsProcessing(false);
    }
  };

  const switchProduct = (idx: number) => {
    setActiveProductIndex(idx);
    setSelectedSize(sizes[0] || '50ml');
    const prod = allVisible[idx];
    if (prod?.slug && typeof window !== 'undefined') {
      window.history.replaceState({}, '', `/${prod.slug}`);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        background: configPalette.primaryBackground,
        color: configPalette.textMain,
        position: 'relative',
        width: '100%',
        minHeight: '450vh',
      }}
    >
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '60px',
          borderBottom: `1px solid ${configPalette.cardBorder}`,
          background: 'rgba(10,10,10,0.8)',
          backdropFilter: 'blur(15px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          zIndex: 100,
          boxSizing: 'border-box',
        }}
      >
        <div
          onClick={() => setIsMenuOpen(true)}
          style={{ display: 'flex', flexDirection: 'column', gap: '4px', cursor: 'pointer', padding: '10px 0', width: '24px' }}
        >
          <div style={{ width: '20px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
          <div style={{ width: '20px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
          <div style={{ width: '14px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
        </div>
        <div style={{ fontWeight: 'bold', letterSpacing: '4px', fontSize: '12px', textTransform: 'uppercase' }}>GOYUNIR</div>
        <div style={{ width: '24px' }} />
      </header>

      <AnimatePresence>
        {feedbackMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -10, x: '-50%' }}
            style={{
              position: 'fixed',
              top: '70px',
              left: '50%',
              zIndex: 99,
              fontSize: '11px',
              fontWeight: 'bold',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              background: 'rgba(0,0,0,0.85)',
              padding: '8px 16px',
              borderRadius: '20px',
              whiteSpace: 'nowrap',
              boxShadow: '0 8px 20px rgba(0,0,0,0.4)',
              color: feedbackStatus === 'success' ? '#34c759' : feedbackStatus === 'error' ? '#ff3b30' : '#9ca3af',
              border: `1px solid ${
                feedbackStatus === 'success' ? '#34c759' : feedbackStatus === 'error' ? '#ff3b30' : '#3f3f46'
              }`,
            }}
          >
            {feedbackStatus === 'success' ? '🎯 Entry Verified' : feedbackStatus === 'error' ? '⚠️ Action Needed' : '⏳ Loading'}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        style={{
          position: 'fixed',
          top: '48vh',
          left: 0,
          width: '100%',
          height: '35vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1,
          pointerEvents: 'none',
          boxSizing: 'border-box',
          opacity: bottleOpacity,
        }}
      >
        <canvas ref={canvasRef} style={{ width: '90vw', maxWidth: '300px', height: 'auto', aspectRatio: '1/1' }} />
      </motion.div>

      <motion.div
        style={{
          position: 'fixed',
          bottom: '8vh',
          left: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 15,
          pointerEvents: 'none',
          opacity: scrollIndicatorOpacity,
        }}
      >
        <motion.span
          animate={{ y: [0, -10, 0] }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
          style={{
            textTransform: 'uppercase',
            letterSpacing: '3px',
            fontSize: '9px',
            color: configPalette.textMuted,
            fontWeight: 'bold',
          }}
        >
          {heroContent.ctaLabel}
        </motion.span>
      </motion.div>

      <div style={{ position: 'relative', zIndex: 2, width: '100%' }}>
        <section
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            alignItems: 'center',
            padding: '120px 20px 20px',
            textAlign: 'center',
            pointerEvents: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <span
              style={{
                textTransform: 'uppercase',
                letterSpacing: '6px',
                fontSize: '9px',
                color: '#555',
                fontWeight: 'bold',
              }}
            >
              {heroContent.eyebrow}
            </span>
            <h1 style={{ fontSize: '36px', margin: '10px 0', fontFamily: 'serif', letterSpacing: '1px' }}>
              {currentProduct.name}
            </h1>
            {isCurrentArchived && (
              <div
                style={{
                  display: 'inline-block',
                  marginBottom: '12px',
                  padding: '6px 14px',
                  borderRadius: '20px',
                  border: '1px solid #f59e0b',
                  color: '#f59e0b',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  letterSpacing: '1px',
                }}
              >
                ARCHIVED — enter to stay in for the return
              </div>
            )}
            <p
              style={{
                maxWidth: '300px',
                color: configPalette.textMuted,
                lineHeight: '1.7',
                fontSize: '13px',
                margin: '0 auto 24px',
              }}
            >
              {heroContent.body}
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {allVisible.map((prod, idx) => {
                const isSelected =
                  !isCurrentArchived && (prod.slug === currentProduct?.slug || activeProductIndex === idx);
                return (
                  <button
                    key={prod.id}
                    onClick={() => switchProduct(idx)}
                    style={{
                      padding: '8px 18px',
                      borderRadius: '20px',
                      border: isSelected
                        ? `1px solid ${configPalette.textMain}`
                        : `1px solid ${configPalette.cardBorder}`,
                      background: isSelected ? configPalette.textMain : 'transparent',
                      color: isSelected ? configPalette.primaryBackground : configPalette.textMuted,
                      fontSize: '11px',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {prod.name}
                  </button>
                );
              })}
            </div>
          </motion.div>
        </section>

        <div style={{ position: 'relative', width: '100%', paddingBottom: '15vh' }}>
          {currentProduct.notes.map((note, idx) => {
            const isLeft = idx % 2 === 0;
            const topOffset = 100 + idx * 90;
            const activeColor = idx % 2 === 0 ? configPalette.accentPurple : configPalette.accentBlue;
            return (
              <div
                key={idx}
                style={{
                  position: 'sticky',
                  top: `${topOffset}px`,
                  width: '100%',
                  display: 'flex',
                  justifyContent: isLeft ? 'flex-start' : 'flex-end',
                  padding: '15px 20px',
                  boxSizing: 'border-box',
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4 }}
                  style={{
                    maxWidth: '170px',
                    background: 'rgba(15,15,15,0.92)',
                    padding: '12px',
                    borderRadius: '12px',
                    border: `1px solid ${activeColor}`,
                    backdropFilter: 'blur(8px)',
                    boxShadow: '0 10px 20px rgba(0,0,0,0.5)',
                  }}
                >
                  <span
                    style={{
                      fontSize: '8px',
                      color: activeColor,
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
                    }}
                  >
                    {note.label} / 0{idx + 1}
                  </span>
                  <h4 style={{ fontSize: '14px', margin: '4px 0', fontWeight: 'bold' }}>{note.name}</h4>
                  <p style={{ color: '#ccc', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>{note.text}</p>
                </motion.div>
              </div>
            );
          })}
        </div>

        <section
          style={{
            minHeight: '130vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '100px 15px 40px',
            background: configPalette.primaryBackground,
            position: 'relative',
            zIndex: 10,
            pointerEvents: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '380px',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
              marginBottom: '80px',
            }}
          >
            <div
              style={{
                background: '#141416',
                padding: '14px',
                borderRadius: '14px',
                border: `1px solid ${configPalette.cardBorder}`,
                textAlign: 'center',
              }}
            >
              {timeLeft.expired || isCurrentArchived ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: '#edb210',
                    fontWeight: 'bold',
                    letterSpacing: '1px',
                    textTransform: 'uppercase',
                  }}
                >
                  {isCurrentArchived
                    ? '🔒 Archived — Save your spot for the return'
                    : '🔒 This Drop Has Closed — Join the Restock Waitlist'}
                </span>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: '12px',
                    fontFamily: 'monospace',
                    fontSize: '16px',
                    fontWeight: 'bold',
                  }}
                >
                  <span>
                    {timeLeft.d}
                    {effectiveSchedule.daysLabel}
                  </span>
                  <span>
                    {timeLeft.h}
                    {effectiveSchedule.hoursLabel}
                  </span>
                  <span>
                    {timeLeft.m}
                    {effectiveSchedule.minutesLabel}
                  </span>
                  <span>
                    {timeLeft.s}
                    {effectiveSchedule.secondsLabel}
                  </span>
                </div>
              )}
            </div>

            <div
              style={{
                background: '#141416',
                padding: '14px',
                borderRadius: '14px',
                border: `1px solid ${configPalette.cardBorder}`,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  color: configPalette.accentPurple,
                  fontWeight: 'bold',
                  marginBottom: '6px',
                }}
              >
                {GOYUNIR_STORE_SUITE.socialProof.label}
              </div>
              <div
                style={{
                  fontSize: '18px',
                  fontWeight: 'bold',
                  marginBottom: '4px',
                  fontFamily: 'monospace',
                  color: '#fff',
                  letterSpacing: '1px',
                }}
              >
                {socialProofDisplay.toLocaleString()}
              </div>
              <div style={{ fontSize: '11px', color: configPalette.textMuted }}>
                {GOYUNIR_STORE_SUITE.socialProof.caption}
              </div>
            </div>

            <h2
              style={{
                fontSize: '24px',
                textAlign: 'center',
                fontFamily: 'serif',
                margin: '0 0 10px 0',
                letterSpacing: '1px',
              }}
            >
              {GOYUNIR_STORE_SUITE.raffleRegistrationForm.titleHeader}
            </h2>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              style={{
                background: configPalette.cardBackground,
                padding: '24px 20px',
                borderRadius: '24px',
                border: `1px solid ${configPalette.cardBorder}`,
                boxSizing: 'border-box',
              }}
            >
              <h3 style={{ fontSize: '20px', margin: '0 0 4px 0', fontFamily: 'serif', textAlign: 'center' }}>
                {currentProduct.name}
              </h3>
              <p style={{ color: configPalette.textMuted, fontSize: '12px', margin: '0 0 20px 0', textAlign: 'center' }}>
                {currentProduct.desc}
              </p>
              <form
                onSubmit={submitRaffleEntry}
                style={{ display: 'flex', flexDirection: 'column', gap: '12px', textAlign: 'left' }}
              >
                {sizes.length > 1 ? (
                  <div>
                    <label
                      style={{
                        fontSize: '10px',
                        fontWeight: 'bold',
                        color: configPalette.textMuted,
                        letterSpacing: '1px',
                        textTransform: 'uppercase',
                        display: 'block',
                        marginBottom: '4px',
                      }}
                    >
                      Select Capacity Size
                    </label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {sizes.map((sz) => {
                        const displayPrice = getProductPrice(currentProduct, sz);
                        const isSelected = selectedSize === sz;
                        return (
                          <button
                            key={sz}
                            type="button"
                            onClick={() => setSelectedSize(sz)}
                            style={{
                              flex: 1,
                              padding: '12px',
                              borderRadius: '12px',
                              border: isSelected ? '2px solid #fff' : `1px solid ${configPalette.cardBorder}`,
                              background: isSelected ? '#ffffff' : 'transparent',
                              color: isSelected ? '#000000' : configPalette.textMain,
                              fontSize: '13px',
                              fontWeight: 'bold',
                              cursor: 'pointer',
                            }}
                          >
                            {sz} — ${displayPrice}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', fontSize: '13px', fontWeight: 'bold', marginBottom: '4px' }}>
                    {sizes[0]} — ${getProductPrice(currentProduct, sizes[0])}
                  </div>
                )}
                <div>
                  <label
                    style={{
                      fontSize: '10px',
                      fontWeight: 'bold',
                      color: configPalette.textMuted,
                      letterSpacing: '1px',
                      textTransform: 'uppercase',
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    {GOYUNIR_STORE_SUITE.raffleRegistrationForm.emailLabel}
                  </label>
                  <input
                    required
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder={GOYUNIR_STORE_SUITE.raffleRegistrationForm.emailPlaceholder}
                    style={{
                      width: '100%',
                      padding: '14px',
                      borderRadius: '12px',
                      background: '#16161a',
                      border: `1px solid ${configPalette.cardBorder}`,
                      color: configPalette.textMain,
                      fontSize: '13px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div>
                  <label
                    style={{
                      fontSize: '10px',
                      fontWeight: 'bold',
                      color: configPalette.textMuted,
                      letterSpacing: '1px',
                      textTransform: 'uppercase',
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    {GOYUNIR_STORE_SUITE.raffleRegistrationForm.addressLabel}
                  </label>
                  <input
                    required
                    type="text"
                    value={form.shippingAddress}
                    onChange={(e) => setForm((prev) => ({ ...prev, shippingAddress: e.target.value }))}
                    placeholder={GOYUNIR_STORE_SUITE.raffleRegistrationForm.addressPlaceholder}
                    style={{
                      width: '100%',
                      padding: '14px',
                      borderRadius: '12px',
                      background: '#16161a',
                      border: `1px solid ${configPalette.cardBorder}`,
                      color: configPalette.textMain,
                      fontSize: '13px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: '11px',
                    color: configPalette.textMuted,
                    textAlign: 'center',
                    lineHeight: 1.4,
                  }}
                >
                  Card is saved only — you are charged only if you win the allocation.
                </p>
                <button
                  type="submit"
                  disabled={isProcessing}
                  style={{
                    width: '100%',
                    padding: '16px',
                    borderRadius: '30px',
                    background: isProcessing
                      ? '#1f1f23'
                      : timeLeft.expired || isCurrentArchived
                        ? '#edb210'
                        : configPalette.checkoutCtaButton,
                    color: isProcessing
                      ? '#555'
                      : timeLeft.expired || isCurrentArchived
                        ? '#09090b'
                        : configPalette.textMain,
                    border: 'none',
                    fontWeight: 'bold',
                    fontSize: '14px',
                    cursor: isProcessing ? 'not-allowed' : 'pointer',
                    marginTop: '8px',
                  }}
                >
                  {isProcessing
                    ? GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonLoadingText
                    : timeLeft.expired || isCurrentArchived
                      ? 'Save Spot for Return / Waitlist'
                      : GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonText}
                </button>
              </form>
            </motion.div>
          </div>

          <footer
            style={{
              width: '100%',
              maxWidth: '380px',
              borderTop: `1px solid ${configPalette.cardBorder}`,
              paddingTop: '40px',
              color: configPalette.textMuted,
              fontSize: '12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px 0' }}>CONNECT</p>
                <a
                  href={GOYUNIR_STORE_SUITE.brandFooterData.instagramLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#888', display: 'block', textDecoration: 'none', marginBottom: '6px' }}
                >
                  Instagram
                </a>
                <a
                  href={GOYUNIR_STORE_SUITE.brandFooterData.tiktokLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#888', display: 'block', textDecoration: 'none' }}
                >
                  TikTok
                </a>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px 0' }}>SUPPORT</p>
                <span style={{ color: '#888', display: 'block', marginBottom: '6px' }}>
                  {GOYUNIR_STORE_SUITE.brandFooterData.supportEmail}
                </span>
                <span style={{ color: '#888', display: 'block' }}>
                  {GOYUNIR_STORE_SUITE.brandFooterData.shippingReturnPolicyText}
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <a href="/account" style={{ color: '#666', fontSize: '11px', textDecoration: 'underline' }}>
                Manage My Entry
              </a>
            </div>
            <div style={{ textAlign: 'center', color: '#333', fontSize: '10px', marginTop: '30px' }}>
              © {new Date().getFullYear()} {GOYUNIR_STORE_SUITE.brandFooterData.corporateEntityCopyright}
            </div>
          </footer>
        </section>
      </div>

      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsMenuOpen(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(12px)',
              zIndex: 200,
              display: 'flex',
              justifyContent: 'flex-start',
            }}
          >
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '300px',
                height: '100%',
                background: '#0e0e10',
                borderRight: `1px solid ${configPalette.cardBorder}`,
                padding: '40px 24px',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <a
                href="/catalog"
                style={{
                  marginTop: '20px',
                  color: configPalette.textMain,
                  fontSize: '13px',
                  fontWeight: 'bold',
                  textDecoration: 'none',
                }}
              >
                Catalog →
              </a>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 0' }}>
                <h4 style={{ fontFamily: 'serif', fontSize: '18px', margin: '0 0 10px 0' }}>Our Scent Identity</h4>
                <p style={{ color: configPalette.textMuted, fontSize: '12px', lineHeight: '1.6' }}>
                  GOYUNIR engineering blends raw extraction mechanics with hyper-modern chemical balancing.
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}