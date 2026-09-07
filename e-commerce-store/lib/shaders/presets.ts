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

export type AnimationLoopMode = 'pulse' | 'scroll' | 'mouse' | 'scrub';

/** Where the hero canvas paints relative to the hero card content. */
export type HeroContainerTarget = 'background' | 'banner';

/** Preset canvas heights for the inline banner placement (and the aspect hint). */
export type HeroCanvasHeight = 'slim' | 'medium' | 'expanded';

/** CSS blend mode the canvas composes against the hero card surface. */
export type HeroBlendMode = 'normal' | 'overlay' | 'screen';

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
  /** How the canvas blends with the hero card surface. */
  blendMode: HeroBlendMode;
  /** Live catalog item the hero shader targets (id/slug from `store:products`). */
  targetProductId?: string;
  /** Human name of the target product (echoed for the admin readout only). */
  targetProductName?: string;
  /** Generic silhouette key the exploded mesh derives from the target product. */
  productSilhouette?: string;
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
    preset: 'dark_organic',
    prompt: '',
    opacity: 0.55,
    explosionRadius: 60,
    intensity: 0.4,
    particleCount: 50_000,
    depthBlur: 30,
    animationLoop: 'pulse',
    assemblyProgress: 1,
    paletteAutoSync: true,
    accentA: '',
    accentB: '',
    accentC: '',
    containerTarget: 'background',
    canvasHeight: 'medium',
    blendMode: 'normal',
    targetProductId: '',
    targetProductName: '',
    productSilhouette: '',
  };
}


