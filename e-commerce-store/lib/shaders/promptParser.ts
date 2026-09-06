// Smart AI prompt interpreter — inspects a free-text prompt and derives render
// uniforms for the hero shader engine.
//
// PURE module (no React / no `@/` value imports) so `node --test` can load it.
// It is deliberately deterministic: a natural-language prompt is mapped onto a
// bounded, typed parameter set (mode, assembly timeline, dispersion, fluid
// viscosity, warp frequency, turbulence, product silhouette) so a hallucinated
// key can never reach the GPU.

export type ParsedMode = 'organic' | 'exploded' | 'particle' | 'glass';

export interface ShaderParams {
  mode: ParsedMode;
  /** 0..1 — assembly timeline for the exploded-rebuild mode. */
  assemblyProgress: number;
  /** 0..1 — radial dispersion amount for the exploded mode. */
  dispersion: number;
  /** Fluid viscosity (higher = slower, smoother domain warp). */
  viscosity: number;
  /** Domain-warping frequency. */
  warpFrequency: number;
  /** Turbulence strength. */
  turbulence: number;
  /** Bound product silhouette key, or null. */
  productSilhouette: string | null;
}

const EXPLODED_RE = /\b(exploded|explode|construction|rebuild|re-?build|assemble|assembly|disassembly|disassemble)\b/i;
const PRODUCT_RE = /\b(roccstar|perfume|bottle|bottles|atomizer|atomiser|nozzle|spray|fragrance|flacon|vessel|cap)\b/i;
const FLUID_RE = /\b(fluid|liquid|smoke|organic|viscous|flow|molten|warp|swirl)\b/i;
const GLASS_RE = /\b(glass|refract|refraction|raymarch|raymarched|prism|crystal|gem|caustic)\b/i;
const PARTICLE_RE = /\b(particle|particles|dust|cosmic|mesh|grid|wireframe|points|stars|embers)\b/i;

const normalize = (s: string) => String(s || '').toLowerCase().trim();

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

export function parsePromptToParams(prompt: string, base: Partial<ShaderParams> = {}): ShaderParams {
  const text = normalize(prompt);
  const params: ShaderParams = {
    mode: base.mode ?? 'organic',
    assemblyProgress: clamp01(base.assemblyProgress ?? 1),
    dispersion: clamp01(base.dispersion ?? 0.5),
    viscosity: clamp01(base.viscosity ?? 0.45),
    warpFrequency: clamp01(base.warpFrequency ?? 0.4),
    turbulence: clamp01(base.turbulence ?? 0.45),
    productSilhouette: base.productSilhouette ?? null,
  };

  if (EXPLODED_RE.test(text)) {
    params.mode = 'exploded';
    // An exploded/assembly prompt drives the timeline down and dispersion up.
    params.assemblyProgress = clamp01(params.assemblyProgress);
    params.dispersion = clamp01(params.dispersion * 1.5 + 0.35);
  }
  if (PARTICLE_RE.test(text)) params.mode = 'particle';
  if (GLASS_RE.test(text)) params.mode = 'glass';

  if (FLUID_RE.test(text)) {
    params.viscosity = clamp01(params.viscosity + 0.3);
    params.warpFrequency = clamp01(params.warpFrequency * 0.7 + 0.15);
    params.turbulence = clamp01(params.turbulence + 0.2);
  }

  const productMatch = PRODUCT_RE.exec(text);
  if (productMatch) {
    const word = productMatch[0].toLowerCase();
    if (word === 'atomiser') params.productSilhouette = 'atomizer';
    else if (word === 'flacon' || word === 'fragrance' || word === 'roccstar') params.productSilhouette = 'bottle';
    else params.productSilhouette = word;
  }

  return params;
}

export interface MagicPromptPill {
  label: string;
  prompt: string;
}

export const MAGIC_PROMPT_PILLS: ReadonlyArray<MagicPromptPill> = [
  { label: 'Exploded Bottle View', prompt: 'Exploded bottle view — construction, rebuild, assemble' },
  { label: 'Particle Assemble', prompt: 'Particle assemble — cosmic dust, points' },
  { label: 'Liquid Glass', prompt: 'Liquid glass — refractive raymarched crystal' },
  { label: 'Cosmic Dust', prompt: 'Cosmic dust — particles, embers, mesh' },
];

/** Deterministic "AI Auto-Enhance" — enriches a prompt without an external call. */
export function enhancePrompt(prompt: string): string {
  const base = normalize(prompt).replace(/\s+/g, ' ').trim();
  const clauses: string[] = [];
  if (base) clauses.push(base);
  const params = parsePromptToParams(base);
  if (params.mode === 'exploded') {
    clauses.push('slowly reassemble along surface normals with radial particle dispersion');
  } else if (params.mode === 'glass') {
    clauses.push('refractive raymarched glass, caustic highlights, depth blur');
  } else if (params.mode === 'particle') {
    clauses.push('flowing particle grid, cursor-reactive waves');
  } else {
    clauses.push('fluid domain warping, organic smoke, gentle turbulence');
  }
  if (params.productSilhouette) clauses.push(`${params.productSilhouette} silhouette`);
  clauses.push('elegant, luxury, seamless loop');
  return clauses.join(', ');
}
