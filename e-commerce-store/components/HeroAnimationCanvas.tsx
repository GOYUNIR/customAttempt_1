'use client';

import { useEffect, useRef } from 'react';

/**
 * GPU-accelerated hero shader — a lightweight full-screen fragment-shader canvas
 * that paints a slow, ambient color wash behind the home-page hero card.
 *
 * Design constraints:
 *   • ZERO hardcoded product data — colors arrive as theme accent props and the
 *     presets are generic procedural styles (ambient mesh / particle waves /
 *     dark organic). Nothing here names a product, price or brand.
 *   • WebGL is OPTIONAL: feature detection (+ `failIfMajorPerformanceCaveat`)
 *     plus `prefers-reduced-motion` and a low-power heuristic
 *     (few CPU cores / little device memory) fall back to a pure-CSS ambient
 *     gradient so low-power devices and throttled social webviews never pay the
 *     GPU cost.
 *   • The animation loop pauses when the tab is hidden and stops permanently
 *     when reduced-motion is on — no wasted frames.
 */

export type HeroShaderPreset = 'ambient_mesh' | 'particle_waves' | 'dark_organic';

export const HERO_SHADER_PRESETS: ReadonlyArray<{ id: HeroShaderPreset; label: string }> = [
  { id: 'ambient_mesh', label: 'Ambient mesh' },
  { id: 'particle_waves', label: 'Particle waves' },
  { id: 'dark_organic', label: 'Dark organic shader' },
];

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform vec3 u_colorC;
uniform float u_preset;
uniform float u_opacity;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;
  float t = u_time * 0.12;
  vec3 col;

  if (u_preset < 0.5) {
    // ambient mesh — soft drifting gradient blobs
    float a = noise(vec2(p.x * 1.5 + t, p.y * 1.5 - t * 0.7));
    float b = noise(vec2(p.x * 2.0 - t * 0.5, p.y * 2.0 + t * 0.4));
    col = mix(u_colorA, u_colorB, a);
    col = mix(col, u_colorC, b * 0.6);
  } else if (u_preset < 1.5) {
    // particle waves — flowing horizontal sine waves
    float w = sin(p.y * 6.0 + t * 2.0) * 0.5 + 0.5;
    w += sin(p.x * 5.0 - t * 1.5) * 0.5 + 0.5;
    w *= 0.5;
    col = mix(u_colorA, u_colorB, w);
    col += u_colorC * (sin(p.y * 14.0 + t * 4.0) * 0.5 + 0.5) * 0.35;
  } else {
    // dark organic — domain-warped value noise
    vec2 q = vec2(noise(p + vec2(0.0, t)), noise(p + vec2(5.2, 1.3) - t));
    float r = noise(p + q * 1.4 + vec2(t * 0.4));
    col = mix(u_colorA, u_colorB, r);
    col = mix(col, u_colorC, noise(p + q * 2.0));
  }

  gl_FragColor = vec4(col, u_opacity);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  if (h.length !== 6 || !Number.isFinite(num)) return [0.5, 0.5, 0.5];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

function presetIndex(preset: string | undefined): number {
  if (preset === 'particle_waves') return 1;
  if (preset === 'dark_organic') return 2;
  return 0;
}

/** True when the device should skip WebGL entirely (low-power / battery saver). */
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

export default function HeroAnimationCanvas({
  enabled = true,
  preset = 'ambient_mesh',
  colorA = '#bf5af2',
  colorB = '#0071e3',
  colorC = '#ff375f',
  opacity = 0.6,
  style,
}: {
  enabled?: boolean;
  preset?: HeroShaderPreset | string;
  colorA?: string;
  colorB?: string;
  colorC?: string;
  opacity?: number;
  style?: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const reducedMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const fallbackEl = canvasRef.current?.nextElementSibling as HTMLElement | null;
    if (fallbackEl) fallbackEl.style.display = 'none';

    // CSS ambient-gradient fallback: reduced-motion / low-power / no-WebGL.
    if (reducedMotion || isLowPower()) {
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = (canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false,
        failIfMajorPerformanceCaveat: true,
      }) as WebGLRenderingContext) || null;
    } catch {
      gl = null;
    }
    if (!gl) {
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl!.createShader(type);
      if (!shader) return null;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        gl!.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) {
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'u_time');
    const uRes = gl.getUniformLocation(program, 'u_resolution');
    const uA = gl.getUniformLocation(program, 'u_colorA');
    const uB = gl.getUniformLocation(program, 'u_colorB');
    const uC = gl.getUniformLocation(program, 'u_colorC');
    const uPreset = gl.getUniformLocation(program, 'u_preset');
    const uOpacity = gl.getUniformLocation(program, 'u_opacity');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const [ra, ga, ba] = hexToRgb(colorA);
    const [rb, gb, bb] = hexToRgb(colorB);
    const [rc, gc, bc] = hexToRgb(colorC);
    gl.uniform3f(uA, ra, ga, ba);
    gl.uniform3f(uB, rb, gb, bb);
    gl.uniform3f(uC, rc, gc, bc);
    gl.uniform1f(uPreset, presetIndex(preset));
    gl.uniform1f(uOpacity, Math.max(0, Math.min(1, Number(opacity) || 0)));

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

    let raf = 0;
    let running = true;
    const start = performance.now();
    const render = (now: number) => {
      if (!running) return;
      gl!.uniform1f(uTime, (now - start) / 1000);
      gl!.uniform2f(uRes, canvas.width, canvas.height);
      gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

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

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      gl!.deleteProgram(program);
      gl!.deleteShader(vs);
      gl!.deleteShader(fs);
      gl!.deleteBuffer(buffer);
    };
  }, [enabled, preset, colorA, colorB, colorC, opacity]);

  if (!enabled) return null;

  const gradient = `linear-gradient(135deg, ${colorA}, ${colorB}, ${colorC}, ${colorA})`;

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
          opacity: Math.max(0, Math.min(1, Number(opacity) || 0)),
        }}
      />
    </div>
  );
}
