'use client';

import { useScroll, useTransform, motion, AnimatePresence } from 'framer-motion';
import { useRef, useEffect, useState } from 'react';
import { GOYUNIR_STORE_SUITE } from '../goyunir.config';

// DECOUPLED STRUCTURAL DATA TYPE CORES
interface NoteConfig {
  label: string;
  name: string;
  text: string;
}

interface ProductConfig {
  id: string;
  name: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  notes: NoteConfig[];
}

interface EntryFormState {
  email: string;
  shippingAddress: string;
  quantity: number;
}
export default function PerfumeStorefront() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [activeProductIndex, setActiveProductIndex] = useState<number>(0);
  const [selectedSize, setSelectedSize] = useState<string>('50ml');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [activeMenuTab, setActiveMenuTab] = useState<string>('story');
  
  // NATIVE RAFFLE FORM ENTRY CAPTURE MECHANICS
  const [form, setForm] = useState<EntryFormState>({ email: '', shippingAddress: '', quantity: 1 });
  const [feedbackMessage, setFeedbackMessage] = useState<string>('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'success' | 'error'>('idle');
  
  const [votes, setVotes] = useState<Record<string, number>>({ A: 142, B: 98 });
  const [hasVoted, setHasVoted] = useState<boolean>(false);

  const TOTAL_IMAGES = GOYUNIR_STORE_SUITE.animationMechanics.totalFramesToLoad;
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"]
  });

  // FLEXIBLE HARDWARE SPIN TRACKER: Maps limits smoothly from config file values
  const frameIndex = useTransform(
    scrollYProgress, 
    [0, 0.35, 0.65, 0.82, 0.88], 
    GOYUNIR_STORE_SUITE.animationMechanics.spinReverseOnAlternatingProgress 
      ? [1, TOTAL_IMAGES, 1, TOTAL_IMAGES, 1]
      : [1, TOTAL_IMAGES, TOTAL_IMAGES, 1, 1]
  );
  
  const bottleOpacity = useTransform(scrollYProgress, [0.82, 0.88], [1, 0]);
  const scrollIndicatorOpacity = useTransform(scrollYProgress, [0, 0.05], [1, 0]);

  useEffect(() => {
    const localVoteCheck = localStorage.getItem('goyunir_has_voted');
    if (localVoteCheck) setHasVoted(true);
    const handleNavigationFix = () => { setIsProcessing(false); };
    window.addEventListener('popstate', handleNavigationFix);
    return () => window.removeEventListener('popstate', handleNavigationFix);
  }, []);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context || !canvasRef.current) return;

    const currentProduct = GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex];
    const preloadedImages: HTMLImageElement[] = [];
    canvasRef.current.width = 600;
    canvasRef.current.height = 600;

    const drawFrame = (img: HTMLImageElement) => {
      if (img.complete && img.naturalWidth > 0) {
        context.clearRect(0, 0, 600, 600);
        context.drawImage(img, 0, 0, 600, 600);
      }
    };

    for (let i = 1; i <= TOTAL_IMAGES; i++) {
      const img = new Image();
      img.src = `/images/${currentProduct.prefix}_${i}.jpg`; 
      img.onload = () => { if (i === 1) drawFrame(img); };
      preloadedImages.push(img);
    }

    const unsubscribe = frameIndex.on("change", (v) => {
      const index = Math.min(Math.max(Math.round(v), 1), TOTAL_IMAGES);
      const activeFrameImage = preloadedImages[index - 1];
      if (activeFrameImage) drawFrame(activeFrameImage);
    });

    return () => unsubscribe();
  }, [frameIndex, activeProductIndex, TOTAL_IMAGES]);
  // TEXTBOOK NIKE SNKRS QUEUE SUBMITTER
  const submitRaffleEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;
    setIsProcessing(true);
    setFeedbackStatus('idle');
    setFeedbackMessage('Verifying profile with priority queue allocation...');

    try {
      const activeProd = GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex];
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variant: activeProd.name,
          size: selectedSize,
          email: form.email,
          shippingAddress: form.shippingAddress,
          quantityChosen: form.quantity
        }),
      });

      const data = await response.json();
      if (response.ok) {
        setFeedbackStatus('success');
        setFeedbackMessage(data.message || '✓ Entry secured successfully.');
        setForm({ email: '', shippingAddress: '', quantity: 1 });
      } else {
        setFeedbackStatus('error');
        setFeedbackMessage(data.message || '⚠️ Drop registration failed.');
      }
    } catch (err) {
      setFeedbackStatus('error');
      setFeedbackMessage('❌ Connection timeout. Vercel KV entry pipeline interrupted.');
    } finally {
      setIsProcessing(false);
    }
  };

  const submitVote = (option: string) => {
    if (hasVoted) return;
    setVotes(prev => ({ ...prev, [option]: prev[option] + 1 }));
    setHasVoted(true);
    localStorage.setItem('goyunir_has_voted', 'true');
  };

  return (
    <div ref={containerRef} style={{ background: configPalette.primaryBackground, color: configPalette.textMain, position: 'relative', width: '100%', minHeight: '450vh' }}>
      
      {/* GLOBAL MINI FIXED NAVIGATION HEADER BAR */}
      <header style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '60px', borderBottom: `1px solid ${configPalette.cardBorder}`, background: 'rgba(10,10,10,0.8)', backdropFilter: 'blur(15px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', zIndex: 100, boxSizing: 'border-box' }}>
        <div onClick={() => setIsMenuOpen(true)} style={{ display: 'flex', flexDirection: 'column', gap: '4px', cursor: 'pointer', padding: '10px 0', width: '24px' }}>
          <div style={{ width: '20px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
          <div style={{ width: '20px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
          <div style={{ width: '14px', height: '2px', background: configPalette.textMain, borderRadius: '1px' }} />
        </div>
        <div style={{ fontWeight: 'bold', letterSpacing: '4px', fontSize: '12px', textTransform: 'uppercase' }}>GOYUNIR MAISON</div>
        <div style={{ width: '24px' }} />
      </header>

      {/* LOWER-THIRD ZONE PERSISTENT CANVAS CONTAINER VIEWPORT ENGINE */}
      <motion.div style={{ position: 'fixed', top: '48vh', left: 0, width: '100%', height: '35vh', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, pointerEvents: 'none', boxSizing: 'border-box', opacity: bottleOpacity }}>
        <canvas ref={canvasRef} style={{ width: '90vw', maxWidth: '300px', height: 'auto', aspectRatio: '1/1' }} />
      </motion.div>

      {/* PUSH DIRECTION OVERLAY */}
      <motion.div style={{ position: 'fixed', bottom: '8vh', left: 0, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 15, pointerEvents: 'none', opacity: scrollIndicatorOpacity }}>
        <motion.span animate={{ y: [0, -10, 0] }} transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }} style={{ textTransform: 'uppercase', letterSpacing: '3px', fontSize: '9px', color: configPalette.textMuted, fontWeight: 'bold' }}>
          ↓ Scroll To Explore
        </motion.span>
      </motion.div>

      {/* SCROLLable INTERACTION INTERFACE LAYER */}
      <div style={{ position: 'relative', zIndex: 2, width: '100%' }}>
        <section style={{ height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'center', padding: '120px 20px 20px', textAlign: 'center', pointerEvents: 'auto', boxSizing: 'border-box' }}>
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '6px', fontSize: '9px', color: '#555', fontWeight: 'bold' }}>The Architecture of Scent</span>
            <h1 style={{ fontSize: '36px', margin: '10px 0', fontFamily: 'serif', letterSpacing: '1px' }}>{GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].name}</h1>
            <p style={{ maxWidth: '300px', color: configPalette.textMuted, lineHeight: '1.7', fontSize: '13px', margin: '0 auto 24px' }}>
              We design fragrances that move faster than time itself. An intentional collision of raw natural essences and electric modern chemistry.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              {GOYUNIR_STORE_SUITE.productCatalog.map((prod, idx) => (
                <button key={prod.id} onClick={() => { setActiveProductIndex(idx); setSelectedSize('50ml'); }} style={{ padding: '8px 18px', borderRadius: '20px', border: activeProductIndex === idx ? `1px solid ${configPalette.textMain}` : `1px solid ${configPalette.cardBorder}`, background: activeProductIndex === idx ? configPalette.textMain : 'transparent', color: activeProductIndex === idx ? configPalette.primaryBackground : configPalette.textMuted, fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', letterSpacing: '0.5px' }}>
                  {prod.name}
                </button>
              ))}
            </div>
          </motion.div>
        </section>
        {/* SEQUENTIAL RUNWAY CONTAINER */}
        <div style={{ position: 'relative', width: '100%', paddingBottom: '15vh' }}>
          {GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].notes.map((note, idx) => {
            const isLeft = idx % 2 === 0;
            const topOffset = 100 + (idx * 90);
            const activeColor = idx % 2 === 0 ? configPalette.accentPurple : configPalette.accentBlue;
            return (
              <div key={idx} style={{ position: 'sticky', top: `${topOffset}px`, width: '100%', display: 'flex', justifyContent: isLeft ? 'flex-start' : 'flex-end', padding: '15px 20px', boxSizing: 'border-box' }}>
                <motion.div initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} style={{ maxWidth: '170px', background: 'rgba(15,15,15,0.92)', padding: '12px', borderRadius: '12px', border: `1px solid ${activeColor}`, backdropFilter: 'blur(8px)', boxShadow: '0 10px 20px rgba(0,0,0,0.5)' }}>
                  <span style={{ fontSize: '8px', color: activeColor, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>{note.label} / 0{idx + 1}</span>
                  <h4 style={{ fontSize: '14px', margin: '4px 0', fontWeight: 'bold' }}>{note.name}</h4>
                  <p style={{ color: '#ccc', fontSize: '11px', margin: 0, lineHeight: '1.4' }}>{note.text}</p>
                </motion.div>
              </div>
            );
          })}
        </div>

        {/* HIGH CONVERSION LOTTERY LAUNCH INPUT CONTROLS ZONE */}
        <section style={{ minHeight: '130vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '100px 15px 40px', background: configPalette.primaryBackground, position: 'relative', zIndex: 10, pointerEvents: 'auto', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', maxWidth: '380px', display: 'flex', flexDirection: 'column', gap: '24px', marginBottom: '80px' }}>
            <h2 style={{ fontSize: '24px', textAlign: 'center', fontFamily: 'serif', margin: '0 0 10px 0', letterSpacing: '1px' }}>
              {GOYUNIR_STORE_SUITE.raffleRegistrationForm.titleHeader}
            </h2>
            
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} style={{ background: configPalette.cardBackground, padding: '24px 20px', borderRadius: '24px', border: `1px solid ${configPalette.cardBorder}`, boxSizing: 'border-box' }}>
              <h3 style={{ fontSize: '20px', margin: '0 0 4px 0', fontFamily: 'serif', textAlign: 'center' }}>{GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].name}</h3>
              <p style={{ color: configPalette.textMuted, fontSize: '12px', margin: '0 0 20px 0', textAlign: 'center' }}>{GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].desc}</p>
              
              <form onSubmit={submitRaffleEntry} style={{ display: 'flex', flexDirection: 'column', gap: '12px', textAlign: 'left' }}>
                <div>
                  <label style={{ fontSize: '10px', fontWeight: 'bold', color: configPalette.textMuted, letterSpacing: '1px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>Select Capacity Size</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {['50ml', '100ml'].map((sz) => {
                      const displayPrice = sz === '50ml' ? GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].price50ml : GOYUNIR_STORE_SUITE.productCatalog[activeProductIndex].price100ml;
                      return (
                        <button key={sz} type="button" onClick={() => setSelectedSize(sz)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: selectedSize === sz ? `2px solid ${configPalette.textMain}` : `1px solid ${configPalette.cardBorder}`, background: selectedSize === sz ? configPalette.textMain : 'transparent', color: selectedSize === sz ? configPalette.primaryBackground : configPalette.textMain, fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s' }}>
                          {sz} — ${displayPrice}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '10px', fontWeight: 'bold', color: configPalette.textMuted, letterSpacing: '1px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>
                    {GOYUNIR_STORE_SUITE.raffleRegistrationForm.emailLabel}
                  </label>
                  <input required type="email" value={form.email} onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))} placeholder={GOYUNIR_STORE_SUITE.raffleRegistrationForm.emailPlaceholder} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: '#16161a', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: '13px', boxSizing: 'border-box' }} />
                </div>

                <div>
                  <label style={{ fontSize: '10px', fontWeight: 'bold', color: configPalette.textMuted, letterSpacing: '1px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>
                    {GOYUNIR_STORE_SUITE.raffleRegistrationForm.addressLabel}
                  </label>
                  <input required type="text" value={form.shippingAddress} onChange={(e) => setForm(prev => ({ ...prev, shippingAddress: e.target.value }))} placeholder={GOYUNIR_STORE_SUITE.raffleRegistrationForm.addressPlaceholder} style={{ width: '100%', padding: '14px', borderRadius: '12px', background: '#16161a', border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, fontSize: '13px', boxSizing: 'border-box' }} />
                </div>

                <button type="submit" disabled={isProcessing} style={{ width: '100%', padding: '16px', borderRadius: '30px', background: configPalette.checkoutCtaButton, color: configPalette.textMain, border: 'none', fontWeight: 'bold', fontSize: '14px', cursor: isProcessing ? 'not-allowed' : 'pointer', marginTop: '8px', transition: 'opacity 0.2s' }}>
                  {isProcessing ? GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonLoadingText : GOYUNIR_STORE_SUITE.raffleRegistrationForm.submitButtonText}
                </button>

                {feedbackMessage && (
                  <p style={{ margin: '12px 0 0 0', fontSize: '11px', textAlign: 'center', fontWeight: 'bold', color: feedbackStatus === 'success' ? '#34c759' : feedbackStatus === 'error' ? '#ff3b30' : '#888' }}>
                    {feedbackMessage}
                  </p>
                )}
              </form>
            </motion.div>
          </div>

          <footer style={{ width: '100%', maxWidth: '380px', borderTop: `1px solid ${configPalette.cardBorder}`, paddingTop: '40px', color: configPalette.textMuted, fontFamily: 'sans-serif', fontSize: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px 0', letterSpacing: '1px' }}>CONNECT</p>
                <a href={GOYUNIR_STORE_SUITE.brandFooterData.instagramLink} target="_blank" rel="noreferrer" style={{ color: '#888', display: 'block', textDecoration: 'none', marginBottom: '6px' }}>Instagram</a>
                <a href={GOYUNIR_STORE_SUITE.brandFooterData.tiktokLink} target="_blank" rel="noreferrer" style={{ color: '#888', display: 'block', textDecoration: 'none' }}>TikTok</a>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ color: configPalette.textMain, fontWeight: 'bold', margin: '0 0 8px 0', letterSpacing: '1px' }}>SUPPORT</p>
                <span style={{ color: '#888', display: 'block', marginBottom: '6px' }}>{GOYUNIR_STORE_SUITE.brandFooterData.supportEmail}</span>
                <span style={{ color: '#888', display: 'block' }}>{GOYUNIR_STORE_SUITE.brandFooterData.shippingReturnPolicyText}</span>
              </div>
            </div>
            <div style={{ textAlign: 'center', color: '#333', fontSize: '10px', marginTop: '30px' }}>© {new Date().getFullYear()} {GOYUNIR_STORE_SUITE.brandFooterData.corporateEntityCopyright}</div>
          </footer>
        </section>
      </div>
      {/* EXTENDABLE MULTI-TAB SIDEBAR DRAWER */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsMenuOpen(false)} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(12px)', zIndex: 200, display: 'flex', justifyContent: 'flex-start' }}>
            <motion.div initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'tween', duration: 0.3 }} onClick={(e) => e.stopPropagation()} style={{ width: '300px', height: '100%', background: '#0e0e10', borderRight: `1px solid ${configPalette.cardBorder}`, padding: '40px 24px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: '4px', borderBottom: `1px solid ${configPalette.cardBorder}`, paddingBottom: '10px', marginTop: '20px' }}>
                {['story', 'catalog', 'votes'].map((tb) => (
                  <button key={tb} onClick={() => setActiveMenuTab(tb)} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: 'none', background: activeMenuTab === tb ? '#222' : 'transparent', color: activeMenuTab === tb ? configPalette.textMain : '#666', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{tb}</button>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 0' }}>
                {activeMenuTab === 'story' && (
                  <div>
                    <h4 style={{ fontFamily: 'serif', fontSize: '18px', margin: '0 0 10px 0' }}>Our Scent Identity</h4>
                    <p style={{ color: configPalette.textMuted, fontSize: '12px', lineHeight: '1.6' }}>Maison Goyunir engineering blends raw extraction mechanics with hyper-modern chemical balancing to forge fragrances that dominate social timelines and capture individual prestige.</p>
                  </div>
                )}
                {activeMenuTab === 'catalog' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <h4 style={{ fontFamily: 'serif', fontSize: '18px', margin: 0 }}>Maison Labs</h4>
                    <div>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', display: 'block', color: configPalette.accentBlue, letterSpacing: '1px', textTransform: 'uppercase' }}>👔 Clothing Line (Upcoming)</span>
                      <p style={{ fontSize: '12px', margin: '4px 0 0 0', color: configPalette.textMuted, lineHeight: '1.4' }}>Heavyweight custom weave streetwear textiles. Raw drop matrix testing begins late 2026.</p>
                    </div>
                    <div>
                      <span style={{ fontSize: '11px', fontWeight: 'bold', display: 'block', color: configPalette.accentPurple, letterSpacing: '1px', textTransform: 'uppercase' }}>🧪 Past Scents Archive</span>
                      <p style={{ fontSize: '12px', margin: '4px 0 0 0', color: configPalette.textMuted, lineHeight: '1.4' }}>Review vaulted batch variants from our experimental archives. Discontinued rare profiles.</p>
                    </div>
                  </div>
                )}
                {activeMenuTab === 'votes' && (
                  <div>
                    <h4 style={{ fontFamily: 'serif', fontSize: '18px', margin: '0 0 6px 0' }}>Laboratory Votes</h4>
                    <p style={{ color: configPalette.textMuted, fontSize: '12px', lineHeight: '1.5', marginBottom: '16px' }}>Vote directly on upcoming collection drops to dictate our next laboratory allocation drop phase.</p>
                    <div style={{ background: '#16161a', padding: '14px', borderRadius: '12px', border: `1px solid ${configPalette.cardBorder}`, fontSize: '12px' }}>
                      <p style={{ margin: '0 0 10px 0', fontWeight: 'bold', color: configPalette.textMain }}>Next Core Scent Direction?</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button onClick={() => submitVote('A')} disabled={hasVoted} style={{ width: '100%', padding: '10px', borderRadius: '8px', background: '#222', color: configPalette.textMain, border: '1px solid #333', fontSize: '11px', fontWeight: 'bold', cursor: hasVoted ? 'not-allowed' : 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}>
                          <span>Option A: Volcanic Oud</span>
                          <span style={{ color: '#888' }}>{votes.A} votes</span>
                        </button>
                        <button onClick={() => submitVote('B')} disabled={hasVoted} style={{ width: '100%', padding: '10px', borderRadius: '8px', background: '#222', color: configPalette.textMain, border: '1px solid #333', fontSize: '11px', fontWeight: 'bold', cursor: hasVoted ? 'not-allowed' : 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}>
                          <span>Option B: Solar Amber</span>
                          <span style={{ color: '#888' }}>{votes.B} votes</span>
                        </button>
                      </div>
                      {hasVoted && <p style={{ color: configPalette.accentPurple, fontSize: '10px', margin: '10px 0 0 0', textAlign: 'center', fontWeight: 'bold' }}>✓ Secure choice recorded into system memory.</p>}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ color: '#333', fontSize: '10px', borderTop: `1px solid ${configPalette.cardBorder}`, paddingTop: '15px' }}>GOYUNIR MAISON PRODUCTION SECURED ENGINE</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
