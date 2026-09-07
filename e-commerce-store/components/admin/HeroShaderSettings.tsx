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
  TEXT_DISTRIBUTION_OPTIONS,
  LAYOUT_PRESET_OPTIONS,
  RENDER_MODE_OPTIONS,
  CONTRAST_SCRIM_MAX,
  resolveHeroIntensity,
  intensityToRadius,
  resolveHeroSpeed,
  resolveHeroMotionType,
  resolveHeroHeightPx,
  resolveHeroTextDistribution,
  resolveHeroContrastScrim,
  resolveHeroRenderMode,
  resolveHeroClips,
  resolveHeroLayoutPreset,
  motionTypeToPreset,
  motionTypeToLoop,
  type AiHeroSettings,
  type HeroMotionType,
  type HeroHeight,
  type HeroBlendMode,
  type HeroTextDistribution,
  type HeroRenderMode,
  type HeroLayoutPreset,
  type HeroClip,
} from '@/lib/shaders/presets';
import {
  enhancePrompt,
  paramsToPreset,
  compileShaderParams,
  type ShaderParams,
} from '@/lib/shaders/promptParser';
import { buildProductTarget } from '@/lib/shaders/productTarget';
import { recordCanvasVideo, mediaRecorderSupported } from '@/lib/shaders/videoExport';
import { themeRadiusNumber } from '@/lib/storefront-config';
import { isImageMedia } from '@/lib/media';

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

/** Overlay/blend mode selector. */
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
  const [progress, setProgress] = useState(0);
  const [progressLog, setProgressLog] = useState<Array<{ pct: number; label: string }>>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null);
  const [recording, setRecording] = useState(false);
  const [clipMsg, setClipMsg] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  // The selected product's primary IMAGE feeds the real-image shader in the live
  // preview (mirrors the storefront's `heroCoverImage` resolution).
  const previewImageUrl = (() => {
    const p = selectedProduct as any;
    const imgs = Array.isArray(p?.images) ? p.images : [];
    const first = imgs.find((src: unknown) => typeof src === 'string' && src && isImageMedia(src));
    return String(first || p?.featuredImage || p?.catalogImage || '').trim();
  })();
  const layoutPreset = resolveHeroLayoutPreset(value);

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


  /** Append a granular progress step (0–100) to the expandable log. */
  const logStep = (pct: number, label: string) => {
    setProgress(Math.max(0, Math.min(100, Math.round(pct))));
    setProgressLog((prev) => [...prev, { pct: Math.round(pct), label }]);
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
    setProgress(0);
    setProgressLog([]);
    try {
      logStep(8, 'Resolving product geometry & silhouette…');
      await sleep(300);
      // Deterministic floor first — instant preview, then the AI refines it.
      const deterministic = compileShaderParams(prompt, selectedTarget);
      applyParams(deterministic);
      logStep(35, 'Extracting product geometry');
      await sleep(300);
      logStep(45, 'Processing product image alpha channels');
      await sleep(300);
      logStep(70, 'Compiling GLSL shader uniforms with AI…');
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
      logStep(90, 'Applying GLSL render payload to canvas…');
      if (data?.params) applyParams(data.params);
      if (data?.aiError) setGenError(String(data.aiError));
      await sleep(300);
      logStep(100, 'Complete — live canvas applied');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setGenError(err?.message || 'AI generation failed — the deterministic shader remains active.');
      logStep(100, 'Deterministic fallback applied');
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setGenerating(false);
    setProgress(0);
    setProgressLog([]);
    setGenError('');
  };

  const recordClip = async () => {
    if (!previewCanvas) {
      setClipMsg('Canvas not ready — enable the shader and wait a moment, then try again.');
      return;
    }
    if (!mediaRecorderSupported()) {
      setClipMsg('This browser cannot record the canvas (MediaRecorder is unsupported).');
      return;
    }
    setRecording(true);
    setClipMsg('');
    try {
      const capture = await recordCanvasVideo(previewCanvas, { durationMs: 3000 });
      if (!capture) {
        setClipMsg('Recording failed — the browser could not capture the canvas stream.');
        return;
      }
      const clip: HeroClip = {
        id: `clip-${Date.now()}`,
        url: capture.dataUrl,
        mime: capture.mime,
        bytes: capture.bytes,
        width: capture.width,
        height: capture.height,
        durationMs: capture.durationMs,
        createdAt: new Date().toISOString(),
      };
      onChange((prev) => ({ ...prev, clips: [clip, ...(prev.clips || [])] }));
      setClipMsg('Clip saved to the library.');
    } finally {
      setRecording(false);
    }
  };

  const deleteClip = (id: string) => {
    onChange((prev) => ({ ...prev, clips: (prev.clips || []).filter((c) => c.id !== id) }));
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
  const previewDistribution = resolveHeroTextDistribution(value);
  const previewScrim = resolveHeroContrastScrim(value);
  const distributionJustify =
    previewDistribution === 'top'
      ? 'flex-start'
      : previewDistribution === 'bottom'
        ? 'flex-end'
        : previewDistribution === 'split'
          ? 'space-between'
          : 'center';
  const previewFullBleed = layoutPreset === 'fullBleed';

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
              disabled={!generating && !String(value.prompt || '').trim() && !selectedTarget}
              onClick={generating ? (paused ? () => setPaused(false) : () => setPaused(true)) : executePrompt}
              style={{
                ...chipBase,
                background: '#7c5cff',
                borderColor: '#7c5cff',
                color: '#fff',
                fontWeight: 700,
              }}
            >
              {generating ? (paused ? '▶ Resume' : '⏸ Pause') : '⚡ Generate AI Animation'}
            </button>
            {generating && (
              <span style={{ fontSize: 12, fontWeight: 700, color: '#c9b8ff', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>
                {progress}%
              </span>
            )}
            {generating && (
              <button type="button" onClick={cancel} style={chipBase}>
                ✕ Cancel
              </button>
            )}
          </div>

          {progressLog.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setLogOpen((o) => !o)}
                style={{ ...chipBase, justifyContent: 'space-between', width: '100%' }}
              >
                <span>📋 Progress log ({progressLog.length})</span>
                <span>{logOpen ? '▴' : '▾'}</span>
              </button>
              {logOpen && (
                <div style={{ marginTop: 8, background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '10px 12px', maxHeight: 200, overflowY: 'auto' }}>
                  {progressLog.map((step, i) => (
                    <div key={`${step.pct}-${i}`} style={{ display: 'flex', gap: 10, fontSize: 11, color: '#c8c8d0', padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ minWidth: 42, color: '#c9b8ff', fontWeight: 700 }}>{step.pct}%</span>
                      <span>{step.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
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

          <label style={labelStyle}>Layout Preset</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {LAYOUT_PRESET_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                title={opt.hint}
                onClick={() => patch({ layoutPreset: opt.value as HeroLayoutPreset })}
                style={chipActive(layoutPreset === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label style={labelStyle}>Text Distribution</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {TEXT_DISTRIBUTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ textDistribution: opt.value as HeroTextDistribution })}
                style={chipActive(resolveHeroTextDistribution(value) === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label style={labelStyle}>Contrast Scrim — {resolveHeroContrastScrim(value)}% overlay tint</label>
          <input
            type="range"
            min={0}
            max={CONTRAST_SCRIM_MAX}
            step={1}
            value={resolveHeroContrastScrim(value)}
            onChange={(e) => patch({ contrastScrim: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Overlay Mode</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
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

          {/* Fine-grained metric sliders collapsed by default (Advanced Metrics). */}
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              style={{ ...chipBase, justifyContent: 'space-between', width: '100%' }}
            >
              <span>⚙️ Advanced Metrics</span>
              <span>{advancedOpen ? '▴' : '▾'}</span>
            </button>
            {advancedOpen && (
              <div style={{ marginTop: 10, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <label style={labelStyle}>Max Width — {Math.round(previewMaxWidth)}px</label>
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
              </div>
            )}
          </div>
        </div>

        {/* Render Mode & Clip Management */}
        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Render Mode &amp; Clips</div>

          <label style={labelStyle}>Render Mode</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {RENDER_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ renderMode: opt.value as HeroRenderMode })}
                style={chipActive(resolveHeroRenderMode(value) === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: '#888', margin: '0 0 12px', lineHeight: 1.5 }}>
            In <b>Pre-rendered Video</b> mode (or automatically on mobile / low-power GPUs when a clip
            exists), the storefront loops the saved clip instead of running the live WebGL canvas.
          </div>

          <button
            type="button"
            disabled={recording || !value.enabled}
            onClick={recordClip}
            style={{
              ...chipBase,
              background: '#0f9d58',
              borderColor: '#0f9d58',
              color: '#fff',
              fontWeight: 700,
              opacity: recording || !value.enabled ? 0.55 : 1,
            }}
          >
            {recording ? '● Recording…' : '🎬 Record WebM Clip'}
          </button>
          {clipMsg && <div style={{ marginTop: 8, fontSize: 11, color: '#c8c8d0' }}>{clipMsg}</div>}

          {resolveHeroClips(value).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label style={labelStyle}>Clip library ({resolveHeroClips(value).length})</label>
              {resolveHeroClips(value).map((clip) => (
                <div
                  key={clip.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    justifyContent: 'space-between',
                    background: 'rgba(0,0,0,0.22)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 10,
                    padding: '8px 10px',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#e8e8ee' }}>
                      {clip.mime} · {clip.width}×{clip.height} · {(clip.durationMs / 1000).toFixed(1)}s
                    </div>
                    <div style={{ fontSize: 10, color: '#888' }}>
                      {(clip.bytes / 1024).toFixed(0)} KB · {new Date(clip.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <video
                    src={clip.url}
                    muted
                    loop
                    autoPlay
                    playsInline
                    style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 6, background: '#000' }}
                  />
                  <button type="button" onClick={() => deleteClip(clip.id)} style={chipBase} title="Delete clip">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
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
              borderRadius: previewFullBleed ? 0 : previewRadius,
              border: previewFullBleed ? 'none' : `1px solid ${previewBorder}`,
              background: `color-mix(in srgb, ${previewCardBg} ${previewSurface == null ? 100 : Number(previewSurface)}%, transparent)`,
              height: previewHeight,
              margin: '0 auto',
              maxWidth: previewFullBleed ? '100%' : viewport === 'desktop' ? '100%' : 280,
              boxShadow: previewFullBleed ? 'none' : '0 1px 2px rgba(0,0,0,0.12), 0 10px 30px rgba(0,0,0,0.18)',
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
                productImageUrl={previewImageUrl}
                paused={paused}
                interactive
                speed={effectiveSpeed}
                onStatus={setStatus}
                onCanvasRef={setPreviewCanvas}
                themeColors={themeColors}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a94', fontSize: 12 }}>
                Shader disabled
              </div>
            )}

            {/* Contrast scrim — a theme-tinted overlay between the shader and the
                text so copy stays legible regardless of how bright/dark the
                shader renders. Strength follows the admin "Contrast Scrim". */}
            {previewScrim > 0 && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  background: `color-mix(in srgb, ${previewCardBg} ${previewScrim}%, transparent)`,
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* Public hero content overlay — zIndex 10 keeps it above the canvas (zIndex 0). */}
            <div
              style={{
                position: 'relative',
                zIndex: 10,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: distributionJustify,
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
                <span>
                  {progress}% — {progressLog.length > 0 ? progressLog[progressLog.length - 1].label : 'Working…'}
                </span>
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

