'use client';

import Link from 'next/link';
import { useRef, useEffect, useState, useMemo } from 'react';
import { useScroll, useTransform, motion, AnimatePresence } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  getProductPrice,
  getVisibleProducts,
  getNextDrawTimestampForSchedule,
  resolveProductSchedule,
  getAvailableSizes,
  type DropScheduleConfig,
} from '@/lib/storefront-config';
import { EntryFormState, isValidEmail, normalizeEntryForm } from '@/lib/validation';

interface TimeLeftState {
  d: number;
  h: number;
  m: number;
  s: number;
  expired: boolean;
}

const PREFILL_KEY = 'goyunir_entry_prefill';
const PROMO_REF_KEY = 'goyunir_promo_ref';

const frostCard: React.CSSProperties = {
  background: 'rgba(20, 20, 24, 0.55)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
};

export default function Storefront({ initialSlug }: { initialSlug?: string }) {
  const searchParams = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [archivedProductIds, setArchivedProductIds] = useState<string[]>([]);
  const [archiveNotesMap, setArchiveNotesMap] = useState<Record<string, string>>({});
  const [archiveFromMap, setArchiveFromMap] = useState<Record<string, string>>({});
  const [soldOutIds, setSoldOutIds] = useState<string[]>([]);

  // Live overrides from admin (no redeploy)
  const [globalScheduleOverride, setGlobalScheduleOverride] = useState<Partial<DropScheduleConfig> | null>(null);
  const [productOverrides, setProductOverrides] = useState<
    Record<string, { price50ml?: number; price100ml?: number; customDropSchedule?: Partial<DropScheduleConfig> }>
  >({});

  useEffect(() => {
    fetch('/api/catalog/status')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.archivedProductIds)) setArchivedProductIds(data.archivedProductIds);
        if (data.notesByProductId) setArchiveNotesMap(data.notesByProductId);
        if (data.availableFromByProductId) setArchiveFromMap(data.availableFromByProductId);
        if (Array.isArray(data.soldOutProductIds)) setSoldOutIds(data.soldOutProductIds);
        else if (Array.isArray(data.records)) {
          setSoldOutIds(
            data.records.filter((r: any) => r.soldOut || r.availableFrom === 'Sold out').map((r: any) => r.productId),
          );
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/config/public')
      .then((res) => res.json())
      .then((data) => {
        if (data.globalScheduleOverride) setGlobalScheduleOverride(data.globalScheduleOverride);
        if (data.productOverrides) setProductOverrides(data.productOverrides);
      })
      .catch(() => {});
  }, []);

  const allVisible = getVisibleProducts(GOYUNIR_STORE_SUITE).filter((p) => !archivedProductIds.includes(p.id));

  const requestedProduct = initialSlug
    ? GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.slug === initialSlug)
    : undefined;
  const requestedIsArchived = requestedProduct ? archivedProductIds.includes(requestedProduct.id) : false;

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
  const [form, setForm] = useState<EntryFormState>({ email: '', shippingAddress: '', quantity: 1 });
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'loading' | 'success' | 'notice' | 'error'>(
    'idle',
  );
  const [timeLeft, setTimeLeft] = useState<TimeLeftState>({ d: 0, h: 0, m: 0, s: 0, expired: false });
  const [socialProofDisplay, setSocialProofDisplay] = useState(GOYUNIR_STORE_SUITE.socialProof.baseCount);

  const [promoCode, setPromoCode] = useState<string | null>(null);
  const [promoDiscount, setPromoDiscount] = useState(0);
  const [manualPromoInput, setManualPromoInput] = useState('');
  const [promoMsg, setPromoMsg] = useState('');

  const TOTAL_IMAGES = GOYUNIR_STORE_SUITE.animationMechanics.totalFramesToLoad;
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  const heroContent = GOYUNIR_STORE_SUITE.heroContent;

  const currentProduct =
    requestedProduct && requestedIsArchived
      ? requestedProduct
      : allVisible[activeProductIndex] ?? allVisible[0] ?? GOYUNIR_STORE_SUITE.productCatalog[0];

  const isCurrentArchived = archivedProductIds.includes(currentProduct?.id);
  const isSoldOut = soldOutIds.includes(currentProduct?.id);

  // Merge: global admin override + product custom + product admin override
  const effectiveSchedule: DropScheduleConfig = useMemo(() => {
    const base = resolveProductSchedule(GOYUNIR_STORE_SUITE, currentProduct);
    const productOv = productOverrides[currentProduct?.id]?.customDropSchedule || {};
    return {
      ...base,
      ...(globalScheduleOverride || {}),
      ...productOv,
    } as DropScheduleConfig;
  }, [currentProduct, globalScheduleOverride, productOverrides]);

  const displayPrice = useMemo(() => {
    const ov = productOverrides[currentProduct?.id];
    if (selectedSize === '100ml') {
      return typeof ov?.price100ml === 'number' ? ov.price100ml : getProductPrice(currentProduct, selectedSize);
    }
    return typeof ov?.price50ml === 'number' ? ov.price50ml : getProductPrice(currentProduct, selectedSize);
  }, [currentProduct, selectedSize, productOverrides]);

  const discountedPrice =
    promoDiscount > 0 ? Math.max(1, Math.round(displayPrice * (1 - promoDiscount / 100))) : displayPrice;

  const archiveNote = archiveNotesMap[currentProduct?.id] || '';
  const archiveFrom = archiveFromMap[currentProduct?.id] || '';

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFILL_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.email || p.shippingAddress) {
          setForm((prev) => ({
            ...prev,
            email: p.email || prev.email,
            shippingAddress: p.shippingAddress || prev.shippingAddress,
          }));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!initialSlug) return;
    const idx = allVisible.findIndex((p) => p.slug === initialSlug);
    if (idx >= 0 && idx !== activeProductIndex) setActiveProductIndex(idx);
  }, [initialSlug, archivedProductIds.join(',')]);

  useEffect(() => {
    if (typeof window === 'undefined' || !currentProduct?.slug) return;
    const path = `/${currentProduct.slug}`;
    if (window.location.pathname !== path) {
      window.history.replaceState({}, '', path + window.location.search);
    }
  }, [currentProduct?.slug]);

  // Sticky promo from ?ref= or sessionStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlRef = (searchParams?.get('ref') || '').toUpperCase();
    const stored = (window.sessionStorage.getItem(PROMO_REF_KEY) || '').toUpperCase();
    const code = urlRef || stored;
    if (!code) return;
    if (urlRef) window.sessionStorage.setItem(PROMO_REF_KEY, urlRef);
    fetch(`/api/promo/validate?code=${encodeURIComponent(code)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          setPromoCode(data.code);
          setPromoDiscount(Number(data.customerDiscountPercent) || 0);
          setPromoMsg(`${data.code} applied`);
        }
      })
      .catch(() => {});
  }, [searchParams]);

  const applyManualPromo = async () => {
    const code = manualPromoInput.trim().toUpperCase();
    if (!code) return;
    try {
      const res = await fetch(`/api/promo/validate?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.valid) {
        setPromoCode(data.code);
        setPromoDiscount(Number(data.customerDiscountPercent) || 0);
        window.sessionStorage.setItem(PROMO_REF_KEY, data.code);
        setPromoMsg(`${data.code} applied`);
      } else {
        setPromoMsg(data.error || 'Invalid code');
        setPromoCode(null);
        setPromoDiscount(0);
      }
    } catch {
      setPromoMsg('Could not validate code');
    }
  };

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
  // Gentle grow then hold (not endless scale) — better for perfume UX
  const bottleScale = useTransform(scrollYProgress, [0, 0.35, 0.55], [1, 1.12, 1.18]);
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
        setFeedbackMessage('Taking longer than expected. Check your connection and try again.');
      }, 12000);
      return () => clearTimeout(stallTimer);
    }
    const dismissTimer = setTimeout(() => setFeedbackMessage(''), 9000);
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
        liveTelemetryTimer = setInterval(syncLiveAnalytics, 60000);
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
              setFeedbackMessage(data.message || 'Entry locked in. Good luck.');
              try {
                localStorage.setItem(
                  PREFILL_KEY,
                  JSON.stringify({
                    email: form.email || data.email,
                    shippingAddress: form.shippingAddress || data.address,
                  }),
                );
              } catch {}
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              setFeedbackStatus('error');
              setFeedbackMessage(data.error || 'Could not confirm payment details.');
            }
          })
          .catch(() => {
            setFeedbackStatus('error');
            setFeedbackMessage('Unable to reach verification servers.');
          });
      }
      if (isCancel) {
        setFeedbackStatus('notice');
        setFeedbackMessage('Setup canceled — finish when you’re ready to enter.');
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
      setTimeLeft({
        d: Math.floor(delta / 86400000),
        h: Math.floor((delta % 86400000) / 3600000),
        m: Math.floor((delta % 3600000) / 60000),
        s: Math.floor((delta % 60000) / 1000),
        expired: false,
      });
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
    JSON.stringify(globalScheduleOverride),
    currentProduct?.id,
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
      img.src = `/images/${currentProduct.prefix}/${i}.jpeg`;
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
      setFeedbackMessage('Add a valid email and shipping address.');
      return;
    }
    setIsProcessing(true);
    setFeedbackStatus('loading');
    setFeedbackMessage('Securing your entry…');
    try {
      const ref =
        promoCode ||
        (typeof window !== 'undefined' ? window.sessionStorage.getItem(PROMO_REF_KEY) : '') ||
        searchParams?.get('ref') ||
        '';
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: currentProduct.name,
          size: selectedSize,
          email: normalizedForm.email,
          shippingAddress: normalizedForm.shippingAddress,
          quantityChosen: normalizedForm.quantity,
          ref,
          promoCode: ref,
        }),
      });
      const data = await response.json();
      if (data.alreadyEntered) {
        setFeedbackStatus('notice');
        setFeedbackMessage(data.error || 'Already entered for this scent.');
        try {
          localStorage.setItem(
            PREFILL_KEY,
            JSON.stringify({
              email: normalizedForm.email,
              shippingAddress: normalizedForm.shippingAddress,
            }),
          );
        } catch {}
        return;
      }
      if (response.ok) {
        try {
          localStorage.setItem(
            PREFILL_KEY,
            JSON.stringify({
              email: normalizedForm.email,
              shippingAddress: normalizedForm.shippingAddress,
            }),
          );
        } catch {}
        if (data.sessionUrl) {
          window.location.assign(data.sessionUrl);
          return;
        }
        setFeedbackStatus('success');
        setFeedbackMessage(data.message || 'Entry secured.');
      } else {
        setFeedbackStatus('error');
        setFeedbackMessage(data.error || data.message || 'Registration failed.');
      }
    } catch (error) {
      setFeedbackStatus('error');
      setFeedbackMessage(error instanceof Error ? error.message : 'Connection timeout.');
    } finally {
      setIsProcessing(false);
    }
  };

  const switchProduct = (idx: number) => {
    const prod = allVisible[idx];
    if (!prod?.slug) return;
    if (typeof window !== 'undefined') window.location.href = `/${prod.slug}`;
  };

  const bannerColor =
    feedbackStatus === 'success'
      ? '#34c759'
      : feedbackStatus === 'notice'
        ? '#edb210'
        : feedbackStatus === 'error'
          ? '#ff6b5a'
          : '#9ca3af';

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
          height: 56,
          borderBottom: `1px solid ${configPalette.cardBorder}`,
          background: 'rgba(10,10,10,0.72)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          padding: '0 16px',
          zIndex: 100,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 600 }}>
          <Link href="/catalog" style={{ color: '#ccc', textDecoration: 'none' }}>
            CATALOG
          </Link>
          <Link href="/story" style={{ color: '#666', textDecoration: 'none' }}>
            STORY
          </Link>
        </div>
        <div
          style={{
            fontWeight: 'bold',
            letterSpacing: 4,
            fontSize: 12,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}
        >
          GOYUNIR
        </div>
        <div />
      </header>

      <AnimatePresence>
        {feedbackMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -10, x: '-50%' }}
            style={{
              position: 'fixed',
              top: 66,
              left: '50%',
              zIndex: 99,
              fontSize: 11,
              fontWeight: 600,
              background: 'rgba(0,0,0,0.9)',
              padding: '10px 16px',
              borderRadius: 16,
              maxWidth: '92vw',
              color: bannerColor,
              border: `1px solid ${bannerColor}`,
              textAlign: 'center',
            }}
          >
            {feedbackMessage}
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
          opacity: bottleOpacity,
          scale: bottleScale,
        }}
      >
        <canvas ref={canvasRef} style={{ width: '90vw', maxWidth: 300, height: 'auto', aspectRatio: '1/1' }} />
      </motion.div>

      <motion.div
        style={{
          position: 'fixed',
          bottom: '8vh',
          left: 0,
          width: '100%',
          display: 'flex',
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
            letterSpacing: 3,
            fontSize: 9,
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
            boxSizing: 'border-box',
          }}
        >
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <span
              style={{
                textTransform: 'uppercase',
                letterSpacing: 6,
                fontSize: 9,
                color: '#555',
                fontWeight: 'bold',
              }}
            >
              {heroContent.eyebrow}
            </span>
            <h1 style={{ fontSize: 36, margin: '10px 0', fontFamily: 'serif', letterSpacing: 1 }}>
              {currentProduct.name}
            </h1>
            {(isCurrentArchived || isSoldOut) && (
              <div
                style={{
                  display: 'inline-block',
                  marginBottom: 12,
                  padding: '6px 14px',
                  borderRadius: 20,
                  border: '1px solid #f59e0b',
                  color: '#f59e0b',
                  fontSize: 11,
                  fontWeight: 'bold',
                }}
              >
                {isSoldOut ? 'Sold out' : 'Archived'} — stay entered for the return
              </div>
            )}
            {(archiveNote || archiveFrom) && isCurrentArchived && (
              <p style={{ maxWidth: 320, margin: '0 auto 12px', fontSize: 12, color: '#999' }}>
                {archiveFrom ? `Expected: ${archiveFrom}. ` : ''}
                {archiveNote}
              </p>
            )}
            <p
              style={{
                maxWidth: 300,
                color: configPalette.textMuted,
                lineHeight: 1.7,
                fontSize: 13,
                margin: '0 auto 24px',
              }}
            >
              {heroContent.body}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {allVisible.map((prod, idx) => {
                const isSelected =
                  !isCurrentArchived && (prod.slug === currentProduct?.slug || activeProductIndex === idx);
                return (
                  <button
                    key={prod.id}
                    type="button"
                    onClick={() => switchProduct(idx)}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 20,
                      border: isSelected
                        ? `1px solid ${configPalette.textMain}`
                        : `1px solid ${configPalette.cardBorder}`,
                      background: isSelected ? configPalette.textMain : 'transparent',
                      color: isSelected ? configPalette.primaryBackground : configPalette.textMuted,
                      fontSize: 11,
                      fontWeight: 'bold',
                      cursor: 'pointer',
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
                    maxWidth: 170,
                    background: 'rgba(15,15,15,0.92)',
                    padding: 12,
                    borderRadius: 12,
                    border: `1px solid ${activeColor}`,
                  }}
                >
                  <span
                    style={{
                      fontSize: 8,
                      color: activeColor,
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      letterSpacing: 1,
                    }}
                  >
                    {note.label} / 0{idx + 1}
                  </span>
                  <h4 style={{ fontSize: 14, margin: '4px 0', fontWeight: 'bold' }}>{note.name}</h4>
                  <p style={{ color: '#ccc', fontSize: 11, margin: 0, lineHeight: 1.4 }}>{note.text}</p>
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
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 380,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
              marginBottom: 80,
            }}
          >
            <div style={{ ...frostCard, padding: 14, borderRadius: 14, textAlign: 'center' }}>
              {timeLeft.expired || isCurrentArchived ? (
                <div>
                  <span style={{ fontSize: 11, color: '#edb210', fontWeight: 'bold', letterSpacing: 1 }}>
                    {isCurrentArchived ? 'Archived — still in for the return' : 'Between draws'}
                  </span>
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: '#666' }}>
                    Check email if selected. Charged only if selected.
                  </p>
                </div>
              ) : (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      gap: 12,
                      fontFamily: 'monospace',
                      fontSize: 16,
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
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: '#666' }}>
                    After each draw, check email if selected.
                  </p>
                </>
              )}
            </div>

            <div style={{ ...frostCard, padding: 14, borderRadius: 14, textAlign: 'center' }}>
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  color: configPalette.accentPurple,
                  fontWeight: 'bold',
                  marginBottom: 6,
                }}
              >
                {GOYUNIR_STORE_SUITE.socialProof.label}
              </div>
              <div style={{ fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' }}>
                {socialProofDisplay.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>
                {GOYUNIR_STORE_SUITE.socialProof.caption}
              </div>
            </div>

            <h2 style={{ fontSize: 24, textAlign: 'center', fontFamily: 'serif', margin: 0 }}>
              {GOYUNIR_STORE_SUITE.raffleRegistrationForm.titleHeader}
            </h2>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              style={{ ...frostCard, padding: '24px 20px', borderRadius: 24 }}
            >
              <h3 style={{ fontSize: 20, margin: '0 0 4px', fontFamily: 'serif', textAlign: 'center' }}>
                {currentProduct.name}
              </h3>
              <p
                style={{
                  color: configPalette.textMuted,
                  fontSize: 12,
                  margin: '0 0 20px',
                  textAlign: 'center',
                }}
              >
                {currentProduct.desc}
              </p>

              <form onSubmit={submitRaffleEntry} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {sizes.length > 1 ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {sizes.map((sz) => {
                      const isSelected = selectedSize === sz;
                      const ov = productOverrides[currentProduct?.id];
                      const p =
                        sz === '100ml'
                          ? typeof ov?.price100ml === 'number'
                            ? ov.price100ml
                            : getProductPrice(currentProduct, sz)
                          : typeof ov?.price50ml === 'number'
                            ? ov.price50ml
                            : getProductPrice(currentProduct, sz);
                      return (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setSelectedSize(sz)}
                          style={{
                            flex: 1,
                            padding: 12,
                            borderRadius: 12,
                            border: isSelected ? '2px solid #fff' : `1px solid ${configPalette.cardBorder}`,
                            background: isSelected ? '#fff' : 'transparent',
                            color: isSelected ? '#000' : configPalette.textMain,
                            fontSize: 13,
                            fontWeight: 'bold',
                            cursor: 'pointer',
                          }}
                        >
                          {sz} — ${p}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}>
                    {sizes[0]} —{' '}
                    {promoDiscount > 0 ? (
                      <>
                        <span style={{ textDecoration: 'line-through', color: '#666', marginRight: 6 }}>
                          ${displayPrice}
                        </span>
                        <span style={{ color: '#edb210' }}>${discountedPrice}</span>
                      </>
                    ) : (
                      <>${displayPrice}</>
                    )}
                  </div>
                )}

                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                  placeholder={GOYUNIR_STORE_SUITE.raffleRegistrationForm.emailPlaceholder}
                  autoComplete="email"
                  style={{
                    width: '100%',
                    padding: 14,
                    borderRadius: 12,
                    background: 'rgba(22,22,26,0.7)',
                    border: `1px solid ${configPalette.cardBorder}`,
                    color: configPalette.textMain,
                    fontSize: 13,
                    boxSizing: 'border-box',
                  }}
                />
                <input
                  required
                  type="text"
                  value={form.shippingAddress}
                  onChange={(e) => setForm((prev) => ({ ...prev, shippingAddress: e.target.value }))}
                  placeholder="Full address + ZIP (e.g. 123 Main St, LA, CA 90001)"
                  autoComplete="street-address"
                  style={{
                    width: '100%',
                    padding: 14,
                    borderRadius: 12,
                    background: 'rgba(22,22,26,0.7)',
                    border: `1px solid ${configPalette.cardBorder}`,
                    color: configPalette.textMain,
                    fontSize: 13,
                    boxSizing: 'border-box',
                  }}
                />

                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={manualPromoInput}
                    onChange={(e) => setManualPromoInput(e.target.value.toUpperCase())}
                    placeholder="Have a promo code?"
                    style={{
                      flex: 1,
                      padding: 12,
                      borderRadius: 12,
                      background: 'rgba(22,22,26,0.7)',
                      border: `1px solid ${configPalette.cardBorder}`,
                      color: configPalette.textMain,
                      fontSize: 12,
                      boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="button"
                    onClick={applyManualPromo}
                    style={{
                      padding: '0 14px',
                      borderRadius: 12,
                      border: `1px solid ${configPalette.cardBorder}`,
                      background: 'transparent',
                      color: '#ccc',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Apply
                  </button>
                </div>
                {(promoCode || promoMsg) && (
                  <p style={{ margin: 0, fontSize: 11, color: promoCode ? '#edb210' : '#f87171', textAlign: 'center' }}>
                    {promoCode
                      ? `${promoCode} applied${promoDiscount > 0 ? ` — ${promoDiscount}% off if selected` : ''}`
                      : promoMsg}
                  </p>
                )}

                <p style={{ margin: 0, fontSize: 11, color: configPalette.textMuted, textAlign: 'center' }}>
                  Card saved — charged only if selected. One entry per email.
                </p>
                <button
                  type="submit"
                  disabled={isProcessing}
                  style={{
                    width: '100%',
                    padding: 16,
                    borderRadius: 30,
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
                    fontSize: 14,
                    cursor: isProcessing ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isProcessing
                    ? GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonLoadingText
                    : timeLeft.expired || isCurrentArchived
                      ? 'Stay entered for the return'
                      : GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonText}
                </button>
              </form>
            </motion.div>
          </div>

          <footer
            style={{
              width: '100%',
              maxWidth: 380,
              borderTop: `1px solid ${configPalette.cardBorder}`,
              paddingTop: 40,
              color: configPalette.textMuted,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px' }}>CONNECT</p>
                <a
                  href={GOYUNIR_STORE_SUITE.brandFooterData.instagramLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#888', display: 'block', textDecoration: 'none', marginBottom: 6 }}
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
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px' }}>SUPPORT</p>
                <span style={{ color: '#888', display: 'block', marginBottom: 6 }}>
                  {GOYUNIR_STORE_SUITE.brandFooterData.supportEmail}
                </span>
                <Link href="/account" style={{ color: '#888', display: 'block', marginBottom: 6 }}>
                  Manage My Entry
                </Link>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', fontSize: 10 }}>
              <a href="/terms" style={{ color: '#555' }}>
                Terms
              </a>
              <a href="/privacy" style={{ color: '#555' }}>
                Privacy
              </a>
              <a href="/shipping" style={{ color: '#555' }}>
                Shipping
              </a>
            </div>
            <div style={{ textAlign: 'center', color: '#333', fontSize: 10, marginTop: 24 }}>
              © {new Date().getFullYear()} {GOYUNIR_STORE_SUITE.brandFooterData.corporateEntityCopyright}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}