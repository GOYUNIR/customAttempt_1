'use client';

import Link from 'next/link';
import { useRef, useEffect, useState } from 'react';
import { useScroll, useTransform, motion, AnimatePresence } from 'framer-motion';
import { useSearchParams } from 'next/navigation';
import { EntryFormState, isValidEmail, normalizeEntryForm } from '@/lib/validation';

interface TimeLeftState {
  d: number;
  h: number;
  m: number;
  s: number;
  expired: boolean;
}

interface StoreProduct {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  isActive: boolean;
  isArchived: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  totalInventory: number;
  winnerTiers: number[];
  createdAt?: string;
  updatedAt?: string;
}

interface StoreConfig {
  themeColors: {
    primaryBackground: string;
    cardBackground: string;
    cardBorder: string;
    accentPurple: string;
    accentBlue: string;
    textMain: string;
    textMuted: string;
    checkoutCtaButton: string;
  };
  availableSizes: string[];
  homeRedirectSlug?: string;
  dropSchedule: {
    mode: 'fixed' | 'daily' | 'weekly' | 'monthly';
    timezone: string;
    targetEndDateTime: string;
    drawDayOfWeek: number;
    drawDayOfMonth: number;
    drawHour: number;
    drawMinute: number;
    drawSecond?: number;
    countdownExpiredText: string;
    daysLabel: string;
    hoursLabel: string;
    minutesLabel: string;
    secondsLabel: string;
    winnersPer50ml: number;
    winnersPer100ml: number;
  };
  animationMechanics: {
    totalFramesToLoad: number;
    maxRotationDegrees: number;
    spinReverseOnAlternatingProgress: boolean;
    spinCyclesTopToCheckout: number;
  };
  raffleRegistrationForm: {
    titleHeader: string;
    emailLabel: string;
    emailPlaceholder: string;
    addressLabel: string;
    addressPlaceholder: string;
    submitButtonText: string;
    submitButtonLoadingText: string;
  };
  heroContent: {
    eyebrow: string;
    headline: string;
    body: string;
    ctaLabel: string;
  };
  socialProof: {
    label: string;
    baseCount: number;
    caption: string;
    autoIncrementEnabled: boolean;
    autoIncrementChancePerHeartbeat: number;
    autoIncrementAmount: number;
    autoIncrementMaxPerDay: number;
    autoIncrementMinHourGap: number;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
  };
  catalogPreview: {
    upcomingDrops: any[];
    archiveScents: any[];
  };
  productCatalog: StoreProduct[];
}

const DEFAULT_CONFIG: StoreConfig = {
  themeColors: {
    primaryBackground: '#0a0a0a',
    cardBackground: '#111111',
    cardBorder: '#222222',
    accentPurple: '#a855f7',
    accentBlue: '#3b82f6',
    textMain: '#ffffff',
    textMuted: '#888888',
    checkoutCtaButton: '#635bff',
  },
  availableSizes: ['50ml'],
  homeRedirectSlug: 'elysian-white',
  dropSchedule: {
    mode: 'daily',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', 'T') + ':00',
    drawDayOfWeek: 6,
    drawDayOfMonth: 1,
    drawHour: 21,
    drawMinute: 0,
    drawSecond: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd',
    hoursLabel: 'h',
    minutesLabel: 'm',
    secondsLabel: 's',
    winnersPer50ml: 10,
    winnersPer100ml: 5,
  },
  animationMechanics: {
    totalFramesToLoad: 29,
    maxRotationDegrees: 360,
    spinReverseOnAlternatingProgress: false,
    spinCyclesTopToCheckout: 1,
  },
  raffleRegistrationForm: {
    titleHeader: 'Join The Allocation Draw',
    emailLabel: 'Contact Email Address',
    emailPlaceholder: 'name@domain.com',
    addressLabel: 'Full Shipping Destination',
    addressPlaceholder: '123 Luxury Dr, New York, NY',
    submitButtonText: '🏆 Secure Entry Allocation Ticket',
    submitButtonLoadingText: 'Encrypting Entry Base...',
  },
  heroContent: {
    eyebrow: 'The Architecture of Scent',
    headline: 'A drop that moves faster than attention itself.',
    body: 'We design fragrances that move faster than time itself.',
    ctaLabel: '↓ Scroll To Explore',
  },
  socialProof: {
    label: 'Limited drop access',
    baseCount: 0,
    caption: 'Hype is compounding fast—reserve now before inventory closes.',
    autoIncrementEnabled: true,
    autoIncrementChancePerHeartbeat: 0.15,
    autoIncrementAmount: 1,
    autoIncrementMaxPerDay: 4,
    autoIncrementMinHourGap: 3,
  },
  brandFooterData: {
    instagramLink: 'https://instagram.com/goyunir',
    tiktokLink: 'https://tiktok.com/goyunir',
    supportEmail: 'goyunir.support@gmail.com',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
  },
  catalogPreview: {
    upcomingDrops: [],
    archiveScents: [],
  },
  productCatalog: [],
};

const PREFILL_KEY = 'goyunir_entry_prefill';

const paperTexture: React.CSSProperties = {
  backgroundColor: '#0d0d0f',
  backgroundImage: `
    radial-gradient(circle at 20% 30%, rgba(255,255,255,0.025) 0%, transparent 40%),
    radial-gradient(circle at 80% 15%, rgba(255,255,255,0.02) 0%, transparent 35%),
    radial-gradient(circle at 60% 75%, rgba(255,255,255,0.03) 0%, transparent 45%),
    radial-gradient(circle at 10% 85%, rgba(255,255,255,0.018) 0%, transparent 40%),
    linear-gradient(135deg, rgba(255,255,255,0.015) 0%, transparent 50%, rgba(0,0,0,0.15) 100%)
  `,
};

export default function Storefront({ initialSlug }: { initialSlug?: string }) {
  const searchParams = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<StoreConfig>(DEFAULT_CONFIG);
  const [allProducts, setAllProducts] = useState<StoreProduct[]>([]);
  const [activeProducts, setActiveProducts] = useState<StoreProduct[]>([]);
  const [archivedProducts, setArchivedProducts] = useState<StoreProduct[]>([]);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [archiveNotesMap, setArchiveNotesMap] = useState<Record<string, string>>({});
  const [archiveFromMap, setArchiveFromMap] = useState<Record<string, string>>({});
  const [productOverrides, setProductOverrides] = useState<Record<string, any>>({});
  const [globalScheduleOverride, setGlobalScheduleOverride] = useState<any>(null);

  // Load config from API
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch('/api/store/config');
        const data = await res.json();
        console.log('[Storefront] Loaded config:', data);
        
        if (data.config) {
          setConfig({
            ...DEFAULT_CONFIG,
            ...data.config,
            themeColors: { ...DEFAULT_CONFIG.themeColors, ...data.config.themeColors },
            dropSchedule: { ...DEFAULT_CONFIG.dropSchedule, ...data.config.dropSchedule, ...data.scheduleOverride },
            socialProof: { ...DEFAULT_CONFIG.socialProof, ...data.config.socialProof, ...data.socialOverride },
          });
        }
        
        if (data.activeProducts && data.activeProducts.length > 0) {
          console.log('[Storefront] Setting active products:', data.activeProducts);
          setActiveProducts(data.activeProducts);
          setAllProducts(data.allProducts || data.activeProducts);
          setArchivedProducts(data.archivedProducts || []);
          const ids = (data.archivedProducts || []).map((p: any) => p.id);
          setArchivedIds(ids);
        } else {
          console.log('[Storefront] No active products found, using fallback');
          const fallbackProducts = getDefaultProducts();
          setActiveProducts(fallbackProducts);
          setAllProducts(fallbackProducts);
          setArchivedProducts([]);
          setArchivedIds([]);
        }
        
        if (data.scheduleOverride) setGlobalScheduleOverride(data.scheduleOverride);
      } catch (err) {
        console.error('[Storefront] Failed to load store config:', err);
        const fallbackProducts = getDefaultProducts();
        setActiveProducts(fallbackProducts);
        setAllProducts(fallbackProducts);
      } finally {
        setLoading(false);
      }
    }
    loadConfig();
  }, []);

  // Update archived IDs when products change
  useEffect(() => {
    const ids = archivedProducts.map(p => p.id);
    setArchivedIds(ids);
  }, [archivedProducts]);

  const sizes = config.availableSizes || ['50ml'];
  const defaultSize = sizes.includes('100ml') && searchParams?.get('size') === '100ml' ? '100ml' : sizes[0] || '50ml';

  const allVisible = activeProducts.filter((p) => p.isActive !== false && !archivedIds.includes(p.id));

  const requestedProduct = initialSlug 
    ? allProducts.find((p) => p.slug === initialSlug) || activeProducts.find((p) => p.slug === initialSlug)
    : undefined;
  const requestedIsArchived = requestedProduct ? archivedIds.includes(requestedProduct.id) : false;

  const [activeProductIndex, setActiveProductIndex] = useState(() => {
    if (requestedProduct && !requestedIsArchived) {
      const idx = allVisible.findIndex((p) => p.id === requestedProduct.id);
      if (idx >= 0) return idx;
    }
    return 0;
  });

  const [selectedSize, setSelectedSize] = useState(defaultSize);
  const [isProcessing, setIsProcessing] = useState(false);
  const [form, setForm] = useState<EntryFormState>({ email: '', shippingAddress: '', quantity: 1 });
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'loading' | 'success' | 'notice' | 'error'>('idle');
  const [timeLeft, setTimeLeft] = useState<TimeLeftState>({ d: 0, h: 0, m: 0, s: 0, expired: false });
  const [socialProofDisplay, setSocialProofDisplay] = useState(config.socialProof?.baseCount || 0);

  const [promoCode, setPromoCode] = useState<string | null>(null);
  const [promoDiscount, setPromoDiscount] = useState<number>(0);
  const [manualPromoInput, setManualPromoInput] = useState('');
  const [showManualPromo, setShowManualPromo] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<string[]>([]);
  const [promoValidated, setPromoValidated] = useState<boolean>(false);
  const [promoErrorMessage, setPromoErrorMessage] = useState('');

  useEffect(() => {
    try {
      const hist = localStorage.getItem('goyunir_address_history');
      if (hist) {
        const arr = JSON.parse(hist);
        if (Array.isArray(arr)) setSavedAddresses(arr.filter(Boolean).slice(0, 8));
      }
    } catch {}
  }, []);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || typeof window === 'undefined') return;
    const existing = document.querySelector('script[data-goyunir-places]');
    const boot = () => {
      try {
        const input = document.getElementById('goyunir-shipping-address') as HTMLInputElement | null;
        if (!input || !(window as any).google?.maps?.places) return;
        const ac = new (window as any).google.maps.places.Autocomplete(input, {
          fields: ['formatted_address', 'address_components'],
          types: ['address'],
        });
        ac.addListener('place_changed', () => {
          const place = ac.getPlace();
          const formatted = place?.formatted_address;
          if (formatted) {
            setForm((prev) => ({ ...prev, shippingAddress: formatted }));
          }
        });
      } catch {}
    };
    if (existing) {
      boot();
      return;
    }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async`;
    s.async = true;
    s.dataset.goyunirPlaces = '1';
    s.onload = () => boot();
    document.head.appendChild(s);
  }, []);

  // Determine which product to display
  const currentProductIndex = (() => {
    if (requestedProduct && !requestedIsArchived) {
      const idx = allVisible.findIndex((p) => p.id === requestedProduct.id);
      if (idx >= 0) return idx;
    }
    return activeProductIndex;
  })();

  // Get the current product with fallback
  const getCurrentProduct = (): StoreProduct | null => {
    // First try the active product at the index
    const active = allVisible[currentProductIndex] || allVisible[0] || activeProducts[0];
    if (active) return active;
    
    // If we have a requested slug, find it in all products
    if (initialSlug) {
      const found = allProducts.find(p => p.slug === initialSlug);
      if (found) return found;
      const archived = archivedProducts.find(p => p.slug === initialSlug);
      if (archived) return archived;
    }
    
    // Fallback to any product
    return allProducts[0] || activeProducts[0] || null;
  };

  const currentProduct = getCurrentProduct();
  const isCurrentArchived = currentProduct ? archivedIds.includes(currentProduct.id) : false;

  const priceFor = (product: StoreProduct | null, size: string) => {
    if (!product) return 0;
    const ov = productOverrides[product.id];
    if (size === '100ml' && typeof ov?.price100ml === 'number') return ov.price100ml;
    if (size !== '100ml' && typeof ov?.price50ml === 'number') return ov.price50ml;
    return size === '100ml' ? product.price100ml : product.price50ml;
  };

  const effectiveSchedule = {
    ...config.dropSchedule,
    ...(globalScheduleOverride || {}),
    ...(currentProduct ? productOverrides[currentProduct.id]?.customDropSchedule || {} : {}),
  };

  const archiveNote = currentProduct ? archiveNotesMap[currentProduct.id] || '' : '';
  const archiveFrom = currentProduct ? archiveFromMap[currentProduct.id] || '' : '';

  const TOTAL_IMAGES = config.animationMechanics?.totalFramesToLoad || 29;
  const configPalette = config.themeColors || DEFAULT_CONFIG.themeColors;
  const heroContent = config.heroContent || DEFAULT_CONFIG.heroContent;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFILL_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.email || p.shippingAddress) {
          setForm((prev) => ({ ...prev, email: p.email || prev.email, shippingAddress: p.shippingAddress || prev.shippingAddress }));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!initialSlug) return;
    const idx = allVisible.findIndex((p) => p.slug === initialSlug);
    if (idx >= 0 && idx !== activeProductIndex) setActiveProductIndex(idx);
  }, [initialSlug, archivedIds.join(',')]);

  useEffect(() => {
    if (typeof window === 'undefined' || !currentProduct?.slug) return;
    const path = `/${currentProduct.slug}`;
    if (window.location.pathname !== path) {
      window.history.replaceState({}, '', path + window.location.search);
    }
  }, [currentProduct?.slug]);

  const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end end'] });
  const cycles = Math.max(1, config.animationMechanics?.spinCyclesTopToCheckout || 1);
  const spinRange = 0.85;
  const framePositions: number[] = [0];
  const frameValues: number[] = [1];
  for (let i = 1; i <= cycles * 2; i++) {
    framePositions.push((spinRange / (cycles * 2)) * i);
    frameValues.push(i % 2 === 1 ? TOTAL_IMAGES : 1);
  }
  const frameIndex = useTransform(scrollYProgress, framePositions, frameValues);
  const bottleOpacity = useTransform(scrollYProgress, [0.72, 0.92], [1, 0]);
  const bottleScale = useTransform(scrollYProgress, [0, 0.25, 0.55, 0.75], [1, 1.28, 1.58, 1.72]);
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
        .then((data) => { if (typeof data.socialProofDisplay === 'number') setSocialProofDisplay(data.socialProofDisplay); })
        .catch(() => {});
    };
    let liveTelemetryTimer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!liveTelemetryTimer) { syncLiveAnalytics(); liveTelemetryTimer = setInterval(syncLiveAnalytics, 60000); } };
    const stop = () => { if (liveTelemetryTimer) { clearInterval(liveTelemetryTimer); liveTelemetryTimer = null; } };
    const handleVisibility = () => { if (document.visibilityState === 'visible') start(); else stop(); };
    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', handleVisibility); };
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
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
        })
          .then(async (res) => {
            const data = await res.json();
            if (res.ok && data.success) {
              setFeedbackStatus('success');
              setFeedbackMessage(data.message || '🎉 You\'re in! Your entry is locked. Good luck!');
              if (data.promoCode) {
                setPromoCode(data.promoCode);
                setPromoDiscount(data.discountPercent || 0);
                setPromoValidated(true);
              } else {
                setPromoCode(null);
                setPromoDiscount(0);
                setPromoValidated(false);
                try { window.sessionStorage.removeItem('goyunir_promo_ref'); } catch {}
              }
              try {
                localStorage.setItem(PREFILL_KEY, JSON.stringify({ email: form.email || data.email, shippingAddress: form.shippingAddress || data.address }));
              } catch {}
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              setFeedbackStatus('error');
              setFeedbackMessage(data.error || 'Could not confirm payment details.');
            }
          })
          .catch(() => { setFeedbackStatus('error'); setFeedbackMessage('Unable to reach verification servers.'); });
      }
      if (isCancel) {
        setFeedbackStatus('notice');
        setFeedbackMessage("Setup canceled — finish checkout when you're ready to enter.");
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
        if (delta <= 0 && !isCurrentArchived) {
          try {
            const k = 'goyunir_draw_ping_' + (currentProduct?.slug || 'x');
            if (!sessionStorage.getItem(k)) {
              sessionStorage.setItem(k, '1');
              setFeedbackStatus('notice');
              setFeedbackMessage('Allocation window closed. If you entered, watch your email — selected entries are charged when the draw processes.');
              fetch('/api/cron/auto-draw?ping=1').catch(() => {});
            }
          } catch {}
        }
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
    effectiveSchedule.mode, effectiveSchedule.targetEndDateTime, effectiveSchedule.drawDayOfWeek,
    effectiveSchedule.drawDayOfMonth, effectiveSchedule.drawHour, effectiveSchedule.drawMinute,
    effectiveSchedule.timezone, isCurrentArchived,
  ]);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context || !canvasRef.current) return;
    
    // If no currentProduct, draw placeholder and return
    if (!currentProduct) {
      context.fillStyle = '#1a1a1a';
      context.fillRect(0, 0, 600, 600);
      context.fillStyle = '#444';
      context.font = '24px system-ui';
      context.textAlign = 'center';
      context.fillText('No Product', 300, 300);
      return;
    }
    
    const preloadedImages: HTMLImageElement[] = [];
    canvasRef.current.width = 600;
    canvasRef.current.height = 600;
    
    const drawFrame = (img: HTMLImageElement) => {
      if (img.complete && img.naturalWidth > 0) {
        context.clearRect(0, 0, 600, 600);
        context.drawImage(img, 0, 0, 600, 600);
      }
    };
    
    const drawPlaceholder = () => {
      context.fillStyle = '#1a1a1a';
      context.fillRect(0, 0, 600, 600);
      context.fillStyle = '#444';
      context.font = '24px system-ui';
      context.textAlign = 'center';
      context.fillText('Loading Image', 300, 300);
    };
    
    const productPrefix = currentProduct.prefix || 'default';
    const images = currentProduct.images || [];
    const imageUrls = images.length > 0 
      ? images 
      : Array.from({ length: TOTAL_IMAGES }, (_, i) => `/images/${productPrefix}/${i + 1}.jpeg`);
    
    let loadedCount = 0;
    const totalImages = Math.min(imageUrls.length, TOTAL_IMAGES);
    
    for (let i = 0; i < totalImages; i++) {
      const img = new Image();
      const imgUrl = imageUrls[i] || `/images/${productPrefix}/${i + 1}.jpeg`;
      img.src = imgUrl;
      img.onload = () => {
        loadedCount++;
        if (loadedCount === 1) {
          drawFrame(img);
        }
      };
      img.onerror = () => {
        if (i === 0) {
          const fallbackImg = new Image();
          fallbackImg.src = `/images/${productPrefix}/1.jpeg`;
          fallbackImg.onload = () => {
            loadedCount++;
            drawFrame(fallbackImg);
          };
          fallbackImg.onerror = () => {
            loadedCount++;
            drawPlaceholder();
          };
          preloadedImages.push(fallbackImg);
        } else {
          loadedCount++;
          if (loadedCount === totalImages && preloadedImages.length > 0) {
            drawFrame(preloadedImages[0]);
          }
        }
      };
      preloadedImages.push(img);
    }
    
    const unsubscribe = frameIndex.on('change', (value) => {
      const index = Math.min(Math.max(Math.round(value), 1), preloadedImages.length);
      const activeFrameImage = preloadedImages[index - 1];
      if (activeFrameImage && activeFrameImage.complete && activeFrameImage.naturalWidth > 0) {
        drawFrame(activeFrameImage);
      }
    });
    return () => unsubscribe();
  }, [frameIndex, activeProductIndex, TOTAL_IMAGES, currentProduct?.prefix, currentProduct?.id, currentProduct?.images]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlRef = searchParams?.get('ref');
    const stored = window.sessionStorage.getItem('goyunir_promo_ref');
    const code = (urlRef || stored || '').toUpperCase();
    if (!code) return;

    if (urlRef) window.sessionStorage.setItem('goyunir_promo_ref', urlRef.toUpperCase());

    fetch(`/api/promo/validate?code=${encodeURIComponent(code)}&email=${encodeURIComponent(form.email || '')}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          setPromoCode(data.code);
          setPromoDiscount(data.customerDiscountPercent || 0);
          setPromoValidated(true);
          setPromoErrorMessage('');
        } else {
          window.sessionStorage.removeItem('goyunir_promo_ref');
          setPromoValidated(false);
          setPromoErrorMessage(data.error || 'Invalid promo code');
          if (data.alreadyUsed) {
            setFeedbackStatus('error');
            setFeedbackMessage(`❌ Promo code ${code} has already been used with this email address.`);
          }
        }
      })
      .catch(() => {});
  }, [searchParams, form.email]);

  const applyManualPromo = () => {
    const code = manualPromoInput.trim().toUpperCase();
    if (!code) return;
    
    fetch(`/api/promo/validate?code=${encodeURIComponent(code)}&email=${encodeURIComponent(form.email || '')}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          window.sessionStorage.setItem('goyunir_promo_ref', code);
          setPromoCode(data.code);
          setPromoDiscount(data.customerDiscountPercent || 0);
          setPromoValidated(true);
          setPromoErrorMessage('');
          setManualPromoInput('');
          setShowManualPromo(false);
          setFeedbackStatus('success');
          setFeedbackMessage(`✅ Promo ${data.code} applied! ${data.customerDiscountPercent > 0 ? `${data.customerDiscountPercent}% off if selected.` : ''}`);
        } else {
          setFeedbackStatus('error');
          setFeedbackMessage(data.alreadyUsed ? `❌ This code has already been used with this email address.` : "That code isn't valid or is no longer active.");
          window.sessionStorage.removeItem('goyunir_promo_ref');
          setPromoValidated(false);
          setPromoErrorMessage(data.error || 'Invalid promo code');
        }
      })
      .catch(() => {});
  };

  const clearPromo = () => {
    setPromoCode(null);
    setPromoDiscount(0);
    setPromoValidated(false);
    window.sessionStorage.removeItem('goyunir_promo_ref');
    setManualPromoInput('');
    setShowManualPromo(false);
    setFeedbackStatus('notice');
    setFeedbackMessage('Promo code removed.');
  };

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
      const ref = promoCode || searchParams?.get('ref') || '';
      const response = await fetch('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: currentProduct?.name || 'Product',
          size: selectedSize,
          email: normalizedForm.email,
          shippingAddress: normalizedForm.shippingAddress,
          quantityChosen: normalizedForm.quantity,
          promoCode: ref || undefined,
          ref: ref || undefined,
        }),
      });
      const data = await response.json();
      if (data.alreadyEntered) {
        setFeedbackStatus('notice');
        setFeedbackMessage(data.error || 'Already entered for this scent.');
        try {
          localStorage.setItem(PREFILL_KEY, JSON.stringify({ email: normalizedForm.email, shippingAddress: normalizedForm.shippingAddress }));
        } catch {}
        return;
      }
      if (response.ok) {
        try {
          localStorage.setItem(PREFILL_KEY, JSON.stringify({ email: normalizedForm.email, shippingAddress: normalizedForm.shippingAddress }));
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
    feedbackStatus === 'success' ? '#34c759' : feedbackStatus === 'notice' ? '#edb210' : feedbackStatus === 'error' ? '#ff6b5a' : '#9ca3af';

  if (loading) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: configPalette?.primaryBackground || '#0a0a0a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, letterSpacing: 4, textTransform: 'uppercase', color: '#666' }}>Loading</div>
          <div style={{ marginTop: 12, width: 40, height: 2, background: '#a855f7', margin: '12px auto' }} />
        </div>
      </div>
    );
  }

  if (!currentProduct) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        background: configPalette?.primaryBackground || '#0a0a0a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        color: '#fff',
        gap: 16
      }}>
        <div style={{ fontSize: 20, color: '#666' }}>No products available</div>
        <Link href="/catalog" style={{ color: '#a855f7', textDecoration: 'none' }}>View Catalog →</Link>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ background: configPalette.primaryBackground, color: configPalette.textMain, position: 'relative', width: '100%', minHeight: '450vh' }}>
      <header
        style={{
          position: 'fixed', 
          top: 0, 
          left: 0, 
          width: '100%', 
          height: '56px', 
          borderBottom: `1px solid ${configPalette.cardBorder}`,
          background: 'rgba(10,10,10,0.88)', 
          backdropFilter: 'blur(15px)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          padding: '0 16px', 
          zIndex: 100, 
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 600 }}>
          <Link href="/catalog" style={{ color: '#ccc', textDecoration: 'none' }}>CATALOG</Link>
          <Link href="/story" style={{ color: '#666', textDecoration: 'none' }}>STORY</Link>
        </div>

        <Link
          href="/"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            fontWeight: 'bold',
            letterSpacing: '4px',
            fontSize: '12px',
            textTransform: 'uppercase',
            color: configPalette.textMain,
            textDecoration: 'none',
          }}
        >
          GOYUNIR
        </Link>
        
        <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 600 }}>
          <Link href="/account" style={{ color: '#666', textDecoration: 'none' }}>ACCOUNT</Link>
        </div>
      </header>

      <AnimatePresence>
        {feedbackMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: -10, x: '-50%' }}
            style={{
              position: 'fixed', top: '66px', left: '50%', zIndex: 99, fontSize: '11px', fontWeight: 600, letterSpacing: '0.3px',
              background: 'rgba(0,0,0,0.9)', padding: '10px 16px', borderRadius: '16px', maxWidth: '92vw',
              color: bannerColor, border: `1px solid ${bannerColor}`, textAlign: 'center',
            }}
          >
            {feedbackMessage}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        style={{ position: 'fixed', top: '48vh', left: 0, width: '100%', height: '35vh', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, pointerEvents: 'none', opacity: bottleOpacity, scale: bottleScale }}
      >
        <canvas ref={canvasRef} style={{ width: '90vw', maxWidth: '300px', height: 'auto', aspectRatio: '1/1' }} />
      </motion.div>

      <motion.div
        style={{ position: 'fixed', bottom: '8vh', left: 0, width: '100%', display: 'flex', justifyContent: 'center', zIndex: 15, pointerEvents: 'none', opacity: scrollIndicatorOpacity }}
      >
        <motion.span
          animate={{ y: [0, -10, 0] }} transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
          style={{ textTransform: 'uppercase', letterSpacing: '3px', fontSize: '9px', color: configPalette.textMuted, fontWeight: 'bold' }}
        >
          {heroContent.ctaLabel}
        </motion.span>
      </motion.div>

      <div style={{ position: 'relative', zIndex: 2, width: '100%' }}>
        <section style={{ height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'center', padding: '120px 20px 20px', textAlign: 'center', boxSizing: 'border-box' }}>
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '6px', fontSize: '9px', color: '#555', fontWeight: 'bold' }}>{heroContent.eyebrow}</span>
            <h1 style={{ fontSize: '36px', margin: '10px 0', fontFamily: 'serif', letterSpacing: '1px' }}>{currentProduct?.name || 'Product'}</h1>
            {isCurrentArchived && (
              <div style={{ display: 'inline-block', marginBottom: 12, padding: '6px 14px', borderRadius: 20, border: '1px solid #f59e0b', color: '#f59e0b', fontSize: 11, fontWeight: 'bold' }}>
                Archived — stay entered for the return
              </div>
            )}
            {(archiveNote || archiveFrom) && isCurrentArchived && (
              <p style={{ maxWidth: 320, margin: '0 auto 12px', fontSize: 12, color: '#999' }}>
                {archiveFrom ? `Expected: ${archiveFrom}. ` : ''}{archiveNote}
              </p>
            )}
            <p style={{ maxWidth: 300, color: configPalette.textMuted, lineHeight: 1.7, fontSize: 13, margin: '0 auto 24px' }}>{heroContent.body}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {allVisible.map((prod, idx) => {
                const isSelected = !isCurrentArchived && (prod.slug === currentProduct?.slug || activeProductIndex === idx);
                return (
                  <button key={prod.id} onClick={() => switchProduct(idx)}
                    style={{
                      padding: '8px 18px', borderRadius: 20,
                      border: isSelected ? `1px solid ${configPalette.textMain}` : `1px solid ${configPalette.cardBorder}`,
                      background: isSelected ? configPalette.textMain : 'transparent',
                      color: isSelected ? configPalette.primaryBackground : configPalette.textMuted,
                      fontSize: 11, fontWeight: 'bold', cursor: 'pointer',
                    }}>
                    {prod.name}
                  </button>
                );
              })}
            </div>
          </motion.div>
        </section>

        <div style={{ position: 'relative', width: '100%', paddingBottom: '15vh' }}>
          {currentProduct && currentProduct.notes && currentProduct.notes.length > 0 && currentProduct.notes.map((note, idx) => {
            const isLeft = idx % 2 === 0;
            const topOffset = 100 + idx * 90;
            const activeColor = idx % 2 === 0 ? configPalette.accentPurple : configPalette.accentBlue;
            return (
              <div key={idx} style={{ position: 'sticky', top: `${topOffset}px`, width: '100%', display: 'flex', justifyContent: isLeft ? 'flex-start' : 'flex-end', padding: '15px 20px', boxSizing: 'border-box' }}>
                <motion.div initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
                  style={{ maxWidth: 170, background: 'rgba(15,15,15,0.92)', padding: 12, borderRadius: 12, border: `1px solid ${activeColor}` }}>
                  <span style={{ fontSize: 8, color: activeColor, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1 }}>{note.label} / 0{idx + 1}</span>
                  <h4 style={{ fontSize: 14, margin: '4px 0', fontWeight: 'bold' }}>{note.name}</h4>
                  <p style={{ color: '#ccc', fontSize: 11, margin: 0, lineHeight: 1.4 }}>{note.text}</p>
                </motion.div>
              </div>
            );
          })}
        </div>

        <section style={{ 
          minHeight: '130vh', 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center', 
          padding: '100px 15px 40px', 
          background: 'rgba(10,10,10,0.88)', 
          backdropFilter: 'blur(15px)', 
          WebkitBackdropFilter: 'blur(15px)',
          position: 'relative', 
          zIndex: 10, 
          boxSizing: 'border-box' 
        }}>
          <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 24, marginBottom: 80 }}>
            <div style={{ background: 'rgba(20,20,22,0.8)', backdropFilter: 'blur(10px)', padding: 14, borderRadius: 14, border: `1px solid ${configPalette.cardBorder}`, textAlign: 'center' }}>
              {timeLeft.expired || isCurrentArchived ? (
                <div>
                  <span style={{ fontSize: 11, color: '#edb210', fontWeight: 'bold', letterSpacing: 1 }}>
                    {isCurrentArchived ? 'Archived — still in for the return' : 'Between draws'}
                  </span>
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: '#666' }}>Check email if selected. Card charged only if selected.</p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 12, fontFamily: 'monospace', fontSize: 16, fontWeight: 'bold' }}>
                    <span>{timeLeft.d}{effectiveSchedule.daysLabel}</span>
                    <span>{timeLeft.h}{effectiveSchedule.hoursLabel}</span>
                    <span>{timeLeft.m}{effectiveSchedule.minutesLabel}</span>
                    <span>{timeLeft.s}{effectiveSchedule.secondsLabel}</span>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: '#666' }}>After each draw, check email if selected.</p>
                </>
              )}
            </div>

            <div style={{ background: 'rgba(20,20,22,0.8)', backdropFilter: 'blur(10px)', padding: 14, borderRadius: 14, border: `1px solid ${configPalette.cardBorder}`, textAlign: 'center' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: configPalette.accentPurple, fontWeight: 'bold', marginBottom: 6 }}>
                {config.socialProof?.label || 'Limited drop access'}
              </div>
              <div style={{ fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' }}>{socialProofDisplay.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>{config.socialProof?.caption || ''}</div>
            </div>

            <h2 style={{ fontSize: 24, textAlign: 'center', fontFamily: 'serif', margin: 0 }}>{config.raffleRegistrationForm?.titleHeader || 'Join The Allocation Draw'}</h2>

            <motion.div
              initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
              style={{
                position: 'relative',
                padding: '24px 20px',
                borderRadius: 24,
                border: `1px solid ${configPalette.cardBorder}`,
                overflow: 'hidden',
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                background: 'rgba(17,17,17,0.85)',
              }}
            >
              <div style={{ position: 'absolute', inset: 0, ...paperTexture, opacity: 0.5 }} />

              <div style={{ position: 'relative', zIndex: 1 }}>
                <h3 style={{ fontSize: 20, margin: '0 0 4px', fontFamily: 'serif', textAlign: 'center' }}>{currentProduct?.name || 'Product'}</h3>
                <p style={{ color: configPalette.textMuted, fontSize: 12, margin: '0 0 20px', textAlign: 'center' }}>{currentProduct?.desc || ''}</p>

                <form onSubmit={submitRaffleEntry} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {sizes.length > 1 ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {sizes.map((sz) => {
                        const isSelected = selectedSize === sz;
                        const price = priceFor(currentProduct, sz);
                        const discountedPrice = promoDiscount > 0 && promoValidated ? Math.max(1, Math.round(price * (1 - promoDiscount / 100))) : price;
                        return (
                          <button key={sz} type="button" onClick={() => setSelectedSize(sz)}
                            style={{
                              flex: 1, padding: 12, borderRadius: 12,
                              border: isSelected ? '2px solid #fff' : `1px solid ${configPalette.cardBorder}`,
                              background: isSelected ? '#fff' : 'rgba(22,22,26,0.5)',
                              color: isSelected ? '#000' : configPalette.textMain, fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
                            }}>
                            {sz} — {promoDiscount > 0 && promoValidated && isSelected ? (
                              <>
                                <span style={{ textDecoration: 'line-through', color: '#666', marginRight: 4 }}>${price}</span>
                                <span style={{ color: '#edb210' }}>${discountedPrice}</span>
                              </>
                            ) : (
                              `$${price}`
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}>
                      {sizes[0]} —{' '}
                      {promoDiscount > 0 && promoValidated ? (
                        <>
                          <span style={{ textDecoration: 'line-through', color: '#666', marginRight: 6 }}>${priceFor(currentProduct, sizes[0])}</span>
                          <span style={{ color: '#edb210' }}>${Math.max(1, Math.round(priceFor(currentProduct, sizes[0]) * (1 - promoDiscount / 100)))}</span>
                          {promoCode && <span style={{ fontSize: 10, color: '#34c759', marginLeft: 6 }}>({promoCode})</span>}
                        </>
                      ) : (
                        <>${priceFor(currentProduct, sizes[0])}</>
                      )}
                    </div>
                  )}
                  <input required type="email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder={config.raffleRegistrationForm?.emailPlaceholder || 'name@domain.com'} autoComplete="email"
                    style={{ width: '100%', padding: 14, borderRadius: 12, background: 'rgba(22,22,26,0.7)', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: 13, boxSizing: 'border-box' }} />
                  <input required type="text" value={form.shippingAddress} onChange={(e) => setForm((prev) => ({ ...prev, shippingAddress: e.target.value }))}
                    id="goyunir-shipping-address" list="goyunir-address-suggestions" placeholder={config.raffleRegistrationForm?.addressPlaceholder || '123 Luxury Dr, New York, NY'} autoComplete="shipping street-address" name="shipping-address"
                    style={{ width: '100%', padding: 14, borderRadius: 12, background: 'rgba(22,22,26,0.7)', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: 13, boxSizing: 'border-box' }} />
                  {promoCode && promoValidated ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(52,199,89,0.12)', border: '1px solid rgba(52,199,89,0.4)', borderRadius: 10, padding: '8px 12px', fontSize: 11 }}>
                      <span style={{ color: '#34c759', fontWeight: 600 }}>
                        🏷 {promoCode} applied{promoDiscount > 0 ? ` — ${promoDiscount}% off if selected` : ''}
                      </span>
                      <button type="button" onClick={clearPromo} style={{ background: 'none', border: 'none', color: '#ff6b5a', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div>
                      {!showManualPromo ? (
                        <button type="button" onClick={() => setShowManualPromo(true)}
                          style={{ background: 'none', border: 'none', color: '#666', fontSize: 11, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                          Have a promo code?
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            type="text"
                            value={manualPromoInput}
                            onChange={(e) => setManualPromoInput(e.target.value.toUpperCase())}
                            placeholder="Promo code"
                            style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(22,22,26,0.7)', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: 12, boxSizing: 'border-box' }}
                          />
                          <button type="button" onClick={applyManualPromo}
                            style={{ padding: '0 14px', borderRadius: 12, border: `1px solid ${configPalette.cardBorder}`, background: 'transparent', color: '#ccc', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                            Apply
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <p style={{ margin: 0, fontSize: 11, color: configPalette.textMuted, textAlign: 'center' }}>
                    Card saved — charged only if selected. One entry per email.
                  </p>
                  <datalist id="goyunir-address-suggestions">
                    {savedAddresses.map((a) => (
                      <option key={a} value={a} />
                    ))}
                  </datalist>
                  <button type="submit" disabled={isProcessing}
                    style={{
                      width: '100%', padding: 16, borderRadius: 30,
                      background: isProcessing ? '#1f1f23' : timeLeft.expired || isCurrentArchived ? '#edb210' : configPalette.checkoutCtaButton,
                      color: isProcessing ? '#555' : timeLeft.expired || isCurrentArchived ? '#09090b' : configPalette.textMain,
                      border: 'none', fontWeight: 'bold', fontSize: 14, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    }}>
                    {isProcessing
                      ? config.raffleRegistrationForm?.submitButtonLoadingText || 'Encrypting Entry Base...'
                      : timeLeft.expired || isCurrentArchived
                        ? 'Stay entered for the return'
                        : config.raffleRegistrationForm?.submitButtonText || '🏆 Secure Entry Allocation Ticket'}
                  </button>
                </form>
              </div>
            </motion.div>
          </div>

          <footer style={{ width: '100%', maxWidth: 380, borderTop: `1px solid ${configPalette.cardBorder}`, paddingTop: 40, color: configPalette.textMuted, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px' }}>CONNECT</p>
                <a href={config.brandFooterData?.instagramLink || '#'} target="_blank" rel="noreferrer" style={{ color: '#888', display: 'block', textDecoration: 'none', marginBottom: 6 }}>Instagram</a>
                <a href={config.brandFooterData?.tiktokLink || '#'} target="_blank" rel="noreferrer" style={{ color: '#888', display: 'block', textDecoration: 'none' }}>TikTok</a>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px' }}>SUPPORT</p>
                <span style={{ color: '#888', display: 'block', marginBottom: 6 }}>{config.brandFooterData?.supportEmail || 'goyunir.support@gmail.com'}</span>
                <a href="/account" style={{ color: '#888', display: 'block', marginBottom: 6 }}>Manage My Entry</a>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', fontSize: 10 }}>
              <a href="/terms" style={{ color: '#555' }}>Terms</a>
              <a href="/privacy" style={{ color: '#555' }}>Privacy</a>
              <a href="/shipping" style={{ color: '#555' }}>Shipping</a>
            </div>
            <div style={{ textAlign: 'center', color: '#333', fontSize: 10, marginTop: 24 }}>
              © {new Date().getFullYear()} {config.brandFooterData?.corporateEntityCopyright || 'GOYUNIR ALL RIGHTS RESERVED.'}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

function getDefaultProducts(): StoreProduct[] {
  return [
    {
      id: 'prod_elysian_white',
      name: 'Elysian White',
      slug: 'elysian-white',
      prefix: 'elysian-white',
      tagline: 'WHITE ALLOCATION / 01',
      desc: 'Clean, electric profile variant constructed with premium bergamot.',
      price50ml: 0,
      price100ml: 0,
      stripeId50ml: 'price_placeholder_50ml',
      stripeId100ml: 'price_placeholder_100ml',
      maxRaffleAllocationLimit: 0,
      isActive: true,
      isArchived: false,
      notes: [
        { label: 'TOP PROFILE', name: 'White Bergamot', text: 'Crisp Sicilian bergamot crushed with volcanic pink pepper.' },
        { label: 'HEART PROFILE', name: 'Citrus Flash', text: 'Fresh, electric burst optimized to capture immediate attention.' },
        { label: 'BASE PROFILE', name: 'Clean Musk', text: 'A smooth velvet finish that lingers delicately on fabrics.' }
      ],
      images: Array.from({ length: 29 }, (_, i) => `/images/elysian-white/${i + 1}.jpeg`),
      totalInventory: 0,
      winnerTiers: [0],
    },
    {
      id: 'prod_obsidian_void',
      name: 'Obsidian Void',
      slug: 'obsidian-void',
      prefix: 'obsidian-void',
      tagline: 'BLACK ALLOCATION / 02',
      desc: 'Deep, smoke-infused wood profile variant designed for lasting depth.',
      price50ml: 0,
      price100ml: 0,
      stripeId50ml: 'price_placeholder_50ml',
      stripeId100ml: 'price_placeholder_100ml',
      maxRaffleAllocationLimit: 0,
      isActive: true,
      isArchived: false,
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' }
      ],
      images: Array.from({ length: 29 }, (_, i) => `/images/obsidian-void/${i + 1}.jpeg`),
      totalInventory: 0,
      winnerTiers: [0],
    }
  ];
}

function getNextDrawTimestampForSchedule(schedule: any): number {
  if (!schedule) return Date.now() + 24 * 60 * 60 * 1000;
  
  if (schedule.mode === 'fixed') {
    try {
      const date = new Date(schedule.targetEndDateTime);
      if (!isNaN(date.getTime())) return date.getTime();
    } catch {}
  }
  
  return Date.now() + 24 * 60 * 60 * 1000;
}