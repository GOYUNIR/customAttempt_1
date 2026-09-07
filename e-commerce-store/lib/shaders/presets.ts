// Hero shader preset registry + the admin-editable settings shape.
//
// This module is PURE (no React, no `@/` value imports) so `node --test` can
// load it directly and the admin panel + storefront engine can share one
// source of truth for preset ids, legacy-id mapping and the aiHero settings
// contract without drifting.

import { SILHOUETTE_KEYS, silhouetteLabel, type SilhouetteKey } from './productTarget.ts';

export type HeroPresetId = 'dark_organic' | 'exploded_rebuild' | 'cyber_mesh' | 'ambient_glass';

/** Which engine renders a preset: the GLSL fragment shader or the 3D particle engine. */
export type ShaderMode = 'fragment' | 'particle3d';

export interface HeroShaderPreset {
  id: HeroPresetId;
  name: string;
  /** Category badge shown on the admin visual preset card. */
  category: string;
  description: string;
  mode: ShaderMode;
}

export const HERO_SHADER_PRESETS: ReadonlyArray<HeroShaderPreset> = [
  {
    id: 'dark_organic',
    name: 'Dark Organic',
    category: 'Liquid Domain Warping',
    description: 'Slow domain-warped value noise — viscous, smoke-like motion.',
    mode: 'fragment',
  },
  {
    id: 'exploded_rebuild',
    name: 'Exploded Rebuild',
    category: '3D Product Disassembly/Assembly',
    description: 'A perfume bottle assembled from a particle cloud along surface normals.',
    mode: 'particle3d',
  },
  {
    id: 'cyber_mesh',
    name: 'Cyber Mesh & Particles',
    category: 'Grid Particle Wave',
    description: 'A flowing particle grid that ripples toward the cursor.',
    mode: 'fragment',
  },
  {
    id: 'ambient_glass',
    name: 'Ambient Gold / Glass',
    category: 'Refractive Raymarched Glass',
    description: 'A raymarched refractive glass object lit by the theme palette.',
    mode: 'fragment',
  },
];

// Legacy preset ids from the original three-preset engine map onto the new
// canonical suite so an already-seeded store keeps rendering without a
// migration (admin re-save normalizes the stored string).
const LEGACY_PRESET_MAP: Record<string, HeroPresetId> = {
  ambient_mesh: 'ambient_glass',
  particle_waves: 'cyber_mesh',
  dark_organic: 'dark_organic',
};

export function normalizePresetId(id: string | undefined | null): HeroPresetId {
  const raw = String(id || '').trim().toLowerCase();
  if (!raw) return 'dark_organic';
  if (LEGACY_PRESET_MAP[raw]) return LEGACY_PRESET_MAP[raw];
  const known = HERO_SHADER_PRESETS.find((p) => p.id === raw);
  return known ? (known.id as HeroPresetId) : 'dark_organic';
}

export function presetById(id: string | undefined | null): HeroShaderPreset {
  const canonical = normalizePresetId(id);
  return HERO_SHADER_PRESETS.find((p) => p.id === canonical) || HERO_SHADER_PRESETS[0];
}

export function isExplodedPreset(id: string | undefined | null): boolean {
  return normalizePresetId(id) === 'exploded_rebuild';
}

export type AnimationLoopMode = 'pulse' | 'scroll' | 'mouse' | 'scrub' | 'spin';

/**
 * High-level hero motion selector surfaced in the admin panel. Each value maps
 * onto a concrete engine preset + loop mode so a single control drives the whole
 * render: `spin` = continuous 3D product rotation (fully assembled), `assembly`
 * = the exploded → assembled particle loop, `hover` = cursor-reactive grid.
 */
export type HeroMotionType = 'spin' | 'assembly' | 'hover';

/** Preset hero-box heights (and the `custom` slider). */
export type HeroHeight = 'compact' | 'standard' | 'tall' | 'custom';

/** Where the hero canvas paints relative to the hero card content. */
export type HeroContainerTarget = 'background' | 'banner';

/** Preset canvas heights for the inline banner placement (and the aspect hint). */
export type HeroCanvasHeight = 'slim' | 'medium' | 'expanded';

/** CSS blend mode the canvas composes against the hero card surface. */
export type HeroBlendMode = 'normal' | 'overlay' | 'screen';

/**
 * How the hero copy is distributed inside the hero card (admin → "Text
 * Distribution"). Centered is the template default; the others let a buyer
 * push the title up, split the title/buttons, or anchor everything to the
 * bottom of the card without touching the shader.
 */
export type HeroTextDistribution = 'centered' | 'top' | 'split' | 'bottom';

/**
 * Render mode for the hero animation. `live` renders the WebGL canvas in
 * real time; `video` serves a pre-rendered looping WebM/MP4 clip instead
 * (the mobile / low-power fallback).
 */
export type HeroRenderMode = 'live' | 'video';

/** A saved hero clip (admin → Clip Management), stored inside `store:config.aiHero.clips`. */
export interface HeroClip {
  /** Stable id (timestamp-derived) used to key the library + delete clips. */
  id: string;
  /** Immutable data URL (WebM/MP4) the storefront `<video>` loops. */
  url: string;
  /** MIME type — `video/webm` or `video/mp4`. */
  mime: string;
  /** Encoded byte size (for the admin readout). */
  bytes: number;
  /** Rendered width in px. */
  width: number;
  /** Rendered height in px. */
  height: number;
  /** Clip duration in ms. */
  durationMs: number;
  /** ISO creation timestamp (admin ordering). */
  createdAt: string;
}

export interface AiHeroSettings {
  enabled: boolean;
  preset: string;
  prompt: string;
  opacity: number;
  /** Explosion radius in mm (0–150) — mapped to the particle dispersion scale. */
  explosionRadius: number;
  /**
   * Single "Intensity & Speed" knob (0–1) — the one admin control that drives
   * both the exploded dispersion and the animation speed. Kept alongside
   * `explosionRadius` so a legacy config without `intensity` still renders.
   */
  intensity: number;
  /** Point count for the 3D exploded mesh. */
  particleCount: number;
  /** Depth blur (0–100) — fades far particles / far raymarch geometry. */
  depthBlur: number;
  animationLoop: AnimationLoopMode;
  /** 0–1 assembly timeline — the admin scrubber's manual value. */
  assemblyProgress: number;
  /** Derive GLSL accent vectors automatically from the active storefront theme. */
  paletteAutoSync: boolean;
  /** Manual accent overrides (used when paletteAutoSync is OFF). Empty = theme. */
  accentA?: string;
  accentB?: string;
  accentC?: string;
  /** Canvas layout: full-card background vs inline sub-text banner. */
  containerTarget: HeroContainerTarget;
  /** Canvas height / aspect ratio when placed as an inline banner. */
  canvasHeight: HeroCanvasHeight;
  /** How the canvas blends with the hero card surface (admin → "Overlay Mode"). */
  blendMode: HeroBlendMode;
  /** Explicit animation speed multiplier (0.5×–2×), independent of intensity. */
  speed: number;
  /** High-level motion selector (spin / exploded assembly / hover interactive). */
  motionType: HeroMotionType;
  /** Hero-box height preset (compact / standard / tall / custom). */
  heroHeight: HeroHeight;
  /** Custom hero-box height in px when `heroHeight === 'custom'`. */
  heroHeightPx: number;
  /** Max width of the hero card in px (0 = theme default). */
  maxWidth: number;
  /** Corner radius of the hero card in px (0 = theme default). */
  cornerRadius: number;
  /** Hero card padding in px (0 = theme default). */
  padding: number;
  /** Live catalog item the hero shader targets (id/slug from `store:products`). */
  targetProductId?: string;
  /** Human name of the target product (echoed for the admin readout only). */
  targetProductName?: string;
  /** Generic silhouette key the exploded mesh derives from the target product. */
  productSilhouette?: string;
  /** Text layout within the hero card (admin → "Text Distribution"). */
  textDistribution: HeroTextDistribution;
  /** Contrast scrim / overlay tint strength (0–100) for guaranteed legibility. */
  contrastScrim: number;
  /** Render mode: live WebGL canvas vs a pre-rendered looping video clip. */
  renderMode: HeroRenderMode;
  /** Saved video clips (admin → Clip Management). */
  clips: HeroClip[];
}

export const PARTICLE_COUNT_OPTIONS = [10_000, 50_000, 100_000] as const;

export const EXPLOSION_RADIUS_MIN = 0;
export const EXPLOSION_RADIUS_MAX = 150;

export const CONTAINER_TARGET_OPTIONS: ReadonlyArray<{ value: HeroContainerTarget; label: string }> = [
  { value: 'background', label: 'Full Card Background' },
  { value: 'banner', label: 'Inline Sub-Text Banner' },
];

export const CANVAS_HEIGHT_OPTIONS: ReadonlyArray<{ value: HeroCanvasHeight; label: string; px: number }> = [
  { value: 'slim', label: 'Slim (120px)', px: 120 },
  { value: 'medium', label: 'Medium (240px)', px: 240 },
  { value: 'expanded', label: 'Expanded Full Card', px: 0 },
];

export const BLEND_MODE_OPTIONS: ReadonlyArray<{ value: HeroBlendMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'screen', label: 'Screen' },
];

/** Generic silhouette keys selectable as an explicit hero target (no product). */
export const SILHOUETTE_OPTIONS: ReadonlyArray<{ value: SilhouetteKey; label: string }> =
  SILHOUETTE_KEYS.map((key) => ({ value: key, label: silhouetteLabel(key) }));

/** Admin "Motion Type" selector — one high-level control for the whole render. */
export const MOTION_TYPE_OPTIONS: ReadonlyArray<{ value: HeroMotionType; label: string }> = [
  { value: 'spin', label: 'Continuous Spin' },
  { value: 'assembly', label: 'Exploded Assembly' },
  { value: 'hover', label: 'Hover Interactive' },
];

/** Admin "Hero Box Height / Aspect Ratio" selector + the custom slider bounds. */
export const HERO_HEIGHT_OPTIONS: ReadonlyArray<{ value: HeroHeight; label: string; px: number }> = [
  { value: 'compact', label: 'Compact', px: 360 },
  { value: 'standard', label: 'Standard', px: 480 },
  { value: 'tall', label: 'Tall', px: 640 },
  { value: 'custom', label: 'Custom', px: 0 },
];

export const HERO_HEIGHT_MIN = 320;
export const HERO_HEIGHT_MAX = 900;

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

/** Admin "Text Distribution" selector + the max contrast-scrim strength. */
export const TEXT_DISTRIBUTION_OPTIONS: ReadonlyArray<{ value: HeroTextDistribution; label: string }> = [
  { value: 'centered', label: 'Centered' },
  { value: 'top', label: 'Top Heavy' },
  { value: 'split', label: 'Split View (Title top, Buttons bottom)' },
  { value: 'bottom', label: 'Bottom Anchored' },
];

export const CONTRAST_SCRIM_MAX = 100;

/** Admin "Render Mode" selector (Live WebGL vs Pre-rendered Video). */
export const RENDER_MODE_OPTIONS: ReadonlyArray<{ value: HeroRenderMode; label: string }> = [
  { value: 'live', label: 'Live WebGL' },
  { value: 'video', label: 'Pre-rendered Video' },
];

/** Resolve the hero copy distribution (missing → centered). */
export function resolveHeroTextDistribution(
  aiHero: { textDistribution?: string } | undefined | null,
): HeroTextDistribution {
  const raw = aiHero?.textDistribution;
  if (raw === 'top' || raw === 'split' || raw === 'bottom') return raw;
  return 'centered';
}

/** Resolve the contrast-scrim strength (0–100, missing → 0 = no scrim). */
export function resolveHeroContrastScrim(
  aiHero: { contrastScrim?: number } | undefined | null,
): number {
  const n = Number(aiHero?.contrastScrim);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(CONTRAST_SCRIM_MAX, Math.round(n)));
}

/** Resolve the hero render mode (missing → live WebGL). */
export function resolveHeroRenderMode(
  aiHero: { renderMode?: string } | undefined | null,
): HeroRenderMode {
  return aiHero?.renderMode === 'video' ? 'video' : 'live';
}

/** Normalize the saved clip library (defensive: drops malformed entries). */
export function resolveHeroClips(aiHero: { clips?: unknown } | undefined | null): HeroClip[] {
  const raw = aiHero?.clips;
  if (!Array.isArray(raw)) return [];
  const out: HeroClip[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const clip = c as Partial<HeroClip>;
    if (typeof clip.id !== 'string' || !clip.id) continue;
    if (typeof clip.url !== 'string' || !clip.url.startsWith('data:video/')) continue;
    out.push({
      id: clip.id,
      url: clip.url,
      mime: typeof clip.mime === 'string' ? clip.mime : 'video/webm',
      bytes: Number(clip.bytes) || 0,
      width: Number(clip.width) || 0,
      height: Number(clip.height) || 0,
      durationMs: Number(clip.durationMs) || 0,
      createdAt: typeof clip.createdAt === 'string' ? clip.createdAt : new Date().toISOString(),
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Pick the clip the storefront should loop when in `video` render mode. */
export function pickHeroClip(
  aiHero: { clips?: unknown } | undefined | null,
): HeroClip | null {
  const clips = resolveHeroClips(aiHero);
  return clips.length > 0 ? clips[0] : null;
}

/**
 * Decide whether the storefront hero should render the live WebGL canvas or a
 * pre-rendered video clip. `video` wins when (a) the admin explicitly selected
 * "Pre-rendered Video" AND a clip exists, or (b) the visitor is on a mobile
 * viewport / low-power GPU AND a clip exists (the automatic performance
 * fallback). With no clip there is nothing to loop, so it always stays live.
 */
export function resolveEffectiveHeroRender(
  aiHero: { renderMode?: string; clips?: unknown } | undefined | null,
  device: { isMobile?: boolean; isLowPower?: boolean } = {},
): HeroRenderMode {
  const hasClip = pickHeroClip(aiHero) !== null;
  if (!hasClip) return 'live';
  if (resolveHeroRenderMode(aiHero) === 'video') return 'video';
  if (device.isMobile || device.isLowPower) return 'video';
  return 'live';
}

/**
 * Map a high-level motion type onto the concrete engine preset id. `spin` +
 * `assembly` both render the 3D product particle cloud (the geometry the engine
 * is built around); `hover` renders the cursor-reactive grid fragment shader.
 */
export function motionTypeToPreset(motionType: HeroMotionType | string | undefined | null): string {
  switch (motionType) {
    case 'hover':
      return 'cyber_mesh';
    case 'assembly':
    case 'spin':
    default:
      return 'exploded_rebuild';
  }
}

/**
 * Map a high-level motion type onto the engine loop mode. `spin` pins the
 * assembly timeline at 1 (fully assembled) so the product rotates continuously;
 * `assembly` oscillates the timeline so the product reassembles in a loop.
 */
export function motionTypeToLoop(motionType: HeroMotionType | string | undefined | null): AnimationLoopMode {
  switch (motionType) {
    case 'hover':
      return 'mouse';
    case 'spin':
      return 'spin';
    case 'assembly':
    default:
      return 'pulse';
  }
}

/** Resolve the admin motion-type selector from a config (missing → `spin`). */
export function resolveHeroMotionType(
  aiHero: { motionType?: string } | undefined | null,
): HeroMotionType {
  const raw = aiHero?.motionType;
  if (raw === 'spin' || raw === 'assembly' || raw === 'hover') return raw;
  return 'spin';
}

/** Resolve the explicit animation speed (0.5×–2×), falling back to intensity. */
export function resolveHeroSpeed(
  aiHero: { speed?: number; intensity?: number; explosionRadius?: number } | undefined | null,
): number {
  const raw = Number(aiHero?.speed);
  if (Number.isFinite(raw) && raw > 0) return Math.max(SPEED_MIN, Math.min(SPEED_MAX, raw));
  return intensityToSpeed(resolveHeroIntensity(aiHero));
}

/** Resolve the hero-box height in px from the preset (or the custom slider). */
export function resolveHeroHeightPx(
  aiHero: { heroHeight?: string; heroHeightPx?: number } | undefined | null,
): number {
  const kind = aiHero?.heroHeight === 'custom' ? 'custom' : (aiHero?.heroHeight || 'standard');
  if (kind === 'custom') {
    const px = Number(aiHero?.heroHeightPx);
    if (Number.isFinite(px) && px > 0) {
      return Math.max(HERO_HEIGHT_MIN, Math.min(HERO_HEIGHT_MAX, Math.round(px)));
    }
  }
  const match = HERO_HEIGHT_OPTIONS.find((o) => o.value === kind);
  return match ? match.px : 480;
}

/**
 * Resolve the single "Intensity & Speed" value (0..1) that drives the exploded
 * dispersion AND the animation speed. Falls back to the legacy `explosionRadius`
 * field so a pre-migration config keeps its exact look.
 */
export function resolveHeroIntensity(
  aiHero: { intensity?: number; explosionRadius?: number } | undefined | null,
): number {
  const raw = Number(aiHero?.intensity);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  const radius = Number(aiHero?.explosionRadius);
  if (Number.isFinite(radius)) return Math.max(0, Math.min(1, radius / 150));
  return 0.4;
}

/** Map the 0..1 intensity to the exploded dispersion radius (0..150 mm). */
export function intensityToRadius(intensity: number): number {
  const n = Number.isFinite(intensity) ? intensity : 0.4;
  return Math.round(Math.max(0, Math.min(1, n)) * 150);
}

/** Map the 0..1 intensity to an animation speed multiplier (0.5×..2×). */
export function intensityToSpeed(intensity: number): number {
  const n = Number.isFinite(intensity) ? intensity : 0.4;
  return 0.5 + Math.max(0, Math.min(1, n)) * 1.5;
}

export function defaultAiHeroSettings(): AiHeroSettings {
  return {
    enabled: true,
    preset: 'exploded_rebuild',
    prompt: '',
    opacity: 0.55,
    explosionRadius: 60,
    intensity: 0.4,
    speed: 1,
    motionType: 'spin',
    particleCount: 50_000,
    depthBlur: 30,
    animationLoop: 'spin',
    assemblyProgress: 1,
    paletteAutoSync: true,
    accentA: '',
    accentB: '',
    accentC: '',
    containerTarget: 'background',
    canvasHeight: 'medium',
    blendMode: 'normal',
    heroHeight: 'standard',
    heroHeightPx: 480,
    maxWidth: 720,
    cornerRadius: 26,
    padding: 28,
    targetProductId: '',
    targetProductName: '',
    productSilhouette: '',
    textDistribution: 'centered',
    contrastScrim: 0,
    renderMode: 'live',
    clips: [],
  };
}


