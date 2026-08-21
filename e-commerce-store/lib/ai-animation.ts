/**
 * AI MULTIMEDIA PIPELINE — image-to-animation + dynamic SVG asset generation.
 *
 * The pipeline is: resolve an AI driver (AiFactory) → build a structured prompt
 * → `driver.complete(prompt)` → parse the JSON the model returns. If no key is
 * present OR the API call fails OR the model returns garbage, the pipeline
 * FALLS BACK to pure-CSS transition presets + static vector overlays so an
 * admin never sees a broken asset.
 *
 * This file is deliberately ZERO-import (no `@/`) so `node --test` loads the
 * prompt/parse/fallback pure functions directly, matching drop-timestamps.ts.
 */

export interface AnimationKeyframe {
  at: string;
  styles: Record<string, string>;
}

export interface AnimationResult {
  source: 'ai' | 'fallback';
  /** Compiled CSS keyframes string (source 'ai' only). */
  css?: string;
  /** Static/animated SVG markup string. */
  svg?: string;
  /** Parsed keyframes (source 'ai' only). */
  keyframes?: AnimationKeyframe[];
  durationMs: number;
  provider?: string;
  preset?: string;
}

/** Built-in fallbacks — pure-CSS transition presets + static vector overlays. */
export const FALLBACK_ANIMATION_PRESETS: ReadonlyArray<{ id: string; label: string; durationMs: number }> = [
  { id: 'drift', label: 'Slow drift', durationMs: 6000 },
  { id: 'pulse', label: 'Soft pulse', durationMs: 2600 },
  { id: 'shimmer', label: 'Shimmer sweep', durationMs: 3200 },
];

/** A static vector overlay (brand-neutral, no external deps). */
export function staticSvgOverlay(): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 280">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>' +
    '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>' +
    '<rect width="560" height="280" fill="url(#g)"/>' +
    '</svg>'
  );
}

/** The built-in fallback animation for a preset id (unknown → drift). */
export function fallbackAnimation(preset?: string): AnimationResult {
  const id = FALLBACK_ANIMATION_PRESETS.some((p) => p.id === preset) ? (preset as string) : 'drift';
  const durationMs = FALLBACK_ANIMATION_PRESETS.find((p) => p.id === id)?.durationMs ?? 6000;
  return {
    source: 'fallback',
    svg: staticSvgOverlay(),
    css: buildFallbackCss(id, durationMs),
    durationMs,
    preset: id,
  };
}

/** Compile one of the built-in CSS presets into a keyframes string. */
export function buildFallbackCss(id: string, durationMs: number): string {
  const ms = Math.max(1, Math.floor(durationMs));
  if (id === 'pulse') {
    return `@keyframes goyunir-ai-pulse { 0%,100% { opacity:0.85; transform:scale(1); } 50% { opacity:1; transform:scale(1.035); } } .goyunir-ai { animation: goyunir-ai-pulse ${ms}ms ease-in-out infinite; }`;
  }
  if (id === 'shimmer') {
    return `@keyframes goyunir-ai-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } } .goyunir-ai { animation: goyunir-ai-shimmer ${ms}ms linear infinite; }`;
  }
  return `@keyframes goyunir-ai-drift { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(0,-12px,0); } } .goyunir-ai { animation: goyunir-ai-drift ${ms}ms ease-in-out infinite; }`;
}

/** Build the structured prompt sent to the AI provider. The model is asked to
 *  return ONLY JSON with a `css` (keyframes) and/or `svg` string. */
export function buildAnimationPrompt(params: { assetRef: string; prompt?: string }): string {
  const asset = String(params.assetRef || '').trim() || 'the uploaded product photo';
  const extra = String(params.prompt || '').trim();
  return [
    'You are a motion designer generating product asset animations.',
    `Asset: ${asset}`,
    extra ? `Instruction: ${extra}` : 'Instruction: create a subtle, premium loop animation.',
    'Return ONLY a JSON object (no markdown fences) with these optional keys:',
    '  "css"  — a valid CSS @keyframes string using the class .goyunir-ai',
    '  "svg"  — an SVG string (animated with SMIL or CSS)',
    '  "keyframes" — [ { "at": "0%", "styles": { "opacity": "1" } }, ... ]',
    '  "durationMs" — integer loop duration',
  ].join('\n');
}

/** Parse the model's (possibly markdown-fenced) JSON into a normalized result.
 *  Returns null when the text is not usable → caller falls back. */
export function parseAnimationResult(text: string, provider?: string): AnimationResult | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let jsonText = raw;
  // Strip a ```json / ``` fence if the model wrapped its answer.
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

  const css = typeof parsed.css === 'string' ? parsed.css.trim() : '';
  const svg = typeof parsed.svg === 'string' ? parsed.svg.trim() : '';
  const keyframes = Array.isArray(parsed.keyframes)
    ? parsed.keyframes.filter((k): k is AnimationKeyframe => Boolean(k && typeof k === 'object' && typeof (k as AnimationKeyframe).at === 'string'))
    : undefined;
  const durationMs = Number(parsed.durationMs);
  if (!css && !svg && !keyframes?.length) return null;

  return {
    source: 'ai',
    css: css || undefined,
    svg: svg || undefined,
    keyframes: keyframes?.length ? keyframes : undefined,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : 4000,
    provider,
  };
}
