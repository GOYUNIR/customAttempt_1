'use client';

import { useEffect, useRef } from 'react';
import { normalizePresetId, isExplodedPreset, type AnimationLoopMode } from '@/lib/shaders/presets';
import { extractAccentPalette, hexToRgb } from '@/lib/shaders/palette';
import { buildBottleGeometry } from '@/lib/shaders/bottleGeometry';
import { FRAGMENT_VS, FRAGMENT_FS, PARTICLE_VS, PARTICLE_FS } from '@/lib/shaders/glsl';

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
    const mem = Number(nav?.deviceMemory);
    if (Number.isFinite(cores) && cores > 0 && cores <= 2) return true;
    if (Number.isFinite(mem) && mem > 0 && mem <= 2) return true;
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
    case 'pulse':
    default:
      return clamp01(0.5 + 0.5 * Math.sin(time * 0.4));
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
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
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  return { program, vs, fs };
}

export default function HeroShaderCanvas({
  enabled = true,
  preset = 'dark_organic',
  colorA,
  colorB,
  colorC,
  opacity = 0.55,
  explosionRadius = 60,
  particleCount = 50_000,
  depthBlur = 30,
  animationLoop = 'pulse',
  assemblyProgress = 1,
  themeColors,
  interactive = false,
  onStatus,
  style,
}: {
  enabled?: boolean;
  preset?: string;
  colorA?: string;
  colorB?: string;
  colorC?: string;
  opacity?: number;
  explosionRadius?: number;
  particleCount?: number;
  depthBlur?: number;
  animationLoop?: AnimationLoopMode;
  assemblyProgress?: number;
  themeColors?: Record<string, any>;
  interactive?: boolean;
  onStatus?: (status: HeroShaderStatus) => void;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<HeroShaderStatus>({ backend: 'css', fps: 0 });

  useEffect(() => {
    if (!enabled) return;

    const canvas = canvasRef.current;
    const fallbackEl = canvas?.nextElementSibling as HTMLElement | null;
    const showFallback = () => {
      if (fallbackEl) fallbackEl.style.display = 'block';
      statusRef.current = { backend: 'css', fps: 0 };
      onStatus?.({ ...statusRef.current });
    };

    if (prefersReducedMotion() || isLowPower()) {
      showFallback();
      return;
    }
    if (!canvas) return;

    let gl: WebGLRenderingContext | null = null;
    let backend: ShaderBackend = 'css';
    try {
      gl = (canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        failIfMajorPerformanceCaveat: true,
      }) as WebGLRenderingContext | null) || null;
      if (gl) backend = 'webgl2';
    } catch {
      gl = null;
    }
    if (!gl) {
      try {
        gl = (canvas.getContext('webgl', {
          alpha: true,
          premultipliedAlpha: false,
          failIfMajorPerformanceCaveat: true,
        }) as WebGLRenderingContext | null) || null;
        if (gl) backend = 'webgl';
      } catch {
        gl = null;
      }
    }
    if (!gl) {
      showFallback();
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
    let pointCount = 0;
    let draw: (now: number, time: number, mouse: [number, number]) => void;

    if (exploded) {
      const linked = linkProgram(gl, PARTICLE_VS, PARTICLE_FS);
      if (!linked) {
        showFallback();
        return;
      }
      const { program, vs, fs } = linked;
      dispose.push(
        () => gl!.deleteProgram(program),
        () => gl!.deleteShader(vs),
        () => gl!.deleteShader(fs),
      );

      const geom = buildBottleGeometry(particleCount);
      pointCount = geom.pointCount;
      const buffer = gl.createBuffer();
      if (!buffer) {
        showFallback();
        return;
      }
      dispose.push(() => gl!.deleteBuffer(buffer));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      const stride = 7 * 4;
      const interleaved = new Float32Array(geom.pointCount * 7);
      for (let i = 0; i < geom.pointCount; i++) {
        interleaved[i * 7 + 0] = geom.points[i * 3];
        interleaved[i * 7 + 1] = geom.points[i * 3 + 1];
        interleaved[i * 7 + 2] = geom.points[i * 3 + 2];
        interleaved[i * 7 + 3] = geom.normals[i * 3];
        interleaved[i * 7 + 4] = geom.normals[i * 3 + 1];
        interleaved[i * 7 + 5] = geom.normals[i * 3 + 2];
        interleaved[i * 7 + 6] = geom.components[i];
      }
      gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);

      const posLoc = gl.getAttribLocation(program, 'a_position');
      const nrmLoc = gl.getAttribLocation(program, 'a_normal');
      const cmpLoc = gl.getAttribLocation(program, 'a_component');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(nrmLoc);
      gl.vertexAttribPointer(nrmLoc, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(cmpLoc);
      gl.vertexAttribPointer(cmpLoc, 1, gl.FLOAT, false, stride, 24);

      gl.useProgram(program);
      const uTime = gl.getUniformLocation(program, 'u_time');
      const uProgress = gl.getUniformLocation(program, 'u_assemblyProgress');
      const uDispersion = gl.getUniformLocation(program, 'u_dispersion');
      const uRadius = gl.getUniformLocation(program, 'u_explosionRadius');
      const uMouse = gl.getUniformLocation(program, 'u_mouse');
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorA'), ra, ga, ba);
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorB'), rb, gb, bb);
      gl.uniform3f(gl.getUniformLocation(program, 'u_colorC'), rc, gc, bc);
      gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), opacity01);
      gl.uniform1f(gl.getUniformLocation(program, 'u_depthBlur'), clamp01(Number(depthBlur) / 100));
      gl.uniform1f(uDispersion, 0.9);
      gl.uniform1f(uRadius, clamp01(Number(explosionRadius) / 150) * 1.6);

      draw = (_now, time, mouse) => {
        gl!.uniform1f(uTime, time);
        gl!.uniform2f(uMouse, mouse[0], mouse[1]);
        const prog = computeAssemblyProgress(animationLoop, assemblyProgress, time, mouse);
        gl!.uniform1f(uProgress, prog);
        gl!.drawArrays(gl!.POINTS, 0, pointCount);
      };
    } else {
      const linked = linkProgram(gl, FRAGMENT_VS, FRAGMENT_FS);
      if (!linked) {
        showFallback();
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
        showFallback();
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
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

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
    const start = performance.now();

    const render = (now: number) => {
      if (!running) return;
      draw(now, (now - start) / 1000, mouse);

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
      showFallback();
    };
    const onRestored = () => {
      if (fallbackEl) fallbackEl.style.display = 'none';
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const fn of dispose) {
        try {
          fn();
        } catch {
          /* context may already be lost */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, preset, colorA, colorB, colorC, opacity, explosionRadius, particleCount, depthBlur, animationLoop, assemblyProgress, interactive, themeColors]);

  if (!enabled) return null;

  const gradient = `linear-gradient(135deg, ${colorA || '#bf5af2'}, ${colorB || '#0071e3'}, ${colorC || '#ff375f'}, ${colorA || '#bf5af2'})`;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', ...style }} aria-hidden="true">
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

