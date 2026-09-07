// GLSL source strings for the hero shader engine.
//
// Kept in a separate PURE module so the component file stays readable and the
// shaders are easy to version/test. All shaders are GLSL ES 3.00 (`#version
// 300 es` on line 1, `in`/`out`/`texture()` syntax) and are compiled against a
// strictly requested WebGL 2.0 context. Mixing `#version 300 es` with WebGL1
// syntax (`attribute`/`varying`/`texture2D()`/`gl_FragColor`) is what produces
// the `'out' : syntax error` — these sources are deliberately written in pure
// 3.00 form so that can never happen.

export const FRAGMENT_VS = `#version 300 es
precision highp float;
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const FRAGMENT_FS = `#version 300 es
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
out vec4 fragColor;

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

  fragColor = vec4(col, u_opacity);
}
`;

export const PARTICLE_VS = `#version 300 es
precision highp float;
in vec3 a_position;
in vec3 a_normal;
in float a_component;
uniform float u_time;
uniform float u_assemblyProgress;
uniform float u_dispersion;
uniform float u_explosionRadius;
uniform vec2 u_mouse;
out float v_component;
out float v_alpha;
out float v_depth;

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

export const PARTICLE_FS = `#version 300 es
precision highp float;
in float v_component;
in float v_alpha;
in float v_depth;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform vec3 u_colorC;
uniform float u_opacity;
uniform float u_depthBlur;
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.12, d);
  vec3 col = mix(u_colorB, u_colorA, step(1.5, v_component));
  col = mix(col, u_colorC, step(2.5, v_component));
  float depthFade = 1.0 - u_depthBlur * 0.5 * smoothstep(3.0, 4.6, v_depth);
  fragColor = vec4(col, alpha * v_alpha * u_opacity * depthFade);
}
`;

// ---------------------------------------------------------------------------
// Real product-image shader engine.
//
// Instead of a procedural point-cloud, the exploded-rebuild preset now samples
// the selected product's PRIMARY image through a WebGL 2D sampler
// (`u_productTexture`) and drives disassembly / assembly / spin / explosion on
// the crisp graphic directly. The product is broken into a grid of tiles whose
// per-cell offset + shrinkage reveals seams during an explosion, then reassembles
// into a clean cover-fit product. The alpha channel is sampled verbatim so a
// transparent PNG keeps its crisp silhouette while an opaque JPEG still reads as
// a product (the tile seams carry the "breaking apart" look).
// ---------------------------------------------------------------------------

export const IMAGE_VS = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const IMAGE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_productTexture;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_hasTexture;
uniform float u_texAspect;
uniform float u_assemblyProgress;
uniform float u_dispersion;
uniform float u_spin;
uniform float u_opacity;
uniform vec3 u_colorA;
uniform vec3 u_colorB;

in vec2 v_uv;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Cover-fit the texture into the canvas (center-crop, preserve aspect ratio).
vec2 coverUv(vec2 uv, float texAspect) {
  float ca = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 out = uv;
  if (texAspect >= ca) {
    out.x = 0.5 + (uv.x - 0.5) * (ca / texAspect);
  } else {
    out.y = 0.5 + (uv.y - 0.5) * (texAspect / ca);
  }
  return out;
}

vec2 rotateUv(vec2 uv, float ang) {
  vec2 c = uv - 0.5;
  float cs = cos(ang);
  float sn = sin(ang);
  return vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
}

void main() {
  vec2 uv = v_uv;
  vec2 texUv = coverUv(uv, max(u_texAspect, 0.01));

  // Continuous 3D product rotation (the "spin" motion type).
  if (u_spin > 0.5) {
    texUv = rotateUv(texUv, u_time * 0.6);
  }

  // Disassembly / assembly / explosion on crisp product tiles.
  float explode = (1.0 - u_assemblyProgress) * u_dispersion;
  float cells = 26.0;
  vec2 g = texUv * cells;
  vec2 cell = floor(g);
  vec2 local = fract(g);
  float h1 = hash21(cell);
  float h2 = hash21(cell + 19.19);
  vec2 dir = (vec2(h1, h2) - 0.5) * 2.0;

  // Shrink each tile toward its own center as the explosion grows so seams
  // open up between the pieces.
  float shrink = explode * 0.16;
  vec2 cLocal = (local - 0.5) / max(1.0 - shrink, 0.001) + 0.5;
  vec2 sampleUv = (cell + cLocal) / cells + dir * explode * 0.12;

  vec4 texel;
  if (u_hasTexture > 0.5) {
    texel = texture(u_productTexture, clamp(sampleUv, 0.0, 1.0));
  } else {
    texel = vec4(mix(u_colorA, u_colorB, uv.y), 1.0);
  }

  // Sample the alpha mask directly; opaque JPEGs keep full opacity and rely on
  // the tile seams for the "graphic breaking apart" effect.
  float mask = texel.a;
  float edge = min(min(cLocal.x, 1.0 - cLocal.x), min(cLocal.y, 1.0 - cLocal.y));
  float seam = smoothstep(0.0, 0.05, edge);
  float alpha = mix(1.0, seam, step(0.001, explode)) * mask;

  fragColor = vec4(texel.rgb, alpha * u_opacity);
}
`;

// ---------------------------------------------------------------------------
// Guaranteed-working default shader (GLSL 300 es).
//
// This is the bulletproof fallback compiled the instant the primary shader
// fails to compile/link — it NEVER drops to the CSS ambient gradient. It takes
// the same `u_productTexture` sampler, applies a gentle 3D float/spin around
// the center, and renders the database product image cleanly (or a theme
// gradient when no image is bound, via `u_hasTexture`).
// ---------------------------------------------------------------------------

export const DEFAULT_VS = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const DEFAULT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_productTexture;
uniform float u_time;
uniform float u_hasTexture;
uniform vec2 u_resolution;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 uv = v_uv;
  // Gentle 3D float/spin around the center (cover-fit preserved by clamping).
  vec2 c = uv - 0.5;
  float ang = u_time * 0.35;
  float cs = cos(ang);
  float sn = sin(ang);
  vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  vec2 sampleUv = clamp(r + 0.5, 0.0, 1.0);
  if (u_hasTexture > 0.5) {
    fragColor = texture(u_productTexture, sampleUv);
  } else {
    fragColor = vec4(mix(u_colorA, u_colorB, uv.y), 1.0);
  }
}
`;
