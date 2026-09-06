// Smart AI prompt interpreter — inspects a free-text prompt and derives render
// uniforms for the hero shader engine.
//
// PURE module (no React / no `@/` value imports) so `node --test` can load it.
// It is deliberately deterministic: a natural-language prompt is mapped onto a
// bounded, typed parameter set (mode, assembly timeline, dispersion, fluid
// viscosity, warp frequency, turbulence, product silhouette) so a hallucinated
// key can never reach the GPU.

import { normalizeSilhouette, SILHOUETTE_KEYS, type ProductTarget } from './productTarget.ts';

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
  /** Continuous 3D rotation (spinning geometry) requested by the prompt. */
  spin: boolean;
  /** Bound product silhouette key, or null. */
  productSilhouette: string | null;
}

const EXPLODED_RE = /\b(exploded|explode|construction|rebuild|re-?build|assemble|assembly|disassembly|disassemble)\b/i;
// Generic container/shape descriptors only — a natural-language prompt maps onto
// a silhouette KEY, never a specific product. No brand/product-name tokens live
// here (zero hardcoded product assumptions).
const PRODUCT_RE = /\b(perfume|bottle|bottles|atomizer|atomiser|nozzle|spray|fragrance|flacon|vessel|cap|container)\b/i;
const FLUID_RE = /\b(fluid|liquid|smoke|organic|viscous|flow|molten|warp|swirl|drift)\b/i;
const GLASS_RE = /\b(glass|refract|refraction|raymarch|raymarched|prism|crystal|gem|caustic)\b/i;
const PARTICLE_RE = /\b(particle|particles|dust|cosmic|mesh|grid|wireframe|points|stars|embers)\b/i;
const SPIN_RE = /\b(spin|spinning|rotate|rotation|rotating|geometry|shape|logo)\b/i;

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
    spin: base.spin ?? false,
    productSilhouette: base.productSilhouette ?? null,
  };

  if (EXPLODED_RE.test(text)) {
    params.mode = 'exploded';
    // An exploded/assembly prompt drives the timeline down and dispersion up.
    params.assemblyProgress = clamp01(params.assemblyProgress);
    params.dispersion = clamp01(params.dispersion * 1.5 + 0.35);
  }
  if (PARTICLE_RE.test(text)) params.mode = 'particle';
  if (SPIN_RE.test(text)) {
    // Spinning geometry / rotating shapes → continuous 3D rotation. When no
    // stronger primitive is requested, the particle engine renders a rotating
    // point-cloud mesh.
    params.spin = true;
    if (!EXPLODED_RE.test(text) && !PARTICLE_RE.test(text) && !GLASS_RE.test(text)) {
      params.mode = 'particle';
    }
  }
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
    else if (word === 'flacon' || word === 'fragrance' || word === 'perfume') params.productSilhouette = 'bottle';
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
  { label: 'Spinning Geometry', prompt: 'Spinning geometry — rotating 3D shapes, mesh, continuous rotation' },
  { label: 'Particle Rebuild', prompt: 'Particle rebuild — cosmic dust, points, assemble' },
  { label: 'Liquid Glass', prompt: 'Liquid glass — refractive raymarched crystal' },
  { label: 'Slow Motion Drift', prompt: 'Slow motion drift — fluid organic smoke, gentle viscous warp' },
];

/**
 * Map a parsed prompt onto the canonical hero preset id the engine renders, so
 * the admin "Execute Prompt & Generate Preview" action can update the live
 * canvas from natural language without any hardcoded product/brand mapping.
 */
export function paramsToPreset(params: ShaderParams): string {
  switch (params.mode) {
    case 'exploded':
      return 'exploded_rebuild';
    case 'glass':
      return 'ambient_glass';
    case 'particle':
      return 'cyber_mesh';
    default:
      return 'dark_organic';
  }
}

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

/**
 * Deterministic compile of a prompt + live product target into bounded render
 * uniforms. The selected product's silhouette is injected only when the prompt
 * text itself did not already bind one, so the admin "Execute" action always
 * renders the chosen catalog item's shape without hardcoding any product.
 */
export function compileShaderParams(
  prompt: string,
  target: ProductTarget | null | undefined,
): ShaderParams {
  const params = parsePromptToParams(prompt);
  if (!params.productSilhouette && target) {
    params.productSilhouette = normalizeSilhouette(target.silhouette);
  }
  return params;
}

/**
 * Build the structured prompt sent to the AI provider for the hero shader. The
 * payload includes the selected product's metadata (name, slug, category,
 * silhouette) so the model compiles against a REAL catalog item — never a
 * hardcoded 'bottle' reference.
 */
export function buildShaderPrompt(payload: { prompt?: string; product?: ProductTarget | null }): string {
  const prompt = String(payload.prompt || '').trim();
  const product = payload.product || null;
  const lines: string[] = [
    'You are a shader-artist assistant compiling hero-banner render uniforms.',
  ];
  if (product) {
    lines.push(`Product: ${product.name || 'Untitled'}${product.slug ? ` (slug: ${product.slug})` : ''}`);
    lines.push(`Category: ${product.category || 'uncategorized'} · Silhouette: ${product.silhouette}`);
  }
  lines.push(`Instruction: ${prompt || 'create a premium, seamless-loop hero shader'}`);
  lines.push('Return ONLY a JSON object (no markdown fences) with these optional keys:');
  lines.push('  "mode" — one of "organic" | "exploded" | "particle" | "glass"');
  lines.push('  "assemblyProgress", "dispersion", "viscosity", "warpFrequency", "turbulence" — numbers 0..1');
  lines.push('  "spin" — boolean (continuous rotation)');
  lines.push(`  "productSilhouette" — one of ${JSON.stringify([...SILHOUETTE_KEYS])}`);
  return lines.join('\n');
}

const MODE_KEYS = new Set(['organic', 'exploded', 'particle', 'glass']);

function clampParam(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse the AI's (possibly markdown-fenced) JSON back into a bounded
 * `ShaderParams` object. Returns null when the text is unusable so the caller
 * falls back to the deterministic compiler — a hallucinated key can never
 * reach the GPU.
 */
export function parseShaderParamsResult(text: string): ShaderParams | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  else {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const base = parsePromptToParams('');
  const mode = typeof parsed.mode === 'string' && MODE_KEYS.has(parsed.mode)
    ? (parsed.mode as ShaderParams['mode'])
    : base.mode;
  const assemblyProgress = clampParam(parsed.assemblyProgress) ?? base.assemblyProgress;
  const dispersion = clampParam(parsed.dispersion) ?? base.dispersion;
  const viscosity = clampParam(parsed.viscosity) ?? base.viscosity;
  const warpFrequency = clampParam(parsed.warpFrequency) ?? base.warpFrequency;
  const turbulence = clampParam(parsed.turbulence) ?? base.turbulence;
  const spin = typeof parsed.spin === 'boolean' ? parsed.spin : base.spin;
  const productSilhouette =
    typeof parsed.productSilhouette === 'string' && parsed.productSilhouette.trim()
      ? normalizeSilhouette(parsed.productSilhouette)
      : base.productSilhouette;

  return {
    mode,
    assemblyProgress,
    dispersion,
    viscosity,
    warpFrequency,
    turbulence,
    spin,
    productSilhouette,
  };
}
