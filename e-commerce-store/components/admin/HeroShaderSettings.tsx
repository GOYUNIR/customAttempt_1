'use client';

import { useState, type CSSProperties } from 'react';
import HeroShaderCanvas, { type HeroShaderStatus } from '@/components/HeroShaderCanvas';
import {
  HERO_SHADER_PRESETS,
  PARTICLE_COUNT_OPTIONS,
  EXPLOSION_RADIUS_MIN,
  EXPLOSION_RADIUS_MAX,
  CONTAINER_TARGET_OPTIONS,
  CANVAS_HEIGHT_OPTIONS,
  BLEND_MODE_OPTIONS,
  type AiHeroSettings,
  type AnimationLoopMode,
  type HeroContainerTarget,
  type HeroCanvasHeight,
  type HeroBlendMode,
} from '@/lib/shaders/presets';
import { parsePromptToParams, enhancePrompt, paramsToPreset, MAGIC_PROMPT_PILLS } from '@/lib/shaders/promptParser';
import { extractAccentPalette, paletteToCss, type AccentPalette } from '@/lib/shaders/palette';

/**
 * Luxury 2-column control suite for the AI Hero Banner & Shader.
 * Left (7/12): presets, prompt, motion, palette. Right (5/12): sticky live preview.
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

function presetSwatch(presetId: string, palette: AccentPalette): CSSProperties {
  const [a, b, c] = paletteToCss(palette);
  switch (presetId) {
    case 'exploded_rebuild':
      return {
        background: `radial-gradient(circle at 50% 40%, ${a} 0%, transparent 55%), radial-gradient(circle at 30% 60%, ${b} 0%, transparent 45%), radial-gradient(circle at 70% 60%, ${c} 0%, transparent 45%), #0c0c10`,
      };
    case 'cyber_mesh':
      return {
        background: `linear-gradient(135deg, ${a}, ${b}), repeating-linear-gradient(45deg, transparent 0 6px, ${c}40 6px 7px)`,
      };
    case 'ambient_glass':
      return { background: `linear-gradient(135deg, ${b}cc, ${a}cc)` };
    case 'dark_organic':
    default:
      return { background: `linear-gradient(135deg, ${c}, ${a}, ${b})` };
  }
}

const LOOP_OPTIONS: ReadonlyArray<{ value: AnimationLoopMode; label: string }> = [
  { value: 'pulse', label: 'Infinite Loop (Pulse)' },
  { value: 'scroll', label: 'On Scroll Scrub' },
  { value: 'mouse', label: 'Mouse Interactive Distance' },
  { value: 'scrub', label: 'Manual Scrub (preview)' },
];

export default function HeroShaderSettings({
  value,
  onChange,
  themeColors,
}: {
  value: AiHeroSettings;
  onChange: (next: AiHeroSettings) => void;
  themeColors: Record<string, any>;
}) {
  const [status, setStatus] = useState<HeroShaderStatus>({ backend: 'css', fps: 0 });
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  const palette = extractAccentPalette(themeColors);
  const [a, b, c] = paletteToCss(palette);
  const derived = parsePromptToParams(value.prompt);

  const patch = (next: Partial<AiHeroSettings>) => onChange({ ...value, ...next });

  // "Execute Prompt & Generate Preview" — compiles the prompt text into
  // bounded render uniforms via the dynamic prompt parser, then patches the
  // live canvas state so the preview updates BEFORE any settings save. Zero
  // hardcoded product/brand mapping: the parser maps natural language onto the
  // canonical preset + uniform bounds.
  const executePrompt = () => {
    const params = parsePromptToParams(value.prompt);
    onChange({
      ...value,
      preset: paramsToPreset(params),
      assemblyProgress: params.assemblyProgress,
      explosionRadius: Math.round(params.dispersion * EXPLOSION_RADIUS_MAX),
      animationLoop: params.spin ? 'pulse' : value.animationLoop,
    });
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
          <div style={sectionTitleStyle}>Engine Mode &amp; Presets</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {HERO_SHADER_PRESETS.map((preset) => {
              const isActive = value.preset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => patch({ preset: preset.id })}
                  style={{
                    textAlign: 'left',
                    borderRadius: 14,
                    border: `1px solid ${isActive ? '#7c5cff' : 'rgba(255,255,255,0.10)'}`,
                    boxShadow: isActive ? '0 0 0 3px rgba(124,92,255,0.25)' : 'none',
                    background: 'rgba(255,255,255,0.03)',
                    padding: 10,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ height: 64, borderRadius: 10, marginBottom: 8, ...presetSwatch(preset.id, palette) }} />
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#eee' }}>{preset.name}</div>
                  <div style={{ fontSize: 10, color: '#9a9aa4', marginTop: 2 }}>{preset.category}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Smart AI Prompt Compiler</div>
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {MAGIC_PROMPT_PILLS.map((pill) => (
              <span key={pill.label} style={chipBase} onClick={() => patch({ prompt: pill.prompt })} role="button" tabIndex={0}>
                ✨ {pill.label}
              </span>
            ))}
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
              cursor: 'pointer',
            }}
          >
            🎬 Execute Prompt &amp; Generate Preview
          </button>
          <div style={{ marginTop: 10, fontSize: 10, color: '#8a8a94', lineHeight: 1.7 }}>
            Derived: mode <b style={{ color: '#c9b8ff' }}>{derived.mode}</b>
            {derived.productSilhouette ? <> · silhouette <b style={{ color: '#c9b8ff' }}>{derived.productSilhouette}</b></> : null}
            {' · '}viscosity {(derived.viscosity * 100).toFixed(0)}% · turbulence {(derived.turbulence * 100).toFixed(0)}%
            {derived.spin ? <> · <b style={{ color: '#c9b8ff' }}>continuous spin</b></> : null}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Motion &amp; Primitive Parameters</div>

          <label style={labelStyle}>Explosion radius — {value.explosionRadius}mm</label>
          <input
            type="range"
            min={EXPLOSION_RADIUS_MIN}
            max={EXPLOSION_RADIUS_MAX}
            step={1}
            value={value.explosionRadius}
            onChange={(e) => patch({ explosionRadius: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Particle count &amp; density</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {PARTICLE_COUNT_OPTIONS.map((count) => (
              <button
                key={count}
                type="button"
                onClick={() => patch({ particleCount: count })}
                style={{
                  ...chipBase,
                  borderColor: value.particleCount === count ? '#7c5cff' : 'rgba(255,255,255,0.12)',
                  color: value.particleCount === count ? '#c9b8ff' : '#c8c8d0',
                }}
              >
                {(count / 1000).toFixed(0)}k
              </button>
            ))}
          </div>

          <label style={{ ...labelStyle, marginTop: 14 }}>Opacity — {Math.round((value.opacity || 0.55) * 100)}%</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {[0.25, 0.5, 0.75, 1].map((o) => (
              <button key={o} type="button" onClick={() => patch({ opacity: o })} style={chipBase}>
                {Math.round(o * 100)}%
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={value.opacity ?? 0.55}
            onChange={(e) => patch({ opacity: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Depth blur — {value.depthBlur}</label>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value.depthBlur}
            onChange={(e) => patch({ depthBlur: Number(e.target.value) })}
            style={rangeStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Animation loop</label>
          <select
            value={value.animationLoop}
            onChange={(e) => patch({ animationLoop: e.target.value as AnimationLoopMode })}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              color: '#eee',
              fontSize: 12,
              padding: '8px 10px',
            }}
          >
            {LOOP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} style={{ background: '#141419' }}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Placement &amp; Canvas Layout</div>

          <label style={labelStyle}>Container target</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CONTAINER_TARGET_OPTIONS.map((opt) => (
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

          <label style={{ ...labelStyle, marginTop: 14 }}>Canvas height / aspect ratio</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CANVAS_HEIGHT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ canvasHeight: opt.value as HeroCanvasHeight })}
                style={{ ...chipBase, borderColor: value.canvasHeight === opt.value ? '#7c5cff' : 'rgba(255,255,255,0.12)', color: value.canvasHeight === opt.value ? '#c9b8ff' : '#c8c8d0' }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label style={{ ...labelStyle, marginTop: 14 }}>Blend mode</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {BLEND_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => patch({ blendMode: opt.value as HeroBlendMode })}
                style={{ ...chipBase, borderColor: value.blendMode === opt.value ? '#7c5cff' : 'rgba(255,255,255,0.12)', color: value.blendMode === opt.value ? '#c9b8ff' : '#c8c8d0' }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 10, fontSize: 10, color: '#8a8a94', lineHeight: 1.6 }}>
            Container target decides whether the canvas paints behind the whole hero card or as an inline banner
            beneath the copy. Blend mode controls how the shader composites against the card surface.
          </div>
        </div>

        <div style={cardStyle}>
          <div style={sectionTitleStyle}>Theme &amp; Palette</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#ddd' }}>
            <input type="checkbox" checked={value.paletteAutoSync} onChange={(e) => patch({ paletteAutoSync: e.target.checked })} />
            Sync accent vectors from the storefront theme
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {[a, b, c].map((col, i) => (
              <div key={i}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: col, border: '1px solid rgba(255,255,255,0.15)' }} />
                <input
                  type="color"
                  value={col}
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
          <div style={{ marginTop: 8, fontSize: 10, color: '#8a8a94' }}>
            {value.paletteAutoSync
              ? 'Extracted live from the active theme accent colors.'
              : 'Custom accent vectors — override the theme palette per hero.'}
          </div>
        </div>
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
                explosionRadius={value.explosionRadius}
                particleCount={value.particleCount}
                depthBlur={value.depthBlur}
                animationLoop={value.animationLoop}
                assemblyProgress={value.assemblyProgress}
                blendMode={value.blendMode}
                interactive
                onStatus={setStatus}
                {...previewColors}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8a94', fontSize: 12 }}>
                Shader disabled
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

          <label style={{ ...labelStyle, marginTop: 14 }}>Assembly scrubber — {Math.round(value.assemblyProgress * 100)}%</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={value.assemblyProgress}
            onChange={(e) => patch({ assemblyProgress: Number(e.target.value), animationLoop: 'scrub' })}
            style={rangeStyle}
          />

          <div style={{ marginTop: 12, fontSize: 10, color: '#8a8a94', lineHeight: 1.6 }}>
            0% = fully exploded along surface normals · 100% = assembled hero product. The scrubber drives the
            interactive timeline when the loop is set to <b style={{ color: '#c9b8ff' }}>Manual Scrub</b>.
          </div>
        </div>
      </div>
    </div>
  );
}

