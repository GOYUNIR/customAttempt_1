// Subdivided 3D plane grid for the hero deconstruction shader.
//
// PURE module (no React / no `@/` imports / no DOM) so `node --test` can load
// it and the renderer can build the mesh once on mount. A single flat quad was
// the limitation that kept the "exploded rebuild" preset at flat-2D-rotation;
// this generator subdivides the plane into `segments × segments` cells (default
// 32 → a 33×33 vertex grid), each of which the GLSL vertex shader then
// disassembles into a floating 3D shard.

export interface GridGeometry {
  /** Interleaved [x, y, u, v] per vertex (stride = 4 floats). */
  vertices: Float32Array;
  /** Triangle indices (2 per cell). */
  indices: Uint16Array;
  /** Number of grid vertices ((segments + 1)²). */
  vertexCount: number;
  /** Number of indices (segments² * 6). */
  indexCount: number;
  /** Grid resolution (cells per side). */
  segments: number;
}

export const DEFAULT_GRID_SEGMENTS = 32;

/**
 * Build a unit plane grid spanning [-1, 1]² in position space and [0, 1]² in
 * UV space. Vertices are interleaved [x, y, u, v] so the renderer can bind two
 * `vertexAttribPointer`s (a_position offset 0, a_uv offset 8 bytes) over one
 * buffer. Indices use a Uint16Array (a 32-segment grid is only 1089 vertices,
 * well under the 65 536 Uint16 ceiling).
 */
export function buildGridGeometry(segments: number = DEFAULT_GRID_SEGMENTS): GridGeometry {
  const s = Math.max(2, Math.floor(segments) || DEFAULT_GRID_SEGMENTS);
  const w = s + 1; // vertices per side
  const vertices = new Float32Array(w * w * 4);
  let vi = 0;
  for (let gy = 0; gy < w; gy++) {
    const v = s === 0 ? 0 : gy / s; // 0..1
    const y = v * 2 - 1; // -1..1
    for (let gx = 0; gx < w; gx++) {
      const u = s === 0 ? 0 : gx / s; // 0..1
      const x = u * 2 - 1; // -1..1
      vertices[vi++] = x;
      vertices[vi++] = y;
      vertices[vi++] = u;
      vertices[vi++] = v;
    }
  }

  const indices = new Uint16Array(s * s * 6);
  let ii = 0;
  for (let gy = 0; gy < s; gy++) {
    for (let gx = 0; gx < s; gx++) {
      const a = gy * w + gx;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      // Two triangles per cell, wound counter-clockwise.
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  return { vertices, indices, vertexCount: w * w, indexCount: indices.length, segments: s };
}
