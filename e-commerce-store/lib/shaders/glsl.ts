// GLSL source strings for the hero shader engine.
//
// Kept in a separate PURE module so the component file stays readable and the
// shaders are easy to version/test. All shaders are GLSL ES 1.00 (compatible
// with both WebGL1 and WebGL2 contexts).

export const FRAGMENT_VS = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const FRAGMENT_FS = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform vec3 u_colorC;
uniform float u_mode;         // 0 dark_organic, 1 cyber_mesh, 2 ambient_glass
uniform float u_opacity;
uniform float u_viscosity;
uniform float u_warpFrequency;
uniform float u_turbulence;
uniform float u_depthBlur;

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
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float mapGlass(vec3 p) {
  float body = sdRoundBox(p - vec3(0.0, 0.0, 0.0), vec3(0.28, 0.55, 0.28), 0.18);
  float cap = sdRoundBox(p - vec3(0.0, 0.72, 0.0), vec3(0.18, 0.22, 0.18), 0.08);
  float neck = length(p - vec3(0.0, 1.05, 0.0)) - 0.07;
  return min(body, min(cap, neck));
}
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(1.0, -1.0) * 0.0007;
  return normalize(
    e.xyy * mapGlass(p + e.xyy) +
    e.yyx * mapGlass(p + e.yyx) +
    e.yxy * mapGlass(p + e.yxy) +
    e.xxx * mapGlass(p + e.xxx)
  );
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;
  float t = u_time * 0.12;
  vec3 col;

  if (u_mode < 0.5) {
    float sp = mix(0.3, 1.0, u_warpFrequency);
    vec2 q = vec2(noise(p * sp + vec2(0.0, t)), noise(p * sp + vec2(5.2, 1.3) - t));
    float r = noise(p * sp + q * (0.9 + u_turbulence) + vec2(t * 0.4));
    col = mix(u_colorA, u_colorB, r);
    col = mix(col, u_colorC, noise(p * sp + q * 2.0));
  } else if (u_mode < 1.5) {
    float grid = 0.0;
    vec2 g = p * 9.0;
    vec2 gi = floor(g);
    vec2 gf = fract(g) - 0.5;
    float dist = length(gf);
    float pulse = 0.5 + 0.5 * sin(t * 2.0 - length(g) * 0.8 + u_time * 0.6);
    grid += smoothstep(0.18, 0.05, dist) * pulse;
    float wave = sin(p.y * 6.0 + t * 2.0 + p.x * 1.5) * 0.5 + 0.5;
    wave += sin(length(p - u_mouse * 0.5) * 9.0 - u_time * 3.0) * 0.5;
    col = mix(u_colorA, u_colorB, wave);
    col += u_colorC * grid * 0.8;
  } else {
    vec3 ro = vec3(0.0, 0.0, 3.6);
    vec3 rd = normalize(vec3(p, -1.6));
    float tRay = 0.0;
    float hit = 0.0;
    for (int i = 0; i < 64; i++) {
      vec3 pos = ro + rd * tRay;
      float d = mapGlass(pos);
      if (d < 0.001) { hit = 1.0; break; }
      tRay += d * 0.7;
      if (tRay > 20.0) break;
    }
    if (hit > 0.5) {
      vec3 pos = ro + rd * tRay;
      vec3 n = calcNormal(pos);
      float fres = pow(1.0 - clamp(dot(-rd, n), 0.0, 1.0), 3.0);
      float spec = pow(clamp(dot(reflect(rd, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 24.0);
      vec3 base = mix(u_colorA, u_colorB, n.y * 0.5 + 0.5);
      float depthFade = 1.0 - u_depthBlur * 0.4;
      col = mix(base, u_colorC, fres * 0.7) + spec * u_colorC * depthFade;
    } else {
      col = mix(u_colorA, u_colorB, fbm(p * 1.4 + vec2(t * 0.3))) * 0.35;
    }
  }

  gl_FragColor = vec4(col, u_opacity);
}
`;

export const PARTICLE_VS = `
precision highp float;
attribute vec3 a_position;
attribute vec3 a_normal;
attribute float a_component;
uniform float u_time;
uniform float u_assemblyProgress;
uniform float u_dispersion;
uniform float u_explosionRadius;
uniform vec2 u_mouse;
varying float v_component;
varying float v_alpha;
varying float v_depth;

void main() {
  vec3 dir = normalize(a_normal + 0.4 * normalize(a_position + 0.0001));
  float explode = (1.0 - u_assemblyProgress) * u_dispersion * u_explosionRadius;
  vec3 p = a_position + dir * explode;

  float t = u_time * 0.35;
  float cy = cos(t);
  float sy = sin(t);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  float cx = cos(u_mouse.y * 0.5 + u_time * 0.08);
  float sx = sin(u_mouse.y * 0.5 + u_time * 0.08);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);

  float fov = 2.4;
  float zc = p.z + 3.4;
  vec2 ndc = vec2(p.x, p.y) * fov / zc;
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = mix(1.0, 2.1, u_assemblyProgress) * (1.0 / zc) * 2.6;
  v_component = a_component;
  v_depth = zc;
  v_alpha = 0.65 + 0.35 * smoothstep(0.0, 1.0, u_assemblyProgress);
}
`;

export const PARTICLE_FS = `
precision highp float;
varying float v_component;
varying float v_alpha;
varying float v_depth;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform vec3 u_colorC;
uniform float u_opacity;
uniform float u_depthBlur;

void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.12, d);
  vec3 col = mix(u_colorB, u_colorA, step(1.5, v_component));
  col = mix(col, u_colorC, step(2.5, v_component));
  float depthFade = 1.0 - u_depthBlur * 0.5 * smoothstep(3.0, 4.6, v_depth);
  gl_FragColor = vec4(col, alpha * v_alpha * u_opacity * depthFade);
}
`;
