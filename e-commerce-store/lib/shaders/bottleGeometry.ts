// Procedural product geometry for the 3D exploded-rebuild engine.
//
// PURE module (no React / no `@/` imports / no DOM) so `node --test` can load
// it and the renderer can build the point cloud once on mount. There are NO
// external model files in the template — this generator IS the "procedural
// asset fallback" and the primary source: a normalized container decomposed
// into four components (cap, nozzle, vessel, label) as interleaved points +
// normals so the exploded view can push each point outward along its own
// normal. The shape is DERIVED from the target product's silhouette key
// (bottle / jar / box / card / tube) — never a hardcoded brand or product.

import { normalizeSilhouette } from './productTarget.ts';

export interface BottleGeometry {
  /** Interleaved xyz point positions (length = pointCount * 3). */
  points: Float32Array;
  /** Interleaved xyz normal vectors (length = pointCount * 3). */
  normals: Float32Array;
  /** Per-point component id: 0 cap, 1 nozzle, 2 vessel, 3 label. */
  components: Uint8Array;
  pointCount: number;
  /** Axis-aligned bounds in local (normalized) space. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Deterministic PRNG (mulberry32) so the bottle is stable across renders/tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Component budgets (cap, nozzle, vessel, label).
const COMPONENT_WEIGHTS = [0.22, 0.12, 0.5, 0.16];

export function buildBottleGeometry(pointCount: number, seed = 1337): BottleGeometry {
  const n = Math.max(100, Math.floor(pointCount) || 5000);
  const rng = mulberry32(seed);
  const points = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const components = new Uint8Array(n);

  const bounds = {
    min: [1e9, 1e9, 1e9] as [number, number, number],
    max: [-1e9, -1e9, -1e9] as [number, number, number],
  };

  const jitter = () => (rng() - 0.5) * 0.02;

  let cursor = 0;
  const emit = (x: number, y: number, z: number, nx: number, ny: number, nz: number, component: number) => {
    const i = cursor * 3;
    points[i] = x;
    points[i + 1] = y;
    points[i + 2] = z;
    normals[i] = nx;
    normals[i + 1] = ny;
    normals[i + 2] = nz;
    components[cursor] = component;
    bounds.min[0] = Math.min(bounds.min[0], x);
    bounds.min[1] = Math.min(bounds.min[1], y);
    bounds.min[2] = Math.min(bounds.min[2], z);
    bounds.max[0] = Math.max(bounds.max[0], x);
    bounds.max[1] = Math.max(bounds.max[1], y);
    bounds.max[2] = Math.max(bounds.max[2], z);
    cursor++;
  };

  const capN = Math.max(1, Math.floor(n * COMPONENT_WEIGHTS[0]));
  const nozzleN = Math.max(1, Math.floor(n * COMPONENT_WEIGHTS[1]));
  const vesselN = Math.max(1, Math.floor(n * COMPONENT_WEIGHTS[2]));
  const labelN = Math.max(1, Math.floor(n * COMPONENT_WEIGHTS[3]));

  // --- CAP (0): cylinder at the top, y in [0.78, 1.0] ---
  const capBottom = 0.78;
  const capTop = 1.0;
  const capRadius = 0.22;
  for (let k = 0; k < capN; k++) {
    const theta = rng() * Math.PI * 2;
    const y = capBottom + (capTop - capBottom) * rng();
    if (rng() < 0.7) {
      const r = capRadius + jitter();
      emit(Math.cos(theta) * r, y, Math.sin(theta) * r, Math.cos(theta), 0, Math.sin(theta), 0);
    } else {
      const rr = Math.sqrt(rng()) * capRadius;
      const isTop = rng() < 0.5;
      const yy = isTop ? capTop + jitter() : capBottom + jitter();
      emit(Math.cos(theta) * rr, yy, Math.sin(theta) * rr, 0, isTop ? 1 : -1, 0, 0);
    }
  }

  // --- NOZZLE (1): thin stem + spray head above the cap, y in [1.0, 1.32] ---
  for (let k = 0; k < nozzleN; k++) {
    const theta = rng() * Math.PI * 2;
    if (rng() < 0.6) {
      const y = 1.0 + 0.22 * rng();
      const r = 0.05 + jitter();
      emit(Math.cos(theta) * r, y, Math.sin(theta) * r, Math.cos(theta), 0, Math.sin(theta), 1);
    } else {
      const r = 0.09;
      const y = 1.18 + 0.12 * rng();
      emit(Math.cos(theta) * r, y, Math.sin(theta) * r, Math.cos(theta), 0.5, Math.sin(theta), 1);
    }
  }

  // --- VESSEL (2): glass body, y in [-0.8, 0.78], radius tapering at the shoulder ---
  for (let k = 0; k < vesselN; k++) {
    const theta = rng() * Math.PI * 2;
    const t = rng();
    const y = -0.8 + 1.58 * t;
    const baseR = 0.34;
    const shoulder = y > 0.55 ? 1 - (y - 0.55) / 0.23 : 1;
    const r = baseR * Math.max(0.42, shoulder) * (0.92 + 0.08 * Math.sin(theta * 4));
    const nx = Math.cos(theta) / 1.15;
    const ny = (y > 0.55 ? 1 : 0) * 0.4;
    const nz = Math.sin(theta) / 1.15;
    const len = Math.hypot(nx, ny, nz) || 1;
    emit(Math.cos(theta) * r + jitter(), y, Math.sin(theta) * r + jitter(), nx / len, ny / len, nz / len, 2);
  }

  // --- LABEL (3): flat plate on the front face, z ≈ +r, small x/y extent ---
  for (let k = 0; k < labelN; k++) {
    const x = (rng() - 0.5) * 0.4;
    const y = -0.35 + 0.55 * rng();
    const z = 0.3 + jitter();
    emit(x, y, z, 0, 0, 1, 3);
  }

  return { points, normals, components, pointCount: cursor, bounds };
}

/** Non-bottle container silhouettes the exploded mesh can take. */
type ShapedKind = 'jar' | 'box' | 'card' | 'tube';

/** Shared bounds + emitter used by the shaped geometry builders. */
interface ShapedBuilder {
  n: number;
  rng: () => number;
  points: Float32Array;
  normals: Float32Array;
  components: Uint8Array;
  bounds: BottleGeometry['bounds'];
  cursor: number;
}

function makeShapedBuilder(pointCount: number, seed: number): ShapedBuilder {
  const n = Math.max(100, Math.floor(pointCount) || 5000);
  const rng = mulberry32(seed);
  const points = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const components = new Uint8Array(n);
  const bounds = {
    min: [1e9, 1e9, 1e9] as [number, number, number],
    max: [-1e9, -1e9, -1e9] as [number, number, number],
  };
  return { n, rng, points, normals, components, bounds, cursor: 0 };
}

function emitShaped(
  b: ShapedBuilder,
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  component: number,
): void {
  const i = b.cursor * 3;
  b.points[i] = x;
  b.points[i + 1] = y;
  b.points[i + 2] = z;
  b.normals[i] = nx;
  b.normals[i + 1] = ny;
  b.normals[i + 2] = nz;
  b.components[b.cursor] = component;
  b.bounds.min[0] = Math.min(b.bounds.min[0], x);
  b.bounds.min[1] = Math.min(b.bounds.min[1], y);
  b.bounds.min[2] = Math.min(b.bounds.min[2], z);
  b.bounds.max[0] = Math.max(b.bounds.max[0], x);
  b.bounds.max[1] = Math.max(b.bounds.max[1], y);
  b.bounds.max[2] = Math.max(b.bounds.max[2], z);
  b.cursor++;
}

function finalizeShaped(b: ShapedBuilder): BottleGeometry {
  return {
    points: b.points,
    normals: b.normals,
    components: b.components,
    pointCount: b.cursor,
    bounds: b.bounds,
  };
}

/** Build a non-bottle container point cloud (jar / box / card / tube). */
function buildShapedGeometry(kind: ShapedKind, pointCount: number, seed: number): BottleGeometry {
  const b = makeShapedBuilder(pointCount, seed);
  const jitter = () => (b.rng() - 0.5) * 0.02;
  const capN = Math.max(1, Math.floor(b.n * 0.22));
  const nozzleN = Math.max(1, Math.floor(b.n * 0.1));
  const vesselN = Math.max(1, Math.floor(b.n * 0.52));
  const labelN = Math.max(1, Math.floor(b.n * 0.16));

  // Shape dims (local, normalized space).
  const dims = (() => {
    switch (kind) {
      case 'jar':
        return { capBottom: 0.5, capTop: 0.72, capRadius: 0.34, vesselBottom: -0.55, vesselTop: 0.5, vesselR: 0.5, labelZ: 0.5 };
      case 'box':
        return { capBottom: 0.55, capTop: 0.75, capRadius: 0.3, vesselBottom: -0.6, vesselTop: 0.55, vesselR: 0.42, labelZ: 0.43 };
      case 'card':
        return { capBottom: 0.28, capTop: 0.36, capRadius: 0.1, vesselBottom: -0.34, vesselTop: 0.28, vesselR: 0.5, labelZ: 0.08 };
      case 'tube':
        return { capBottom: 0.85, capTop: 1.0, capRadius: 0.17, vesselBottom: -0.9, vesselTop: 0.85, vesselR: 0.16, labelZ: 0.16 };
    }
  })();

  // --- CAP (0): a squat cylinder/box on top ---
  for (let k = 0; k < capN; k++) {
    const theta = b.rng() * Math.PI * 2;
    if (kind === 'box' && b.rng() < 0.6) {
      const x = (b.rng() - 0.5) * dims.capRadius * 1.5;
      const y = dims.capBottom + (dims.capTop - dims.capBottom) * b.rng();
      const z = (b.rng() - 0.5) * dims.capRadius * 1.5;
      const onTop = y > dims.capTop - 0.03;
      emitShaped(b, x, y + jitter(), z + jitter(), 0, onTop ? 1 : -1, 0, 0);
    } else {
      const y = dims.capBottom + (dims.capTop - dims.capBottom) * b.rng();
      const r = dims.capRadius + jitter();
      emitShaped(b, Math.cos(theta) * r, y, Math.sin(theta) * r, Math.cos(theta), 0, Math.sin(theta), 0);
    }
  }

  // --- NOZZLE (1): a small top nub / stem above the cap ---
  for (let k = 0; k < nozzleN; k++) {
    const theta = b.rng() * Math.PI * 2;
    const y = dims.capTop + 0.06 + 0.14 * b.rng();
    const r = (kind === 'tube' ? 0.04 : 0.05) + jitter();
    emitShaped(b, Math.cos(theta) * r, y, Math.sin(theta) * r, Math.cos(theta), 0.5, Math.sin(theta), 1);
  }

  // --- VESSEL (2): body per silhouette ---
  for (let k = 0; k < vesselN; k++) {
    const theta = b.rng() * Math.PI * 2;
    if (kind === 'box') {
      const x = (b.rng() - 0.5) * dims.vesselR * 2;
      const y = dims.vesselBottom + (dims.vesselTop - dims.vesselBottom) * b.rng();
      const z = (b.rng() - 0.5) * dims.vesselR * 2;
      const ax = Math.abs(x) / dims.vesselR;
      const ay = Math.abs(y) / Math.max(0.6, (dims.vesselTop - dims.vesselBottom) / 2);
      const az = Math.abs(z) / dims.vesselR;
      if (ax >= ay && ax >= az) emitShaped(b, x, y + jitter(), z + jitter(), Math.sign(x), 0, 0, 2);
      else if (az >= ay) emitShaped(b, x + jitter(), y + jitter(), z, 0, 0, Math.sign(z), 2);
      else emitShaped(b, x + jitter(), y, z + jitter(), 0, Math.sign(y), 0, 2);
    } else if (kind === 'card') {
      const x = (b.rng() - 0.5) * dims.vesselR * 2;
      const y = dims.vesselBottom + (dims.vesselTop - dims.vesselBottom) * b.rng();
      const z = (b.rng() - 0.5) * 0.12;
      emitShaped(b, x, y, z, 0, 0, Math.sign(z) || 1, 2);
    } else {
      // jar / tube: cylinder with a subtle taper.
      const t = b.rng();
      const y = dims.vesselBottom + (dims.vesselTop - dims.vesselBottom) * t;
      const shoulder = kind === 'jar' && y > 0.4 ? 1 - (y - 0.4) / 0.1 : 1;
      const r = dims.vesselR * Math.max(0.6, shoulder) * (0.94 + 0.06 * Math.sin(theta * 4));
      const nx = Math.cos(theta) / 1.15;
      const ny = (kind === 'jar' && y > 0.4 ? 1 : 0) * 0.4;
      const nz = Math.sin(theta) / 1.15;
      const len = Math.hypot(nx, ny, nz) || 1;
      emitShaped(b, Math.cos(theta) * r + jitter(), y, Math.sin(theta) * r + jitter(), nx / len, ny / len, nz / len, 2);
    }
  }

  // --- LABEL (3): flat front plate ---
  for (let k = 0; k < labelN; k++) {
    const x = (b.rng() - 0.5) * (kind === 'card' ? 0.9 : 0.5);
    const y = (dims.vesselBottom + dims.vesselTop) / 2 + (b.rng() - 0.5) * 0.5;
    const z = dims.labelZ + jitter();
    emitShaped(b, x, y, z, 0, 0, 1, 3);
  }

  return finalizeShaped(b);
}

/**
 * Build the exploded-mesh point cloud for a target product silhouette. The
 * shape is DERIVED from the silhouette key — bottle/jar/box/card/tube — with a
 * neutral container fallback, so the 3D hero never hardcodes a specific
 * product.
 */
export function buildProductGeometry(
  silhouette: string | undefined | null,
  pointCount: number,
  seed = 1337,
): BottleGeometry {
  const key = normalizeSilhouette(silhouette);
  switch (key) {
    case 'jar':
      return buildShapedGeometry('jar', pointCount, seed);
    case 'box':
      return buildShapedGeometry('box', pointCount, seed);
    case 'card':
      return buildShapedGeometry('card', pointCount, seed);
    case 'tube':
      return buildShapedGeometry('tube', pointCount, seed);
    case 'bottle':
    default:
      return buildBottleGeometry(pointCount, seed);
  }
}

export function bottleBoundsCenter(bounds: BottleGeometry['bounds']): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}
