// Hero shader preset registry + the admin-editable settings shape.
//
// This module is PURE (no React, no `@/` value imports) so `node --test` can
// load it directly and the admin panel + storefront engine can share one
// source of truth for preset ids, legacy-id mapping and the aiHero settings
// contract without drifting.

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

export interface AiHeroSettings {
  enabled: boolean;
  preset: string;
  prompt: string;
  opacity: number;
  /** Explosion radius in mm (0–150) — mapped to the particle dispersion scale. */
  explosionRadius: number;
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
}

export const PARTICLE_COUNT_OPTIONS = [10_000, 50_000, 100_000] as const;

export const EXPLOSION_RADIUS_MIN = 0;
export const EXPLOSION_RADIUS_MAX = 150;

export function defaultAiHeroSettings(): AiHeroSettings {
  return {
    enabled: true,
    preset: 'dark_organic',
    prompt: '',
    opacity: 0.55,
    explosionRadius: 60,
    particleCount: 50_000,
    depthBlur: 30,
    animationLoop: 'pulse',
    assemblyProgress: 1,
    paletteAutoSync: true,
    accentA: '',
    accentB: '',
    accentC: '',
  };
}
