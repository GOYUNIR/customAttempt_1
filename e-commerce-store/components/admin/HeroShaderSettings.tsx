'use client';

import { useRef, useState, type CSSProperties } from 'react';
import HeroShaderCanvas, { type HeroShaderStatus } from '@/components/HeroShaderCanvas';
import {
  EXPLOSION_RADIUS_MAX,
  MOTION_TYPE_OPTIONS,
  HERO_HEIGHT_OPTIONS,
  HERO_HEIGHT_MIN,
  HERO_HEIGHT_MAX,
  SPEED_MIN,
  SPEED_MAX,
  resolveHeroIntensity,
  intensityToRadius,
  resolveHeroSpeed,
  resolveHeroMotionType,
  resolveHeroHeightPx,
  motionTypeToPreset,
  motionTypeToLoop,
  type AiHeroSettings,
  type HeroMotionType,
  type HeroHeight,
  type HeroBlendMode,
} from '@/lib/shaders/presets';
import {
  enhancePrompt,
  paramsToPreset,
  compileShaderParams,
  type ShaderParams,
} from '@/lib/shaders/promptParser';
import { buildProductTarget } from '@/lib/shaders/productTarget';
import { themeRadiusNumber } from '@/lib/storefront-config';

/**
 * Streamlined 2-column control suite for the AI Hero Banner & Shader.
 * Left (7/12): Product Target + Smart AI Prompt Compiler, Motion, and Layout.
 * Right (5/12): a pixel-accurate Live Viewport Preview of the public hero box
 * with the real WebGL canvas rendered directly behind the text overlay.
 */

const cardStyle: CSSProperties = {
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)',
  padding: 16,
  marginBottom: 16,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.4,
  textTransform: 'uppercase',
  color: '#a0a0aa',
  margin: '0 0 12px',
};

const labelStyle: CSSProperties = { fontSize: 11, color: '#b8b8c0', marginBottom: 6, display: 'block' };

const rangeStyle: CSSProperties = { width: '100%', accentColor: '#7c5cff' };

const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 11,
  cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  color: '#c8c8d0',
  transition: 'all 120ms ease',
};

const selectStyle: CSSProperties = {
  width: '100%',
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  color: '#eee',
  fontSize: 12,
  padding: '8px 10px',
};

/** Three-step generation progress trail shown under the Execute button. */
const STEP_LABELS: ReadonlyArray<string> = [
  '⏳ 1/3 Resolving product geometry & silhouette…',
  '⚡ 2/3 Compiling shader uniforms with AI…',
  '🎨 3/3 Applying GLSL render payload to canvas…',
];

const OVERLAY_MODE_OPTIONS: ReadonlyArray<{ value: HeroBlendMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'screen', label: 'Screen' },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Map an AI-compiled preset (+ spin flag) back onto a high-level motion type. */
function motionTypeForPreset(preset: string, spin: boolean): HeroMotionType {
  const p = String(preset || '');
  if (p === 'exploded_rebuild') return spin ? 'spin' : 'assembly';
  if (p === 'cyber_mesh') return 'hover';
  return 'spin';
}

export default function HeroShaderSettings({
  value,
  onChange,
  themeColors,
  products,
  brandName = 'YOUR BRAND',
}: {
  value: AiHeroSettings;
  onChange: (next: AiHeroSettings | ((prev: AiHeroSettings) => AiHeroSettings)) => void;
  themeColors: Record<string, any>;
  /** Live catalog items (from /api/admin/products) — the dynamic product selector. */
  products: any[];
  /** Brand name for the preview badge (from admin Branding). */
  brandName?: string;
}) {
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<HeroShaderStatus | null>(null);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [progressStep, setProgressStep] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const catalog = Array.isArray(products) ? products : [];
  const selectedProduct =
    catalog.find(
      (p) =>
        String(p?.id || p?.slug) === String(value.targetProductId) ||
        String(p?.slug || '') === String(value.targetProductId),
    ) || null;
  const selectedTarget = buildProductTarget(selectedProduct);

  const intensity = resolveHeroIntensity(value);
  const motionType = resolveHeroMotionType(value);
  const effectivePreset = String(value.preset || motionTypeToPreset(motionType));
  const effectiveLoop = value.animationLoop || motionTypeToLoop(motionType);
  const effectiveSpeed = resolveHeroSpeed(value);
  // Silhouette is auto-derived from the selected product target (no manual override).
  const effectiveSilhouette = selectedTarget?.silhouette || value.productSilhouette || 'generic';

  const patch = (next: Partial<AiHeroSettings>) => onChange((prev) => ({ ...prev, ...next }));

  /** Apply compiled (deterministic or AI) params straight into the live canvas. */
  const applyParams = (params: ShaderParams) => {
    const preset = paramsToPreset(params);
    const motion = motionTypeForPreset(preset, params.spin);
    onChange((prev) => ({
      ...prev,
      preset,
      motionType: motion,
      animationLoop: motionTypeToLoop(motion),
      intensity: params.dispersion,
      explosionRadius: Math.round(params.dispersion * EXPLOSION_RADIUS_MAX),
      productSilhouette: params.productSilhouette || selectedTarget?.silhouette || prev.productSilhouette || '',
    }));
  };

  const onProductSelect = (id: string) => {
    const target = id
      ? buildProductTarget(
          catalog.find((p) => String(p?.id || p?.slug) === id || String(p?.slug) === id) || null,
        )
      : null;
    onChange((prev) => ({
      ...prev,
      targetProductId: target ? target.id : '',
      targetProductName: target ? target.name : '',
      productSilhouette: target ? target.silhouette : '',
    }));
  };

  const onMotionTypeChange = (mt: HeroMotionType) => {
    patch({ motionType: mt, preset: motionTypeToPreset(mt), animationLoop: motionTypeToLoop(mt) });
  };


  const executePrompt = async () => {
    const prompt = String(value.prompt || '').trim();
    if (!prompt && !selectedTarget) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setGenError('');
    setPaused(false);
    try {
      setProgressStep(1);
      await sleep(350);
      // Deterministic floor first — instant preview, then the AI refines it.
      const deterministic = compileShaderParams(prompt, selectedTarget);
      applyParams(deterministic);
      setProgressStep(2);
      await sleep(350);
      const res = await fetch('/api/ai/shader-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, product: selectedTarget }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const data = await res.json();
      if (data?.params) applyParams(data.params);
      if (data?.aiError) setGenError(String(data.aiError));
      setProgressStep(3);
      await sleep(350);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setGenError(err?.message || 'AI generation failed — the deterministic shader remains active.');
    } finally {
      setGenerating(false);
      setProgressStep(0);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgressStep(0);
    setGenError('');
  };

  // Preview theme tokens (fall back to brand-safe neutrals on an unseeded theme).
  const tc = (themeColors || {}) as Record<string, any>;
  const previewCardBg = String(tc.cardBackground || '#0c0c10');
  const previewSurface = tc.surfaceTransparency;
  const previewTextMain = String(tc.cardTextMain || '#f5f5f7');
  const previewTextMuted = String(tc.cardTextMuted || '#a0a0aa');
  const previewBorder = String(tc.cardBorder || 'rgba(255,255,255,0.12)');
  const previewAccent = String(tc.accentBlue || '#0071e3');
  const previewRadius = Number(value.cornerRadius) > 0 ? Number(value.cornerRadius) : themeRadiusNumber(themeColors, 26);
  const previewMaxWidth = Number(value.maxWidth) > 0 ? Number(value.maxWidth) : 720;
  const previewPadding = Number(value.padding) > 0 ? Number(value.padding) : 28;
  const previewHeight = resolveHeroHeightPx(value);

  const statusLabel = status
    ? `${status.backend === 'css' ? 'CSS Ambient Fallback' : status.backend === 'webgl2' ? 'WebGL 2.0' : 'WebGL'} · ${status.fps} FPS`
    : 'Initializing…';
  const statusColor = status?.backend === 'css' ? '#f59e0b' : '#22c55e';

  const chipActive = (active: boolean): CSSProperties => ({
    ...chipBase,
    borderColor: active ? '#7c5cff' : 'rgba(255,255,255,0.12)',
    color: active ? '#c9b8ff' : '#c8c8d0',
  });


  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 24 }}>
      {/* Left column */}
      <div style={{ gridColumn: 'span 7', minWidth: 0 }}>
        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Smart AI Prompt Compiler</div>

          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enable AI Hero Shader
          </label>

          <label style={{ ...labelStyle, marginTop: 12 }}>Product target</label>
          <select value={value.targetProductId || ''} onChange={(e) => onProductSelect(e.target.value)} style={selectStyle}>
            <option value="">No product — neutral container</option>
            {catalog.map((p) => (
              <option key={String(p?.id || p?.slug)} value={String(p?.id || p?.slug)}>
                {String(p?.name || p?.title || p?.slug || 'Untitled')}
              </option>
            ))}
          </select>

          <label style={{ ...labelStyle, marginTop: 12 }}>Prompt</label>
          <textarea
            value={value.prompt || ''}
            onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="e.g. exploded bottle view, slow assembly along surface normals"
            rows={3}
            style={{ ...selectStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => patch({ prompt: enhancePrompt(value.prompt || '') })} style={chipBase}>
              ⚡ AI Auto-Enhance Prompt
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              disabled={generating}
              onClick={executePrompt}
              style={{
                ...chipBase,
                background: '#7c5cff',
                borderColor: '#7c5cff',
                color: '#fff',
                fontWeight: 700,
                opacity: generating ? 0.6 : 1,
                cursor: generating ? 'default' : 'pointer',
              }}
            >
              {generating ? 'Generating…' : 'Execute Prompt & Generate Preview'}
            </button>
            {!generating && (
              <button type="button" onClick={() => setPaused((p) => !p)} style={chipBase}>
                {paused ? '▶ Resume Timeline' : '⏸ Pause Timeline'}
              </button>
            )}
            {generating && (
              <button type="button" onClick={cancel} style={chipBase}>
                ✕ Cancel
              </button>
            )}
          </div>

          {generating && progressStep > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#c9b8ff', fontWeight: 700 }}>{STEP_LABELS[progressStep - 1]}</div>
          )}
          {genError && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px' }}>
              ⚠ {genError}
            </div>
          )}
        </div>


        {/* Motion */}
        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Motion</div>

          <label style={labelStyle}>Motion Type</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {MOTION_TYPE_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => onMotionTypeChange(opt.value)} style={chipActive(motionType === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>

          <label style={labelStyle}>Speed — {effectiveSpeed.toFixed(2)}×</label>
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            value={effectiveSpeed}
            onChange={(e) => patch({ speed: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Intensity — {Math.round(intensity * 100)}%</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={intensity}
            onChange={(e) => patch({ intensity: Number(e.target.value), explosionRadius: intensityToRadius(Number(e.target.value)) })}
            style={rangeStyle}
          />
        </div>

        {/* Layout */}
        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Layout</div>

          <label style={labelStyle}>Hero Box Height / Aspect Ratio</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {HERO_HEIGHT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ heroHeight: opt.value as HeroHeight })}
                style={chipActive((value.heroHeight || 'standard') === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {(value.heroHeight || 'standard') === 'custom' && (
            <>
              <label style={labelStyle}>Custom height — {Math.round(resolveHeroHeightPx(value))}px</label>
              <input
                type="range"
                min={HERO_HEIGHT_MIN}
                max={HERO_HEIGHT_MAX}
                step={10}
                value={resolveHeroHeightPx(value)}
                onChange={(e) => patch({ heroHeightPx: Number(e.target.value) })}
                style={rangeStyle}
              />
            </>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>Max Width — {Math.round(previewMaxWidth)}px</label>
          <input
            type="range"
            min={360}
            max={1200}
            step={10}
            value={Math.round(previewMaxWidth)}
            onChange={(e) => patch({ maxWidth: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Corner Radius — {Math.round(previewRadius)}px</label>
          <input
            type="range"
            min={0}
            max={60}
            step={1}
            value={Math.round(previewRadius)}
            onChange={(e) => patch({ cornerRadius: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Padding — {Math.round(previewPadding)}px</label>
          <input
            type="range"
            min={0}
            max={80}
            step={2}
            value={Math.round(previewPadding)}
            onChange={(e) => patch({ padding: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Overlay Mode</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {OVERLAY_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ blendMode: opt.value })}
                style={chipActive((value.blendMode || 'normal') === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>


      {/* Right column — Live Viewport Preview */}
      <div style={{ gridColumn: 'span 5', minWidth: 0 }}>
        <div style={{ ...cardStyle, position: 'sticky', top: 96 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ ...sectionTitleStyle, margin: 0 }}>Live Viewport Preview</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: statusColor, padding: '4px 10px', borderRadius: 999, border: `1px solid ${statusColor}55`, background: `${statusColor}14` }}>
              {statusLabel}
            </div>
          </div>

          <div
            style={{
              position: 'relative',
              overflow: 'hidden',
              borderRadius: previewRadius,
              border: `1px solid ${previewBorder}`,
              background: `color-mix(in srgb, ${previewCardBg} ${previewSurface == null ? 100 : Number(previewSurface)}%, transparent)`,
              height: previewHeight,
              margin: '0 auto',
              maxWidth: viewport === 'desktop' ? '100%' : 280,
              boxShadow: '0 1px 2px rgba(0,0,0,0.12), 0 10px 30px rgba(0,0,0,0.18)',
            }}
          >
            {value.enabled ? (
              <HeroShaderCanvas
                enabled
                preset={effectivePreset}
                opacity={value.opacity}
                explosionRadius={intensityToRadius(intensity)}
                particleCount={value.particleCount}
                depthBlur={value.depthBlur}
                animationLoop={effectiveLoop}
                assemblyProgress={value.assemblyProgress}
                blendMode={value.blendMode}
                productSilhouette={effectiveSilhouette}
                paused={paused}
                interactive
                speed={effectiveSpeed}
                onStatus={setStatus}
                themeColors={themeColors}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a94', fontSize: 12 }}>
                Shader disabled
              </div>
            )}

            {/* Public hero content overlay — zIndex 10 keeps it above the canvas (zIndex 0). */}
            <div
              style={{
                position: 'relative',
                zIndex: 10,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: previewPadding,
                pointerEvents: 'none',
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: 2.5, textTransform: 'uppercase', color: previewTextMuted, fontWeight: 700 }}>
                {String(brandName || 'YOUR BRAND').toUpperCase()} / CALIFORNIA USA
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8, whiteSpace: 'pre-line', color: previewTextMain, fontFamily: 'Georgia, Times New Roman, serif', lineHeight: 1.2 }}>
                by our hands. to your hands.
              </div>
              <div style={{ fontSize: 12, color: previewTextMuted, marginTop: 10, whiteSpace: 'pre-line', lineHeight: 1.6, maxWidth: 440 }}>
                homemade &amp; designed, with real ingredients, with real hands. for real people.
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ background: previewAccent, color: '#04101f', padding: '10px 20px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
                  Browse drops
                </span>
                <span style={{ fontSize: 12, color: previewTextMuted, textDecoration: 'underline', textUnderlineOffset: 3 }}>
                  Our Story
                </span>
              </div>
              <div style={{ marginTop: 18, display: 'inline-flex', alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 999, border: `1px solid ${previewBorder}`, color: previewTextMuted, fontSize: 11, fontWeight: 600 }}>
                Total raffle entries: 1,234
              </div>
            </div>

            {generating && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'rgba(8,8,12,0.55)',
                  color: '#c9b8ff',
                  fontSize: 12,
                  fontWeight: 700,
                  zIndex: 20,
                }}
              >
                <span>{STEP_LABELS[progressStep - 1]}</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {(['desktop', 'mobile'] as const).map((vp) => (
              <button
                key={vp}
                type="button"
                onClick={() => setViewport(vp)}
                style={chipActive(viewport === vp)}
              >
                {vp === 'desktop' ? '🖥 Desktop' : '📱 Mobile'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

