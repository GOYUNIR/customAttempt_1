'use client';

import { Component, useEffect, useRef, type ReactNode } from 'react';
import { normalizePresetId, isExplodedPreset, LOOP_PERIOD_SECONDS, type AnimationLoopMode } from '@/lib/shaders/presets';
import { extractAccentPalette, hexToRgb } from '@/lib/shaders/palette';
import { FRAGMENT_VS, FRAGMENT_FS, IMAGE_VS, IMAGE_FS, DEFAULT_VS, DEFAULT_FS } from '@/lib/shaders/glsl';
import { sanitizeGlslSource } from '@/lib/shaders/glslSanitize';
import { buildGridGeometry } from '@/lib/shaders/gridGeometry';

/**
 * Hero shader engine — a multi-mode GPU renderer painted behind the home-page
 * hero card (and inside the admin live preview).
 *
 * Mode A (GLSL fragment shader): domain-warped organic, a cursor-reactive
 * grid/particle wave, and a raymarched refractive glass object.
 * Mode B (3D particle / exploded mesh): a procedurally generated perfume-bottle
 * point cloud that reassembles from a fully-exploded cloud to a polished hero
 * product along an interactive `u_assemblyProgress` timeline.
 *
 * Production guardrails:
 *   • ZERO hardcoded product data — colors arrive as theme accent vectors, and
 *     the only 3D asset is procedurally generated (no external models).
 *   • WebGL is OPTIONAL: feature detection (`failIfMajorPerformanceCaveat`),
 *     `prefers-reduced-motion`, and a low-power heuristic fall back to a pure-CSS
 *     ambient gradient.
 *   • Every GL resource (buffer, program, shaders) is deleted on unmount and
 *     recreated on preset/mode switch — no GPU memory leaks.
 *   • `webglcontextlost` degrades to the CSS gradient; `restored` re-shows the
 *     canvas without throwing.
 *   • The loop pauses when the tab is hidden and never starts under reduced motion.
 */

export type ShaderBackend = 'webgl2' | 'webgl' | 'css';

export interface HeroShaderStatus {
  backend: ShaderBackend;
  fps: number;
}

function isLowPower(): boolean {
  try {
    const nav = navigator as any;
    const cores = Number(nav?.hardwareConcurrency);
    // Only a genuinely constrained device (single core) opts out of WebGL.
    // `navigator.deviceMemory` is deliberately NOT consulted here — many capable
    // machines and remote/Virtualized browsers report 2GB (or omit it entirely),
    // which previously forced the engine into the CSS fallback far too eagerly.
    if (Number.isFinite(cores) && cores > 0 && cores <= 1) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** True when a URL shares the page origin (data:/blob:/root-relative are same-origin). */
function isSameOriginUrl(url: string): boolean {
  if (/^(data|blob):/i.test(url) || url.startsWith('/')) return true;
  try {
    const u = new URL(url);
    if (typeof window === 'undefined') return false;
    return u.protocol === window.location.protocol && u.host === window.location.host;
  } catch {
    return true;
  }
}

/**
 * Load a product image (data URL, same-origin `/media/…` ref, or a CDN URL)
 * into an `<img>` so the real-image shader can upload it as a WebGL texture.
 *
 * CORS is handled explicitly — this is the fix for "database product images
 * never bind to WebGL":
 *   • First we load with `crossOrigin = 'anonymous'`, which produces a
 *     CORS-clean bitmap that `texImage2D` is allowed to upload. This works for
 *     data URLs, same-origin `/media/…` refs and CDN buckets that send
 *     `Access-Control-Allow-Origin`.
 *   • If that fails (a CDN bucket omitting the CORS header — the classic
 *     cross-origin "taint"), we retry WITHOUT the attribute so the image still
 *     decodes for DISPLAY, but flag it `tainted` so the caller skips the
 *     (guaranteed-to-throw) `texImage2D` upload instead of letting a
 *     `SecurityError` silently destroy the WebGL context.
 *
 * Every failure is logged so an operator sees WHY a graphic is missing instead
 * of discovering it as an unexplained CSS fallback. Resolves `null` (never
 * throws/rejects) so the hero can never crash on a broken image.
 */
function loadProductImage(url: string): Promise<{ image: HTMLImageElement; tainted: boolean } | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || !url) {
      if (url) console.warn('[HeroShaderCanvas] Empty product image URL — texture disabled.');
      resolve(null);
      return;
    }

    const load = (crossOrigin: boolean): Promise<HTMLImageElement | null> =>
      new Promise((res) => {
        const img = new Image();
        if (crossOrigin) img.crossOrigin = 'anonymous';
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          res(ok ? img : null);
        };
        img.onload = () => done(true);
        img.onerror = () => done(false);
        const timer = setTimeout(() => {
          console.warn('[HeroShaderCanvas] Product image load timed out (8s).');
          done(false);
        }, 8000);
        img.src = url;
      });

    // Pass 1 — CORS-clean load (required for a WebGL texture upload).
    load(true).then((img) => {
      if (img) {
        resolve({ image: img, tainted: false });
        return;
      }
      // Pass 2 — a cross-origin CDN that omits `Access-Control-Allow-Origin`
      // still decodes without the CORS attribute, but the bitmap is tainted and
      // must NOT be uploaded to WebGL.
      if (/^https?:\/\//i.test(url) && !isSameOriginUrl(url)) {
        load(false).then((fallback) => {
          if (fallback) {
            console.warn(
              '[HeroShaderCanvas] Product image is cross-origin without CORS headers — tainted (WebGL upload skipped).',
            );
            resolve({ image: fallback, tainted: true });
          } else {
            console.error(`[HeroShaderCanvas] Product image failed to load (CORS + fallback): ${url}`);
            resolve(null);
          }
        });
        return;
      }
      console.error(`[HeroShaderCanvas] Product image failed to load (CORS/404/decode): ${url}`);
      resolve(null);
    });
  });
}

/**
 * Disable every enabled vertex-attribute array on the context. This is the fix
 * for `INVALID_OPERATION: drawArrays: no buffer is bound to enabled attribute`
 * — a stale attribute left enabled by a previous program (e.g. the 3-attribute
 * particle program) has no buffer once its VBO is deleted, so the next draw
 * throws. Disabling all attributes before teardown guarantees the next program
 * starts from a clean attribute table.
 */
function disableAllVertexAttribs(gl: WebGLRenderingContext): void {
  try {
    const max = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
    for (let i = 0; i < max; i++) {
      if (gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) {
        gl.disableVertexAttribArray(i);
      }
    }
  } catch {
    /* context may already be lost */
  }
}

function scrollProgress(): number {
  try {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(1, window.scrollY / max));
  } catch {
    return 0;
  }
}

function computeAssemblyProgress(
  loop: AnimationLoopMode,
  manual: number,
  time: number,
  mouse: [number, number],
): number {
  switch (loop) {
    case 'scrub':
      return clamp01(manual);
    case 'scroll':
      return scrollProgress();
    case 'mouse':
      return clamp01(1 - Math.hypot(mouse[0], mouse[1]) / 1.3);
    case 'spin':
      // Fully assembled — the product spins continuously via `u_time` in the
      // vertex shader without the explode/reassemble timeline ever moving.
      return 1;
    case 'pulse':
    default:
      // A canonical 4.0s loop so a pre-rendered WebM clip (recorded for exactly
      // LOOP_PERIOD_SECONDS / speed wall-clock seconds) loops seamlessly: the
      // phase at `time = 0` and `time = LOOP_PERIOD_SECONDS` is identical.
      return clamp01(0.5 + 0.5 * Math.sin((time * Math.PI * 2) / LOOP_PERIOD_SECONDS));
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[HeroShaderCanvas] GLSL shader compilation failed:', gl.getShaderInfoLog(shader) || 'unknown error');
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(
  gl: WebGLRenderingContext,
  vsSource: string,
  fsSource: string,
): { program: WebGLProgram; vs: WebGLShader; fs: WebGLShader } | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[HeroShaderCanvas] GLSL program link failed:', gl.getProgramInfoLog(program) || 'unknown error');
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  return { program, vs, fs };
}

/**
 * Link a program with a guaranteed-working fallback. When the primary GLSL
 * fails to compile/link (the `'out' : syntax error` class of failure), this
 * recompiles a bulletproof hardcoded GLSL 300 es textured quad (DEFAULT_VS /
 * DEFAULT_FS) instead of dropping to the CSS ambient gradient — so the badge
 * stays `WebGL 2.0 · N FPS` and the database product image still renders.
 */
function linkProgramWithFallback(
  gl: WebGLRenderingContext,
  vsSource: string,
  fsSource: string,
): { program: WebGLProgram; vs: WebGLShader; fs: WebGLShader; usedDefault: boolean } | null {
  const primary = linkProgram(gl, vsSource, fsSource);
  if (primary) return { ...primary, usedDefault: false };
  console.warn(
    '[HeroShaderCanvas] Primary GLSL failed to compile/link — retrying with the bulletproof default shader (no CSS fallback).',
  );
  const fallback = linkProgram(gl, sanitizeGlslSource(DEFAULT_VS), sanitizeGlslSource(DEFAULT_FS));
  if (fallback) return { ...fallback, usedDefault: true };
  return null;
}

export function HeroShaderCanvas({
  enabled = true,
  preset = 'dark_organic',
  colorA,
  colorB,
  colorC,
  opacity = 0.55,
  explosionRadius = 60,
  depthBlur = 30,
  animationLoop = 'pulse',
  assemblyProgress = 1,
  themeColors,
  interactive = false,
  onStatus,
  style,
  placement = 'background',
  blendMode = 'normal',
  productImageUrl,
  paused = false,
  speed = 1,
  twistIntensity = 0.5,
  onCanvasRef,
  onResetRef,
  respectReducedMotion = true,
}: {
  enabled?: boolean;
  preset?: string;
  colorA?: string;
  colorB?: string;
  colorC?: string;
  opacity?: number;
  explosionRadius?: number;
  /** @deprecated The procedural point-cloud engine was replaced by the textured-quad image shader. Accepted for backward compatibility; ignored. */
  particleCount?: number;
  depthBlur?: number;
  animationLoop?: AnimationLoopMode;
  assemblyProgress?: number;
  themeColors?: Record<string, any>;
  interactive?: boolean;
  onStatus?: (status: HeroShaderStatus) => void;
  style?: React.CSSProperties;
  /** `background` = fill the parent card behind its text; `banner` = inline block. */
  placement?: 'background' | 'banner';
  /** CSS mix-blend-mode applied to the canvas against the card surface. */
  blendMode?: 'normal' | 'overlay' | 'screen';
  /** @deprecated The procedural geometry was replaced by the product-image texture. Accepted for backward compatibility; ignored. */
  productSilhouette?: string;
  /** Primary product image URL (data URL / `/media/…` ref / CDN). The exploded preset samples it as a texture. */
  productImageUrl?: string;
  /** Freeze the animation timeline + particles (pause/resume control). */
  paused?: boolean;
  /** Animation speed multiplier (0.5×..2×) — scales the accumulated timeline. */
  speed?: number;
  /** Radial twist intensity (0..1) — drives `u_twistIntensity` in the 3D mesh. */
  twistIntensity?: number;
  /** Expose the live canvas element (admin clip recording). Null on unmount. */
  onCanvasRef?: (canvas: HTMLCanvasElement | null) => void;
  /** Register a timeline-reset function so clip recording can sync `u_time = 0`. */
  onResetRef?: (reset: (() => void) | null) => void;
  /** Honor `prefers-reduced-motion`. The admin Live Viewport Preview sets this
   *  false so an operator configuring the shader ALWAYS sees WebGL render. */
  respectReducedMotion?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<HeroShaderStatus>({ backend: 'css', fps: 0 });
  // Latest-value ref so toggling `paused` never tears down the GL context. The
  // ref is synced in an effect (never during render) and read by the RAF loop.
  const pausedRef = useRef<boolean>(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Latest-value ref for the speed multiplier — changing it must never tear down
  // the GL context (it only scales the timeline in the RAF loop).
  const speedRef = useRef<number>(Number.isFinite(speed) ? speed : 1);
  useEffect(() => {
    speedRef.current = Number.isFinite(speed) ? speed : 1;
  }, [speed]);

  // Latest-value ref for the canvas-exposure callback so a changing callback
  // identity (an inline arrow in the admin panel) never tears down the GL
  // context — it is only read inside the setup effect and its cleanup.
  const onCanvasRefRef = useRef<((canvas: HTMLCanvasElement | null) => void) | undefined>(onCanvasRef);
  useEffect(() => {
    onCanvasRefRef.current = onCanvasRef;
  }, [onCanvasRef]);

  // Latest-value ref for the timeline-reset registration so clip recording can
  // reset `u_time` to 0 without tearing down (or re-running) the GL setup.
  const onResetRefRef = useRef<((reset: (() => void) | null) => void) | undefined>(onResetRef);
  useEffect(() => {
    onResetRefRef.current = onResetRef;
  }, [onResetRef]);

  useEffect(() => {
    if (!enabled) return;

    const canvas = canvasRef.current;
    onCanvasRefRef.current?.(canvas);
    const fallbackEl = canvas?.nextElementSibling as HTMLElement | null;
    const showFallback = (reason?: string) => {
      // Log WHY we dropped to CSS instead of silently degrading — this is the
      // single most useful signal for "the hero shows a flat gradient".
      if (reason) console.warn(`[HeroShaderCanvas] WebGL → CSS ambient fallback: ${reason}`);
      if (fallbackEl) fallbackEl.style.display = 'block';
      statusRef.current = { backend: 'css', fps: 0 };
      onStatus?.({ ...statusRef.current });
    };

    if ((respectReducedMotion && prefersReducedMotion()) || isLowPower()) {
      showFallback(respectReducedMotion ? 'prefers-reduced-motion or low-power device' : 'low-power device');
      return;
    }
    if (!canvas) return;

    let gl: WebGL2RenderingContext | null = null;
    const backend: ShaderBackend = 'webgl2';
    try {
      // Strictly request a WebGL 2.0 context — the shaders are GLSL ES 3.00 and
      // MUST NOT be compiled against a WebGL1 context (that is the source of the
      // `'out' : syntax error`). `preserveDrawingBuffer: true` also lets the
      // admin clip recorder capture the canvas, and `antialias: true` keeps the
      // product texture crisp.
      gl = (canvas.getContext('webgl2', {
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
        // Software-rendered WebGL (SwiftShader / remote / VM) is still WebGL 2.0 —
        // requiring a hardware caveat-free context made the engine fall back to
        // the CSS gradient in dev/remote/Virtualized environments for no good
        // reason. The low-power + reduced-motion guards above still protect
        // genuinely constrained devices.
        failIfMajorPerformanceCaveat: false,
      }) as WebGL2RenderingContext | null) || null;
    } catch {
      gl = null;
    }
    if (!gl) {
      showFallback('WebGL 2.0 context unavailable');
      return;
    }

    const palette = extractAccentPalette(themeColors);
    const [ra, ga, ba] = colorA ? hexToRgb(colorA) : palette.a;
    const [rb, gb, bb] = colorB ? hexToRgb(colorB) : palette.b;
    const [rc, gc, bc] = colorC ? hexToRgb(colorC) : palette.c;
    const opacity01 = clamp01(Number(opacity) || 0);

    const canonical = normalizePresetId(preset);
    const exploded = isExplodedPreset(canonical);
    const modeIndex = canonical === 'cyber_mesh' ? 1 : canonical === 'ambient_glass' ? 2 : 0;

    const dispose: Array<() => void> = [];
    let draw: (now: number, time: number, mouse: [number, number]) => void;
    let cancelled = false;

    if (exploded) {
      // --- Real product-image shader (the overhauled exploded preset) ----------
      // This is the GUARANTEED WebGL fallback: a full-screen textured quad with
      // spin/assemble/disassembly deformation. It renders in WebGL even when the
      // AI returns simple or partial uniforms, and even when NO product image is
      // available — the in-shader `u_hasTexture=0` branch drives a gradient while
      // still applying the spin/assemble motion. It only drops to CSS if WebGL
      // itself is unavailable or this fixed GLSL fails to compile (which is logged).
      const linked = linkProgramWithFallback(gl, sanitizeGlslSource(IMAGE_VS), sanitizeGlslSource(IMAGE_FS));
      if (!linked) {
        showFallback('image shader AND default shader failed to link (GLSL compile/link error)');
        return;
      }
      const { program, vs, fs } = linked;
      dispose.push(
        () => gl!.deleteProgram(program),
        () => gl!.deleteShader(vs),
        () => gl!.deleteShader(fs),
      );

      // Subdivided 3D plane grid (32×32 shards) — the rich deconstruction mesh.
      // Each vertex carries [x, y, u, v] (stride 4 floats); the vertex shader
      // disassembles the grid into floating 3D shards, twists them radially,
      // and extrudes them by image luminance (a true 3D relief, not a flat quad).
      const grid = buildGridGeometry(32);
      const buffer = gl.createBuffer();
      if (!buffer) {
        showFallback('failed to allocate a vertex buffer for the image grid');
        return;
      }
      dispose.push(() => gl!.deleteBuffer(buffer));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.vertices, gl.STATIC_DRAW);

      const indexBuffer = gl.createBuffer();
      if (indexBuffer) {
        dispose.push(() => gl!.deleteBuffer(indexBuffer));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW);
      }

      const loc = gl.getAttribLocation(program, 'a_position');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, 0);
      }
      const uvLoc = gl.getAttribLocation(program, 'a_uv');
      if (uvLoc >= 0) {
        gl.enableVertexAttribArray(uvLoc);
        gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
      }

      // 1×1 placeholder so the sampler is ALWAYS bound to a valid texture even
      // while the real image is still loading (or if it never loads).
      const placeholder = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, placeholder);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      let currentTexture: WebGLTexture = placeholder;
      let textureToDispose: WebGLTexture = placeholder;
      dispose.push(() => {
        if (textureToDispose) gl!.deleteTexture(textureToDispose);
      });

      gl.useProgram(program);
      const uTime = gl.getUniformLocation(program, 'u_time');
      const uRes = gl.getUniformLocation(program, 'u_resolution');
      const uHasTex = gl.getUniformLocation(program, 'u_hasTexture');
      const uTexAspect = gl.getUniformLocation(program, 'u_texAspect');
      const uAssembly = gl.getUniformLocation(program, 'u_assemblyProgress');
      const uExplodeRadius = gl.getUniformLocation(program, 'u_explodeRadius');
      const uTwist = gl.getUniformLocation(program, 'u_twistIntensity');
      const uSpin = gl.getUniformLocation(program, 'u_spin');
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorA'), ra, ga, ba);
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorB'), rb, gb, bb);
      gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), opacity01);
      gl.uniform1i(gl.getUniformLocation(program, 'u_productTexture'), 0);

      let hasTexture = 0;
      let texAspect = 1;
      const spinOn = animationLoop === 'spin' ? 1 : 0;
      gl.uniform1f(uHasTex, 0);
      gl.uniform1f(uTexAspect, 1);
      gl.uniform1f(uExplodeRadius, clamp01(Number(explosionRadius) / 150));
      gl.uniform1f(uTwist, clamp01(Number(twistIntensity) || 0.5));
      gl.uniform1f(uSpin, spinOn);

      // Load the REAL product image asynchronously — the texture is only
      // uploaded AFTER the image has fully decoded (never block first paint,
      // never crash the hero). A CORS-tainted or failed image is logged and the
      // in-shader gradient fallback keeps the spin/assemble motion alive.
      loadProductImage(productImageUrl || '')
        .then((result) => {
          if (cancelled || !result) return;
          // A cross-origin bitmap without CORS headers is "tainted": WebGL would
          // throw a SecurityError (and can destroy the context) if we uploaded it.
          if (result.tainted) {
            console.warn('[HeroShaderCanvas] Skipping tainted texture upload — using in-shader gradient fallback.');
            return;
          }
          const img = result.image;
          const tex = gl!.createTexture();
          if (!tex) {
            console.error('[HeroShaderCanvas] Failed to create a WebGL texture for the product image.');
            return;
          }
          gl!.bindTexture(gl!.TEXTURE_2D, tex);
          gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
          try {
            gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, img);
          } catch (err) {
            gl!.deleteTexture(tex);
            console.error('[HeroShaderCanvas] WebGL texture upload failed (image may be tainted):', err);
            return;
          }
          gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
          // NPOT-safe: LINEAR min filter (no mipmaps) + clamp-to-edge.
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
          gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
          gl!.bindTexture(gl!.TEXTURE_2D, null);
          if (textureToDispose && textureToDispose !== tex) gl!.deleteTexture(textureToDispose);
          textureToDispose = tex;
          currentTexture = tex;
          hasTexture = 1;
          texAspect = (img.naturalWidth || img.width || 1) / Math.max(1, img.naturalHeight || img.height || 1);
          console.log(
            `[HeroShaderCanvas] Product texture bound (${img.naturalWidth || img.width}×${img.naturalHeight || img.height}).`,
          );
        })
        .catch((err) => {
          console.error('[HeroShaderCanvas] Product image load promise rejected:', err);
        });

      draw = (_now, time, mouse) => {
        gl!.activeTexture(gl!.TEXTURE0);
        gl!.bindTexture(gl!.TEXTURE_2D, currentTexture);
        gl!.uniform1f(uTime, time);
        gl!.uniform2f(uRes, canvas.width, canvas.height);
        gl!.uniform1f(uHasTex, hasTexture);
        gl!.uniform1f(uTexAspect, texAspect);
        const prog = computeAssemblyProgress(animationLoop, assemblyProgress, time, mouse);
        gl!.uniform1f(uAssembly, prog);
        gl!.uniform1f(uSpin, spinOn);
        gl!.drawElements(gl!.TRIANGLES, grid.indexCount, gl!.UNSIGNED_SHORT, 0);
      };
    } else {
      const linked = linkProgramWithFallback(gl, sanitizeGlslSource(FRAGMENT_VS), sanitizeGlslSource(FRAGMENT_FS));
      if (!linked) {
        showFallback('fragment shader AND default shader failed to link (GLSL compile/link error)');
        return;
      }
      const { program, vs, fs } = linked;
      dispose.push(
        () => gl!.deleteProgram(program),
        () => gl!.deleteShader(vs),
        () => gl!.deleteShader(fs),
      );

      const buffer = gl.createBuffer();
      if (!buffer) {
        showFallback('failed to allocate a vertex buffer for the fragment shader');
        return;
      }
      dispose.push(() => gl!.deleteBuffer(buffer));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const loc = gl.getAttribLocation(program, 'a_position');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }

      gl.useProgram(program);
      const uTime = gl.getUniformLocation(program, 'u_time');
      const uRes = gl.getUniformLocation(program, 'u_resolution');
      const uMouse = gl.getUniformLocation(program, 'u_mouse');
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorA'), ra, ga, ba);
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorB'), rb, gb, bb);
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorC'), rc, gc, bc);
      gl.uniform1f(gl.getUniformLocation(program, 'u_mode'), modeIndex);
      gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), opacity01);
      gl.uniform1f(gl.getUniformLocation(program, 'u_viscosity'), 0.45);
      gl.uniform1f(gl.getUniformLocation(program, 'u_warpFrequency'), 0.4);
      gl.uniform1f(gl.getUniformLocation(program, 'u_turbulence'), 0.45);
      gl.uniform1f(gl.getUniformLocation(program, 'u_depthBlur'), clamp01(Number(depthBlur) / 100));

      draw = (_now, time, mouse) => {
        gl!.uniform1f(uTime, time);
        gl!.uniform2f(uRes, canvas.width, canvas.height);
        gl!.uniform2f(uMouse, mouse[0], mouse[1]);
        gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      };
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // --- RENDER LOOP ---
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl!.viewport(0, 0, w, h);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const mouse: [number, number] = [0, 0];
    const onPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      mouse[0] = nx;
      mouse[1] = ny;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    let raf = 0;
    let running = true;
    let frames = 0;
    let fpsStart = performance.now();
    // Accumulated animation time — frozen while paused so resume is seamless
    // (the timeline + particles hold their last frame instead of jumping).
    let animTime = 0;
    let lastNow = performance.now();

    // Expose a timeline reset so clip recording can sync `u_time = 0` exactly —
    // this is what makes a pre-rendered WebM clip loop seamlessly (the first and
    // last captured frames are at the same phase).
    onResetRefRef.current?.(() => {
      animTime = 0;
    });

    const render = (now: number) => {
      if (!running) return;
      const dt = pausedRef.current ? 0 : Math.min(0.1, (now - lastNow) / 1000);
      lastNow = now;
      if (!pausedRef.current) animTime += dt;
      try {
        draw(now, animTime * speedRef.current, mouse);
      } catch {
        // A GPU context crash mid-draw must never take down the RAF loop (or
        // leak an unhandled exception). Degrade to the CSS ambient fallback and
        // stop scheduling frames — the fallback gradient keeps the hero alive.
        running = false;
        showFallback('GPU context crash mid-draw (draw call threw)');
        return;
      }

      frames++;
      const elapsed = now - fpsStart;
      if (interactive && elapsed >= 500) {
        const fps = Math.round((frames * 1000) / elapsed);
        frames = 0;
        fpsStart = now;
        statusRef.current = { backend, fps };
        onStatus?.({ ...statusRef.current });
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    if (interactive) {
      statusRef.current = { backend, fps: 0 };
      onStatus?.({ ...statusRef.current });
    }

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(render);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onLost = (e: Event) => {
      e.preventDefault();
      showFallback('WebGL context lost');
    };
    const onRestored = () => {
      if (fallbackEl) fallbackEl.style.display = 'none';
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    return () => {
      running = false;
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      // Clear the attribute table BEFORE deleting buffers so the next program
      // (effect re-run on preset/theme switch) never inherits an enabled
      // attribute whose buffer was just deleted — the source of the
      // `no buffer is bound to enabled attribute` drawArrays error.
      disableAllVertexAttribs(gl);
      for (const fn of dispose) {
        try {
          fn();
        } catch {
          /* context may already be lost */
        }
      }
      onCanvasRefRef.current?.(null);
      onResetRefRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, preset, colorA, colorB, colorC, opacity, explosionRadius, twistIntensity, depthBlur, animationLoop, assemblyProgress, interactive, themeColors, productImageUrl, respectReducedMotion]);

  if (!enabled) return null;

  const gradient = `linear-gradient(135deg, ${colorA || '#bf5af2'}, ${colorB || '#0071e3'}, ${colorC || '#ff375f'}, ${colorA || '#bf5af2'})`;
  const positionStyle: React.CSSProperties =
    placement === 'banner'
      ? { position: 'relative', inset: 'auto', width: '100%', height: '100%' }
      : { position: 'absolute', inset: 0, zIndex: 0 };
  const mixStyle: React.CSSProperties =
    blendMode && blendMode !== 'normal' ? { mixBlendMode: blendMode } : {};

  return (
    <div style={{ ...positionStyle, overflow: 'hidden', pointerEvents: 'none', ...mixStyle, ...style }} aria-hidden="true">
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'none',
          background: gradient,
          backgroundSize: '240% 240%',
          animation: 'goyunirZeroImage 9s ease-in-out infinite',
          opacity: clamp01(Number(opacity) || 0),
        }}
      />
    </div>
  );
}

type HeroShaderCanvasProps = React.ComponentProps<typeof HeroShaderCanvas>;

interface HeroShaderErrorBoundaryState {
  failed: boolean;
}

class HeroShaderErrorBoundary extends Component<
  { children: ReactNode },
  HeroShaderErrorBoundaryState
> {
  state: HeroShaderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): HeroShaderErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Log for the operator; never re-throw (the hero must degrade, not crash).
    try {
      console.error('[HeroShaderCanvas] GPU/render error captured by boundary:', error);
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/**
 * Default export wraps the WebGL engine in a React Error Boundary so a GPU
 * context crash during render/effect setup degrades to the hero card's own
 * background (the canvas unmounts) instead of white-screening the page. The
 * in-loop draw path is additionally guarded by an internal try/catch that flips
 * to the CSS ambient fallback, because async errors don't reach an error
 * boundary.
 */
export default function HeroShaderCanvasBoundary(props: HeroShaderCanvasProps) {
  return (
    <HeroShaderErrorBoundary>
      <HeroShaderCanvas {...props} />
    </HeroShaderErrorBoundary>
  );
}

