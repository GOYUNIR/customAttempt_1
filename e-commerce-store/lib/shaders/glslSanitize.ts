// GLSL 300 es sanitizer — the single source of truth for guaranteeing that any
// shader string handed to the WebGL 2.0 compiler is valid `#version 300 es`.
//
// WebGL 2.0 shaders MUST open with `#version 300 es` as the very first line
// (character 0 of line 1) AND use `in`/`out`/`texture()` (not `attribute`/
// `varying`/`texture2D()`/`gl_FragColor`). An AI provider (or a future
// contributor) that emits markdown-fenced GLSL, leading conversational text, or
// a duplicate `#version` directive produces the classic `ERROR: 0:1: 'out' :
// syntax error`. This module strips all of that noise and re-emits a clean,
// deterministic `#version 300 es` header so the renderer can never hit that
// failure mode.
//
// PURE module (no React, no `@/` value imports) so `node --test` loads it.

/** Extract the GLSL from a markdown code fence (```glsl …``` / ``` …```). */
export function extractGlslFence(src: string): string {
  const s = String(src ?? '');
  const fence = s.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  return fence ? fence[1] : s;
}

/** Strip any leading conversational text before the first GLSL marker. */
export function stripLeadingText(src: string): string {
  const s = String(src ?? '');
  const marker = s.search(
    /(#\s*version\b|precision\b|\buniform\b|\battribute\b|\bvarying\b|\bin\s+[a-zA-Z_]\w*\s|\bout\s+[a-zA-Z_]\w*\s|\bvoid\s+main\b)/,
  );
  if (marker === -1) return s;
  const lineStart = s.lastIndexOf('\n', marker);
  return s.slice(lineStart + 1);
}

/** Remove every `#version` directive — we own the version line. */
export function stripVersionDirective(src: string): string {
  return String(src ?? '')
    .split('\n')
    .filter((line) => !/^\s*#\s*version\b/i.test(line))
    .join('\n');
}

/** Prepend the exact WebGL 2.0 header (must be the very first characters). */
export function prependVersionDirective(src: string): string {
  return `#version 300 es\nprecision highp float;\n${String(src ?? '').trim()}`;
}

/**
 * Sanitize an arbitrary GLSL string into a guaranteed-valid `#version 300 es`
 * source:
 *   1. Strip markdown code fences + leading conversational text.
 *   2. Remove any existing `#version` directives.
 *   3. Drop a leading `precision` declaration so our prepend is the only one.
 *   4. Prepend exactly `#version 300 es\nprecision highp float;\n`.
 *
 * Idempotent: applying it to already-clean 300 es output is a no-op.
 */
export function sanitizeGlslSource(src: string): string {
  let s = stripLeadingText(extractGlslFence(String(src ?? '')));
  s = stripVersionDirective(s).trim();
  s = s.replace(/^precision\s+highp\s+float\s*;/i, '').trim();
  return prependVersionDirective(s);
}
