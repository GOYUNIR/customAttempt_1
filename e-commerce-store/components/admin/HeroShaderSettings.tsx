'use client';

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import HeroShaderCanvas, { type HeroShaderStatus } from '@/components/HeroShaderCanvas';
import {
  HERO_SHADER_PRESETS,
  EXPLOSION_RADIUS_MAX,
  SILHOUETTE_OPTIONS,
  resolveHeroIntensity,
  intensityToRadius,
  intensityToSpeed,
  type AiHeroSettings,
  type AnimationLoopMode,
  type HeroContainerTarget,
} from '@/lib/shaders/presets';
import {
  enhancePrompt,
  paramsToPreset,
  compileShaderParams,
  type ShaderParams,
} from '@/lib/shaders/promptParser';
import { extractAccentPalette, paletteToCss } from '@/lib/shaders/palette';
import { buildProductTarget } from '@/lib/shaders/productTarget';
import { toHexColor } from '@/lib/share-card-config';

/**
 * Minimal, powerful 2-column control suite for the AI Hero Banner & Shader.
 * Left (7/12): the Smart AI Prompt Compiler + four lean accordions (Engine
 * Presets, Motion, Layout, Theme & Palette). Right (5/12): the sticky live
 * viewport preview.
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

/** Three-step generation progress trail shown under the Execute button. */
const STEP_LABELS: ReadonlyArray<string> = [
  '⏳ 1/3 Resolving product geometry & silhouette…',
  '⚡ 2/3 Compiling shader uniforms with AI…',
  '🎨 3/3 Applying GLSL render payload to canvas…',
];

const ANIMATION_MODE_OPTIONS: ReadonlyArray<{ value: AnimationLoopMode; label: string }> = [
  { value: 'pulse', label: 'Infinite Loop' },
  { value: 'scroll', label: 'On Scroll Scrub' },
  { value: 'mouse', label: 'Mouse Interactive' },
];

const CANVAS_MODE_OPTIONS: ReadonlyArray<{ value: HeroContainerTarget; label: string }> = [
  { value: 'background', label: 'Full Hero Background' },
  { value: 'banner', label: 'Sub-Text Banner' },
];

const selectStyle: CSSProperties = {
  width: '100%',
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  color: '#eee',
  fontSize: 12,
  padding: '8px 10px',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Collapsible accordion — keeps secondary controls out of the primary hero row. */
function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '14px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase', color: '#a0a0aa' }}>{title}</span>
        <span
          style={{
            color: '#8a8a94',
            fontSize: 11,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 160ms ease',
            display: 'inline-block',
          }}
        >
          ▾
        </span>
      </button>
      {open ? <div style={{ padding: '0 16px 16px' }}>{children}</div> : null}
    </div>
  );
}

export default function HeroShaderSettings({
  value,
  onChange,
  themeColors,
  products,
}: {
  value: AiHeroSettings;
  onChange: (next: AiHeroSettings | ((prev: AiHeroSettings) => AiHeroSettings)) => void;
  themeColors: Record<string, any>;
  /** Live catalog items (from /api/admin/products) — the dynamic product selector. */
  products?: any[];
}) {
  const [status, setStatus] = useState<HeroShaderStatus>({ backend: 'css', fps: 0 });
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [progressStep, setProgressStep] = useState<0 | 1 | 2 | 3>(0);
  const [paused, setPaused] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generating = progressStep !== 0;

  const catalog = Array.isArray(products) ? products : [];
  const selectedProduct =
    catalog.find(
      (p) =>
        String(p?.id || p?.slug) === String(value.targetProductId) ||
        String(p?.slug || '') === String(value.targetProductId),
    ) || null;
  const selectedTarget = buildProductTarget(selectedProduct);
  // Effective silhouette: explicit admin override → derived from the selected
  // product → neutral container.
  const effectiveSilhouette = value.productSilhouette || selectedTarget?.silhouette || 'generic';

  const palette = extractAccentPalette(themeColors);
  const [a, b, c] = paletteToCss(palette);
  // Single "Intensity & Speed" knob — drives both dispersion and animation speed.
  const intensity = resolveHeroIntensity(value);

  const patch = (next: Partial<AiHeroSettings>) => onChange((prev) => ({ ...prev, ...next }));

  /** Apply compiled (deterministic or AI) params straight into the live canvas. */
  const applyParams = (params: ShaderParams) => {
    onChange((prev) => ({
      ...prev,
      preset: paramsToPreset(params),
      intensity: params.dispersion,
      explosionRadius: Math.round(params.dispersion * EXPLOSION_RADIUS_MAX),
      animationLoop: params.spin ? 'pulse' : prev.animationLoop,
      productSilhouette: params.productSilhouette || prev.productSilhouette || '',
    }));
  };

  // Execute: 1/3 resolve geometry + silhouette deterministically, 2/3 compile
  // uniforms via the AI endpoint, 3/3 apply the payload to the canvas. Cancel
  // aborts the in-flight request and restores the pre-execute snapshot.
  const executePrompt = async () => {
    abortRef.current?.abort();
    const snapshot = value;
    setGenError(null);
    setProgressStep(1);
    // Deterministic compile runs first (instant, never blocks on the network) so
    // the preview updates even when the AI provider is unconfigured or slow.
    applyParams(compileShaderParams(value.prompt, selectedTarget));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await sleep(400);
      if (controller.signal.aborted) return;
      setProgressStep(2);
      const res = await fetch('/api/ai/shader-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: value.prompt, product: selectedTarget }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setGenError(data?.error ? String(data.error) : `Request failed (${res.status}).`);
        return;
      }
      const data = await res.json();
      setProgressStep(3);
      if (data?.params) applyParams(data.params);
      if (data?.silhouette) patch({ productSilhouette: String(data.silhouette) });
      await sleep(300);
      if (data?.aiError) setGenError(String(data.aiError));
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Cancel path — restore the snapshot captured at Execute time.
        onChange(snapshot);
      } else {
        setGenError(err?.message || 'AI generation failed; kept the local compile.');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setProgressStep(0);
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
  };

  const togglePause = () => setPaused((p) => !p);

  const onProductSelect = (id: string) => {
    const prod = catalog.find((p) => String(p?.id || p?.slug) === id) || null;
    const target = buildProductTarget(prod);
    onChange((prev) => ({
      ...prev,
      targetProductId: target ? target.id : '',
      targetProductName: target ? target.name : '',
      productSilhouette: target ? target.silhouette : '',
    }));
  };

  const previewColors = value.paletteAutoSync
    ? { themeColors }
    : {
        themeColors,
        colorA: value.accentA || undefined,
        colorB: value.accentB || undefined,
        colorC: value.accentC || undefined,
      };

  const statusLabel =
    status.backend === 'webgl2'
      ? `WebGL 2.0 · ${status.fps}FPS`
      : status.backend === 'webgl'
        ? `WebGL 1.0 · ${status.fps}FPS`
        : 'CSS Ambient Fallback';

  const statusColor = status.backend === 'css' ? '#e0a53a' : '#3fd68f';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-7">
        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Smart AI Prompt Compiler</div>
          <label style={labelStyle}>Product target</label>
          <select
            value={value.targetProductId || ''}
            onChange={(e) => onProductSelect(e.target.value)}
            style={selectStyle}
          >
            <option value="" style={{ background: '#141419' }}>None — generic container</option>
            {catalog.map((p) => (
              <option key={String(p?.id || p?.slug)} value={String(p?.id || p?.slug)} style={{ background: '#141419' }}>
                {String(p?.name || p?.slug || 'Untitled')}
              </option>
            ))}
          </select>
          <label style={{ ...labelStyle, marginTop: 10 }}>Silhouette override</label>
          <select
            value={value.productSilhouette || ''}
            onChange={(e) => patch({ productSilhouette: e.target.value })}
            style={selectStyle}
          >
            <option value="">Auto — derive from product</option>
            {SILHOUETTE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} style={{ background: '#141419' }}>
                {o.label}
              </option>
            ))}
          </select>
          <label style={{ ...labelStyle, marginTop: 14 }}>Prompt</label>
          <textarea
            rows={2}
            placeholder="Describe the hero motion (e.g. exploded bottle view, liquid glass, cosmic dust)"
            value={value.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              color: '#eee',
              fontSize: 12,
              padding: '10px 12px',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', marginTop: 10 }}>
            <span
              style={{ ...chipBase, borderColor: 'rgba(124,92,255,0.5)', color: '#c9b8ff' }}
              onClick={() => patch({ prompt: enhancePrompt(value.prompt) })}
              role="button"
              tabIndex={0}
            >
              ⚡ AI Auto-Enhance Prompt
            </span>
          </div>
          <button
            type="button"
            onClick={executePrompt}
            disabled={generating}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '12px 16px',
              borderRadius: 12,
              border: '1px solid rgba(124,92,255,0.55)',
              background: 'linear-gradient(135deg, rgba(124,92,255,0.28), rgba(124,92,255,0.12))',
              color: '#e6dfff',
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: '0.3px',
              cursor: generating ? 'progress' : 'pointer',
              opacity: generating ? 0.7 : 1,
            }}
          >
            {generating ? 'Generating…' : '🎬 Execute Prompt & Generate Preview'}
          </button>
          {generating && (
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: '#c9b8ff' }}>
              {STEP_LABELS[progressStep - 1]}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={togglePause}
              style={{
                ...chipBase,
                flex: 1,
                justifyContent: 'center',
                borderColor: paused ? '#7c5cff' : 'rgba(255,255,255,0.12)',
                color: paused ? '#c9b8ff' : '#c8c8d0',
              }}
            >
              {paused ? '▶ Resume Timeline' : '⏸ Pause Timeline'}
            </button>
            {generating && (
              <button
                type="button"
                onClick={cancelGeneration}
                style={{ ...chipBase, flex: 1, justifyContent: 'center', borderColor: 'rgba(255,80,90,0.6)', color: '#ffb3ba' }}
              >
                ✕ Cancel
              </button>
            )}
          </div>
          {genError && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,80,90,0.10)', border: '1px solid rgba(255,80,90,0.35)', fontSize: 11, color: '#ffb3ba', lineHeight: 1.5 }}>
              ⚠ {genError}
            </div>
          )}
        </div>

        <Section title="Engine Presets">
          <select value={value.preset} onChange={(e) => patch({ preset: e.target.value })} style={selectStyle}>
            {HERO_SHADER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id} style={{ background: '#141419' }}>
                {preset.name}
              </option>
            ))}
          </select>
        </Section>

        <Section title="Motion">
          <label style={labelStyle}>Intensity &amp; Speed — {Math.round(intensity * 100)}%</label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(intensity * 100)}
            onChange={(e) => patch({ intensity: Number(e.target.value) / 100 })}
            style={rangeStyle}
          />
          <label style={{ ...labelStyle, marginTop: 14 }}>Animation Mode</label>
          <select
            value={value.animationLoop}
            onChange={(e) => patch({ animationLoop: e.target.value as AnimationLoopMode })}
            style={selectStyle}
          >
            {ANIMATION_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} style={{ background: '#141419' }}>
                {opt.label}
              </option>
            ))}
          </select>
        </Section>

        <Section title="Layout">
          <label style={labelStyle}>Canvas Mode</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {CANVAS_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ containerTarget: opt.value as HeroContainerTarget })}
                style={{ ...chipBase, borderColor: value.containerTarget === opt.value ? '#7c5cff' : 'rgba(255,255,255,0.12)', color: value.containerTarget === opt.value ? '#c9b8ff' : '#c8c8d0' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Theme &amp; Palette">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#ddd' }}>
            <input type="checkbox" checked={value.paletteAutoSync} onChange={(e) => patch({ paletteAutoSync: e.target.checked })} />
            Sync with Storefront Theme
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {[a, b, c].map((col, i) => (
              <div key={i}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: col, border: '1px solid rgba(255,255,255,0.15)' }} />
                <input
                  type="color"
                  value={toHexColor(col)}
                  disabled={value.paletteAutoSync}
                  onChange={(e) => {
                    const key = (['accentA', 'accentB', 'accentC'] as const)[i];
                    patch({ [key]: e.target.value } as Partial<AiHeroSettings>);
                  }}
                  style={{ width: 40, height: 22, border: 'none', background: 'transparent', padding: 0, marginTop: 4, cursor: value.paletteAutoSync ? 'not-allowed' : 'pointer' }}
                />
              </div>
            ))}
          </div>
        </Section>
      </div>

      <div className="lg:col-span-5">
        <div style={{ ...cardStyle, position: 'sticky', top: 96 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ ...sectionTitleStyle, margin: 0 }}>Live Viewport Preview</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: statusColor, padding: '4px 10px', borderRadius: 999, border: `1px solid ${statusColor}55`, background: `${statusColor}14` }}>
              {statusLabel}
            </div>
          </div>

          <div
            style={{
              position: 'relative',
              overflow: 'hidden',
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.12)',
              background: '#0c0c10',
              height: viewport === 'desktop' ? 300 : 420,
              margin: '0 auto',
              maxWidth: viewport === 'desktop' ? '100%' : 260,
            }}
          >
            {value.enabled ? (
              <HeroShaderCanvas
                enabled
                preset={value.preset}
                opacity={value.opacity}
                explosionRadius={intensityToRadius(intensity)}
                particleCount={value.particleCount}
                depthBlur={value.depthBlur}
                animationLoop={value.animationLoop}
                assemblyProgress={value.assemblyProgress}
                blendMode={value.blendMode}
                productSilhouette={effectiveSilhouette}
                paused={paused}
                interactive
                speed={intensityToSpeed(intensity)}
                onStatus={setStatus}
                {...previewColors}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a94', fontSize: 12 }}>
                Shader disabled
              </div>
            )}
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
                  zIndex: 2,
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
                style={{ ...chipBase, textTransform: 'capitalize', borderColor: viewport === vp ? '#7c5cff' : 'rgba(255,255,255,0.12)', color: viewport === vp ? '#c9b8ff' : '#c8c8d0' }}
              >
                {vp === 'desktop' ? '🖥 Desktop' : '📱 Mobile'}
              </button>
            ))}
          </div>

          <label style={{ ...labelStyle, marginTop: 14 }}>Assembly — {Math.round(value.assemblyProgress * 100)}%</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={value.assemblyProgress}
            onChange={(e) => patch({ assemblyProgress: Number(e.target.value), animationLoop: 'scrub' })}
            style={rangeStyle}
          />
        </div>
      </div>
    </div>
  );
}

