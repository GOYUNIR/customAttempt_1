'use client';

/**
 * Live storefront preview for the admin product editor.
 *
 * A mini, pixel-faithful render of the real product page
 * (`components/Storefront.tsx`) built from the CURRENT, UNSAVED product form
 * + the CURRENT theme settings + the global Storefront-copy overrides. Every
 * keystroke re-renders it: name, tagline, description, categories,
 * images/crops, prices, per-size checkout modes, sampler records, the
 * urgency/status copy, the mixed-format ribbon, the notes count, and the
 * sold-out lifecycle all update instantly so an operator sees exactly what
 * customers will see BEFORE pressing Save Product.
 *
 * Keep the layout + color math in sync with Storefront.tsx when that changes.
 */

import { useState, useEffect } from 'react';
import {
  getSizeCheckoutMode,
  hasMixedCheckoutModes,
  sizeCheckoutModes,
  isConfiguredPrice,
  surfaceBackground,
  themeRadiusNumber,
  cardSheen,
  cardShadowStyle,
  contentSpacingScale,
} from '@/lib/storefront-config';
import { samplerPresentation, formatMoneyCents, isSamplerSize } from '@/lib/sampler-config';
import { isVideoMedia, pickCrop, coverStyle, DEFAULT_CROP } from '@/lib/media';
import { visibleProductCategories } from '@/lib/storefront-config';

/** Fixed preview card + gallery-box widths (300px card − 2×1px borders). */
const CARD_W = 300;
const GALLERY_W = 298;

export default function ProductLivePreview({ product, theme, copy, categories }: {
  product: any;
  theme: any;
  copy: any;
  categories?: string[];
}) {
  const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
  const [size, setSize] = useState('');
  const selectedSize = cats.some((c: any) => String(c?.size || '').trim().toLowerCase() === String(size || '').trim().toLowerCase())
    ? size
    : (cats[0]?.size || 'Standard');

  // Palette from the CURRENT theme settings — the same tokens the storefront reads.
  const pageBg = theme.primaryBackground || '#f2f2f7';
  const cardBg = theme.cardBackground || '#ffffff';
  const cardBorder = theme.cardBorder || 'rgba(0,0,0,0.12)';
  const cardText = theme.cardTextMain || '#1d1d1f';
  const cardMuted = theme.cardTextMuted || '#52525a';
  const accent = theme.accentBlue || '#0071e3';
  const cta = theme.checkoutCtaButton || '#0071e3';
  const radius = themeRadiusNumber(theme, 26);
  const spacing = contentSpacingScale(theme);
  const radiusSm = Math.max(8, Math.round(radius * 0.7));

  // Clean status-badge chip used under the preview card (replaces the old
  // verbose "Legend" debug dump).
  const statusBadge = (color: string, bg: string) => ({
    fontSize: 8,
    fontWeight: 800,
    letterSpacing: '0.6px',
    textTransform: 'uppercase' as const,
    padding: '3px 8px',
    borderRadius: 999,
    color,
    background: bg,
    border: `1px solid ${color}`,
  });

  const priceCat = cats.find((c: any) => String(c?.size || '').trim().toLowerCase() === String(selectedSize || '').trim().toLowerCase());
  const price = Number(priceCat?.price) || 0;
  const priceConfigured = isConfiguredPrice(price);
  const checkoutMode = getSizeCheckoutMode(product, selectedSize);
  const canCheckoutDirect = checkoutMode === 'FCFS';
  const hasMixed = hasMixedCheckoutModes(product);
  const sizeModes = sizeCheckoutModes(product);
  const mixedRaffleCount = Object.values(sizeModes).filter((m) => m === 'RAFFLE').length;
  const mixedFcfsCount = Object.values(sizeModes).filter((m) => m === 'FCFS').length;

  // Adaptive sampler/mode palettes — mirror Storefront's luminance math so the
  // preview reads exactly like the real card on light AND dark themes.
  const cardIsLight = (() => {
    const hex = String(cardBg || '#ffffff').replace('#', '');
    if (hex.length < 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return false;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.58;
  })();
  const trialColors = cardIsLight
    ? {
        cardBg: '#f0fdf4', cardBorder: 'rgba(21,128,61,0.30)', headline: '#166534', body: '#14532d',
        mathBg: 'rgba(21,128,61,0.06)', mathBorder: 'rgba(21,128,61,0.22)', mathDim: '#15803d', mathStrong: '#14532d',
        credit: '#15803d', note: '#3f6212', barTrack: 'rgba(21,128,61,0.16)', barFill: '#16a34a',
        chipBg: 'rgba(21,128,61,0.10)', chipBorder: 'rgba(21,128,61,0.42)', chipText: '#15803d',
        nudgeText: '#166534', nudgeBg: 'rgba(21,128,61,0.06)', nudgeBorder: 'rgba(21,128,61,0.20)',
      }
    : {
        cardBg: 'rgba(34,197,94,0.10)', cardBorder: 'rgba(34,197,94,0.30)', headline: '#4ade80', body: '#d1fae5',
        mathBg: 'rgba(34,197,94,0.12)', mathBorder: 'rgba(34,197,94,0.24)', mathDim: '#d1fae5', mathStrong: '#ffffff',
        credit: '#86efac', note: '#bbf7d0', barTrack: 'rgba(34,197,94,0.20)', barFill: '#4ade80',
        chipBg: 'rgba(34,197,94,0.12)', chipBorder: 'rgba(34,197,94,0.50)', chipText: '#4ade80',
        nudgeText: '#86efac', nudgeBg: 'rgba(34,197,94,0.08)', nudgeBorder: 'rgba(34,197,94,0.22)',
      };
  const modePill = cardIsLight
    ? {
        raffleBg: 'rgba(180,83,9,0.12)', raffleText: '#92400e', raffleBorder: 'rgba(180,83,9,0.35)',
        fcfsBg: 'rgba(29,78,216,0.10)', fcfsText: '#1e40af', fcfsBorder: 'rgba(29,78,216,0.35)',
      }
    : {
        raffleBg: 'rgba(245,158,11,0.16)', raffleText: '#fbbf24', raffleBorder: 'rgba(245,158,11,0.45)',
        fcfsBg: 'rgba(59,130,246,0.16)', fcfsText: '#93c5fd', fcfsBorder: 'rgba(59,130,246,0.45)',
      };

  // Lifecycle + copy resolution — mirrors Storefront.tsx exactly (per-product
  // override → global Settings → Storefront copy → built-in default).
  const inventoryPerSize = product.inventoryPerSize && typeof product.inventoryPerSize === 'object' ? product.inventoryPerSize : {};
  const perSizeSum = Object.keys(inventoryPerSize).reduce((s, k) => s + (Number(inventoryPerSize[k]) > 0 ? Number(inventoryPerSize[k]) : 0), 0);
  const totalInventory = perSizeSum > 0 ? perSizeSum : Number(product.totalInventory || 0);
  const remaining = Number(product.inventoryRemaining ?? totalInventory);
  const soldOut =
    product.soldOut === true ||
    (totalInventory > 0 && remaining <= 0) ||
    (totalInventory === 0 && (product.soldOutBehavior || 'stay_visible') === 'stay_visible');
  const activeLabel = soldOut ? 'Sold out' : (product.isArchived ? 'Archived' : (product.isUpcoming ? 'Upcoming' : 'Live now'));
  const urgencyLabel = soldOut
    ? String(product.urgencySoldOut || copy.urgencySoldOut || '').trim() || 'This release is fully spoken for.'
    : remaining > 0 && remaining <= 12
      ? `Only ${remaining} allocations left.`
      : remaining > 0 && remaining <= 30
        ? `${remaining} units remain across this release.`
        : String(product.urgencyInStock || copy.urgencyInStock || '').trim() || 'Handmade allocation. Low supply by design.';
  const statusStory = product.isUpcoming
    ? 'Collectors can still queue interest before the release opens publicly.'
    : product.isArchived && checkoutMode === 'RAFFLE'
      ? 'Archive placement keeps the story visible, and raffle entry can still be reopened for private audiences.'
      : product.isArchived
        ? String(product.statusArchived || copy.statusArchived || '').trim() || 'Archive placement preserves the release as proof of demand and collectability.'
        : String(product.statusLive || copy.statusLive || '').trim() || 'Reserved for collectors moving early, before the allocation tightens further.';

  const samplerPres = samplerPresentation(product, selectedSize);

  // Cover media with the admin crop applied 1:1 (the same coverStyle math the
  // product page uses). The natural dimensions of the cover image are loaded in
  // the background so the crop region maps onto the preview box EXACTLY.
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
  const coverSrc = images[0] || '';
  const coverIsVideo = isVideoMedia(coverSrc);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setNatural(null);
    if (!coverSrc || coverIsVideo) return;
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => setNatural(null);
    img.src = coverSrc;
  }, [coverSrc, coverIsVideo]);
  const crop = pickCrop(Array.isArray(product.crops) && product.crops[0] ? product.crops[0] : DEFAULT_CROP, 'desktop');
  const cropIsCustom = crop.w < 0.999 || crop.h < 0.999 || Math.abs(crop.x - 0.5) > 0.001 || Math.abs(crop.y - 0.5) > 0.001;

  const mixedTemplate = String(product.mixedFormatRibbon || copy.mixedFormatRibbon || '').trim();
  const countdownDate = (product.isUpcoming ? product.goLiveAt : product.releaseEndsAt) || '';
  const notes = product.showNotesSection !== false && Array.isArray(product.notes) ? product.notes : [];

  return (
    <div style={{ margin: '4px 0 14px', borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#8b8b94', padding: '10px 14px 0' }}>
        ● Live preview — the product page customers see (updates as you type; nothing publishes until Save Product)
      </div>
      <div style={{ padding: 14, marginTop: 8 }}>
        <div style={{ padding: `${Math.round(10 * spacing)}px`, background: pageBg }}>
          {/* The storefront card — same material recipe as the real product page */}
          <div style={{ width: CARD_W, margin: '0 auto', borderRadius: radius, overflow: 'hidden', border: `1px solid ${cardBorder}`, background: surfaceBackground(cardBg, theme.surfaceTransparency), backgroundImage: cardSheen, boxShadow: cardShadowStyle(theme, 16) }}>
            {/* Gallery */}
            <div style={{ height: 170, position: 'relative', overflow: 'hidden', background: '#0a0a0c' }}>
              {coverSrc ? (
                coverIsVideo ? (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.8)', fontSize: 26, background: 'linear-gradient(135deg, #18181b, #000)' }}>
                    ▶<span style={{ fontSize: 8, letterSpacing: '1.5px', marginLeft: 7 }}>VIDEO</span>
                  </div>
                ) : cropIsCustom && natural ? (
                  <img src={coverSrc} alt="" draggable={false} style={{ position: 'absolute', ...coverStyle(natural.w, natural.h, GALLERY_W, 170, crop), maxWidth: 'none', maxHeight: 'none', pointerEvents: 'none' }} />
                ) : (
                  <div style={{ position: 'absolute', inset: -16, background: `url(${coverSrc}) center/cover` }} />
                )
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)', background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 30%, transparent), rgba(0,0,0,0.25))` }}>
                  No media yet — add photos above
                </div>
              )}
              {coverSrc && images.length > 1 && (
                <span style={{ position: 'absolute', right: 8, bottom: 8, fontSize: 8, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.8)', background: 'rgba(0,0,0,0.45)', padding: '2px 7px', borderRadius: 999 }}>{images.length} photos · swipe</span>
              )}
              {coverSrc && !coverIsVideo && cropIsCustom && (
                <span style={{ position: 'absolute', left: 8, bottom: 8, fontSize: 8, letterSpacing: '1px', textTransform: 'uppercase', color: '#fbbf24', background: 'rgba(0,0,0,0.5)', padding: '2px 7px', borderRadius: 999 }}>✂ crop</span>
              )}
            </div>
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {/* Label + mode pills */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 9, letterSpacing: '2.5px', textTransform: 'uppercase', color: soldOut ? '#fbbf24' : accent, fontWeight: 700 }}>{activeLabel}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {hasMixed && (
                    <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.6px', padding: '2px 6px', borderRadius: 999, background: 'color-mix(in srgb, #a855f7 16%, transparent)', color: cardIsLight ? '#7e22ce' : '#d8b4fe', border: cardIsLight ? '1px solid rgba(126,34,206,0.35)' : '1px solid rgba(168,85,247,0.45)' }}>MIXED</span>
                  )}
                  <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.6px', padding: '2px 6px', borderRadius: 999, background: canCheckoutDirect ? modePill.fcfsBg : modePill.raffleBg, color: canCheckoutDirect ? modePill.fcfsText : modePill.raffleText, border: `1px solid ${canCheckoutDirect ? modePill.fcfsBorder : modePill.raffleBorder}` }}>
                    {canCheckoutDirect ? 'FCFS' : 'RAFFLE'}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 20, fontFamily: 'Georgia, Times New Roman, serif', color: cardText, lineHeight: 1.2, fontWeight: 700 }}>{String(product.name || '').trim() || 'Untitled release'}</div>
              {String(product.tagline || '').trim() && (
                <div style={{ fontSize: 8.5, letterSpacing: '1.5px', textTransform: 'uppercase', color: cardMuted }}>{product.tagline}</div>
              )}
              {visibleProductCategories(product.categories, categories).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {visibleProductCategories(product.categories, categories).map((cat: string) => (
                    <span key={cat} style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 999, background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent, border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)` }}>{cat}</span>
                  ))}
                </div>
              )}
              {String(product.desc || '').trim() && (
                <p style={{ margin: 0, color: cardMuted, fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-line' }}>{product.desc}</p>
              )}
              {(product.showUrgencyLine !== false || product.showStatusLine !== false) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: radiusSm, background: `color-mix(in srgb, ${cardText} 4%, ${cardBg})`, border: `1px solid ${soldOut ? 'rgba(251,191,36,0.28)' : cardBorder}` }}>
                  {product.showUrgencyLine !== false && <div style={{ fontSize: 9.5, color: soldOut ? '#fde68a' : cardText, whiteSpace: 'pre-line', fontWeight: 600 }}>{urgencyLabel}</div>}
                  {product.showStatusLine !== false && <div style={{ fontSize: 9, color: cardMuted, lineHeight: 1.45, whiteSpace: 'pre-line' }}>{product.isArchived ? 'This release is archived, but future returns can still be pre-registered here so collectors stay ahead of the next opening.' : statusStory}</div>}
                </div>
              )}
              {hasMixed && product.showMixedRibbon !== false && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 9.5, lineHeight: 1.5, color: cardMuted, padding: '8px 10px', borderRadius: radiusSm, background: `color-mix(in srgb, #a855f7 7%, ${cardBg})`, border: cardIsLight ? '1px solid rgba(126,34,206,0.25)' : '1px solid rgba(168,85,247,0.30)' }}>
                  <span style={{ fontSize: 11, lineHeight: 1 }}>🎟</span>
                  <span style={{ whiteSpace: 'pre-line' }}>
                    {mixedTemplate
                      ? mixedTemplate.replace(/\{raffle\}/g, String(mixedRaffleCount)).replace(/\{fcfs\}/g, String(mixedFcfsCount))
                      : (<>
                          This release mixes formats — <strong style={{ color: cardIsLight ? '#92400e' : '#fbbf24' }}>{mixedRaffleCount} raffle size{mixedRaffleCount === 1 ? '' : 's'}</strong> and{' '}
                          <strong style={{ color: cardIsLight ? '#1e40af' : '#93c5fd' }}>{mixedFcfsCount} instant-buy size{mixedFcfsCount === 1 ? '' : 's'}</strong>. Pick a size above to see its option.
                        </>)}
                  </span>
                </div>
              )}
              {/* Select size — clickable chips with per-size mode + sampler badges */}
              <div style={{ marginTop: 3 }}>
                <div style={{ fontSize: 9, letterSpacing: '2px', textTransform: 'uppercase', color: cardText, fontWeight: 700 }}>Select size</div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                  {cats.map((cat: any) => {
                    const chipIsSample = isSamplerSize(product, cat.size);
                    const chipBadge = chipIsSample ? String((product.samplerSizes || []).find((s: any) => String(s?.size || '').trim().toLowerCase() === String(cat.size || '').trim().toLowerCase())?.label || 'Sample') : '';
                    const chipMode = getSizeCheckoutMode(product, cat.size);
                    const chipSelected = selectedSize === cat.size;
                    const chipPrice = Number(cat?.price) || 0;
                    return (
                      <button
                        key={cat.size}
                        type="button"
                        onClick={() => setSize(cat.size)}
                        style={{ padding: '5px 8px', borderRadius: 999, border: chipSelected ? `1px solid ${cta}` : (chipIsSample ? trialColors.chipBorder : `1px solid ${cardBorder}`), background: chipSelected ? cta : (chipIsSample ? trialColors.chipBg : 'transparent'), color: chipSelected ? '#ffffff' : (cardText || '#fff'), cursor: 'pointer', fontSize: 10, fontWeight: chipSelected ? 700 : 500, display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}
                      >
                        {cat.size} {chipPrice > 0 ? `($${chipPrice})` : ''}
                        <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '1px 5px', borderRadius: 999, background: chipSelected ? 'rgba(255,255,255,0.22)' : (chipMode === 'FCFS' ? modePill.fcfsBg : modePill.raffleBg), border: chipSelected ? '1px solid rgba(255,255,255,0.4)' : (chipMode === 'FCFS' ? modePill.fcfsBorder : modePill.raffleBorder), color: chipSelected ? '#ffffff' : (chipMode === 'FCFS' ? modePill.fcfsText : modePill.raffleText) }}>
                          {chipMode === 'FCFS' ? 'buy' : 'raffle'}
                        </span>
                        {chipIsSample && (
                          <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: '0.4px', textTransform: 'uppercase', padding: '1px 5px', borderRadius: 999, background: chipSelected ? 'rgba(255,255,255,0.22)' : trialColors.chipBg, border: chipSelected ? '1px solid rgba(255,255,255,0.4)' : trialColors.chipBorder, color: chipSelected ? '#ffffff' : trialColors.chipText }}>🧪 {chipBadge}</span>
                        )}
                      </button>
                    );
                  })}
                  {cats.length === 0 && <div style={{ fontSize: 9, color: cardMuted }}>No sizes yet — add one in Pricing, Sizes &amp; Inventory.</div>}
                </div>
              </div>
              {/* Sampler card / upgrade nudge for the SELECTED size */}
              {samplerPres.selected.isSampler && (
                <div style={{ padding: '9px 10px', borderRadius: radiusSm, background: trialColors.cardBg, border: `1px solid ${trialColors.cardBorder}`, fontSize: 10, color: trialColors.body, lineHeight: 1.55 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: trialColors.headline, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                    🧪 {samplerPres.selected.headline}
                    {hasMixed && <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: '0.5px', padding: '1px 5px', borderRadius: 999, background: modePill.fcfsBg, color: modePill.fcfsText, border: `1px solid ${modePill.fcfsBorder}` }}>INSTANT BUY</span>}
                  </div>
                  <div>{samplerPres.selected.body}</div>
                  {samplerPres.selected.math && (
                    <div style={{ marginTop: 7, padding: '7px 8px', borderRadius: 8, background: trialColors.mathBg, border: `1px solid ${trialColors.mathBorder}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ color: trialColors.mathDim }}>{samplerPres.selected.badge === 'Sample' ? 'Sample' : samplerPres.selected.badge} · <strong>{formatMoneyCents(samplerPres.selected.math.samplePriceCents)}</strong></span>
                        <span style={{ color: trialColors.mathDim }}>→ {formatMoneyCents(samplerPres.selected.math.remainingCents)}</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 4, background: trialColors.barTrack, overflow: 'hidden', marginTop: 6 }}>
                        <div style={{ width: `${Math.min(100, samplerPres.selected.math.pctCovered)}%`, height: '100%', background: trialColors.barFill }} />
                      </div>
                      <div style={{ marginTop: 4, fontSize: 8.5, color: trialColors.credit, letterSpacing: '0.3px' }}>Your credit covers {samplerPres.selected.math.pctCovered}% of the {samplerPres.selected.math.fullSize}</div>
                    </div>
                  )}
                  {samplerPres.selected.note && <div style={{ marginTop: 6, color: trialColors.note, fontSize: 9.5, lineHeight: 1.5 }}>{samplerPres.selected.note}</div>}
                </div>
              )}
              {!samplerPres.selected.isSampler && samplerPres.nudge && (
                <div style={{ padding: '8px 10px', borderRadius: radiusSm, background: trialColors.nudgeBg, border: `1px solid ${trialColors.nudgeBorder}`, fontSize: 9.5, color: trialColors.nudgeText, lineHeight: 1.5 }}>
                  🧪 Want to try it first? The {samplerPres.nudge.size} is {formatMoneyCents(samplerPres.nudge.priceCents)} and includes a {formatMoneyCents(samplerPres.nudge.creditCents)} credit after delivery{samplerPres.nudge.fullSize ? ` toward the ${samplerPres.nudge.fullSize}` : ''}.
                </div>
              )}
              {/* Countdown hint */}
              {checkoutMode === 'RAFFLE' && !soldOut && countdownDate && (
                <div style={{ fontSize: 10, color: cardMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: '#facc15', boxShadow: '0 0 0 3px rgba(250,204,21,0.15)' }} />
                  <span>{product.isUpcoming ? 'Release opens in' : 'Raffle ends in'}: <strong style={{ color: cardText }}>{String(countdownDate).replace('T', ' ')}</strong></span>
                </div>
              )}
              {/* Price + CTA */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: cardText }}>
                  {priceConfigured
                    ? `$${price.toFixed(2)}`
                    : <span style={{ color: '#f59e0b', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px' }}>PRICE NOT SET</span>}
                </div>
                <div style={{ flex: 1 }} />
                <button
                  disabled
                  style={{ padding: '8px 12px', borderRadius: 999, border: 'none', background: `linear-gradient(135deg, ${cta}, color-mix(in srgb, ${cta} 72%, #000))`, color: '#fff', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', fontSize: 9, opacity: priceConfigured && !soldOut ? 1 : 0.55 }}
                >
                  {soldOut ? 'Sold out' : (canCheckoutDirect ? `Secure piece · $${price.toFixed(2)}` : (String(copy.entryCta || '').trim() || 'Enter allocation'))}
                </button>
              </div>
              {notes.length > 0 && (
                <div style={{ marginTop: 2, fontSize: 9, color: cardMuted, letterSpacing: '0.3px' }}>
                  <strong style={{ color: cardText, letterSpacing: '1.5px', textTransform: 'uppercase', fontSize: 8 }}>Why this drop matters</strong> — {notes.length} note{notes.length === 1 ? '' : 's'} (rendered below on the live page)
                </div>
              )}
            </div>
          </div>
          {/* Status badges — a clean, at-a-glance widget instead of raw debug text */}
          <div style={{ width: CARD_W, margin: '10px auto 0', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={statusBadge(canCheckoutDirect ? '#93c5fd' : '#fbbf24', canCheckoutDirect ? 'rgba(59,130,246,0.14)' : 'rgba(245,158,11,0.14)')}>
              {canCheckoutDirect ? 'FCFS' : 'RAFFLE'}
            </span>
            {hasMixed && <span style={statusBadge('#d8b4fe', 'rgba(168,85,247,0.14)')}>MIXED</span>}
            {soldOut && <span style={statusBadge('#f87171', 'rgba(239,68,68,0.14)')}>SOLD OUT</span>}
            {product.isUpcoming && <span style={statusBadge('#60a5fa', 'rgba(59,130,246,0.14)')}>UPCOMING</span>}
            {product.isArchived && <span style={statusBadge('#fbbf24', 'rgba(245,158,11,0.14)')}>ARCHIVED</span>}
            {!soldOut && !product.isUpcoming && !product.isArchived && <span style={statusBadge('#34d399', 'rgba(52,211,153,0.14)')}>LIVE NOW</span>}
          </div>
        </div>
      </div>
    </div>
  );
}






