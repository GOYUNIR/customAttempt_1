// Procedural perfume-bottle geometry for the 3D exploded-rebuild engine.
//
// PURE module (no React / no `@/` imports / no DOM) so `node --test` can load
// it and the renderer can build the point cloud once on mount. There are NO
// external model files in the template — this generator IS the "procedural
// asset fallback" and the primary source: a normalized bottle decomposed into
// four components (cap, nozzle, vessel, label) as interleaved points + normals
// so the exploded view can push each point outward along its own normal.

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

export function bottleBoundsCenter(bounds: BottleGeometry['bounds']): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}
