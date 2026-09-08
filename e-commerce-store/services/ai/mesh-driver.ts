/**
 * SERVICES / AI (3D MESH) — the image-to-3D provider contract.
 *
 * A SEPARATE surface from the LLM prompt compiler: these drivers take a product
 * image + a prompt instruction and return a 3D mesh (GLB/GLTF) URL / buffer —
 * or structured mesh uniforms — for the hero WebGL / model pipeline.
 *
 * Functional features NEVER call Tripo3D / Meshy / Stability 3D SDKs directly.
 * They resolve the active driver through `MeshFactory.getDriver()` and call the
 * single standardized method:
 *
 *   generate(imageUrl, prompt) → MeshGenerateResult
 *
 * Every driver accepts an injectable `fetchImpl` so `node --test` can assert the
 * request shape with zero network I/O. This file has zero `@/` imports on purpose.
 */

import type { Ai3dProvider } from '../config/types.ts';

export type { Ai3dProvider } from '../config/types.ts';

/** A mesh file format the pipeline understands. */
export type MeshFormat = 'glb' | 'gltf' | 'obj' | 'usdz' | 'ply' | 'unknown';

export type MeshGenerateResult =
  | {
      ok: true;
      /** Direct URL to the generated model (GLB/GLTF) — or empty when `modelData` carries the bytes. */
      modelUrl?: string;
      /** Raw model payload (base64 / string) when the provider inlines the asset. */
      modelData?: string;
      /** Optional rendered thumbnail for the hero preview. */
      thumbnailUrl?: string;
      format: MeshFormat;
      provider: Ai3dProvider;
    }
  | { ok: false; error?: unknown; provider: Ai3dProvider; skipped?: boolean };

export interface MeshDriver {
  readonly provider: Ai3dProvider;
  /** Whether the driver has the secret/endpoint it needs. */
  readonly configured: boolean;
  /** Standardized image-to-3D task (start + poll until complete). */
  generate(imageUrl: string, prompt: string): Promise<MeshGenerateResult>;
}

/** Options shared by every mesh driver (injectable fetch + poll tuning). */
export interface MeshDriverResolutionOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxPolls?: number;
  pollDelayMs?: number;
}

/** A tiny bounded sleep used by the polling drivers (no Node builtins). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format string from an arbitrary file name / mime (bounded to known formats). */
export function normalizeMeshFormat(value: unknown): MeshFormat {
  const v = String(value || '').trim().toLowerCase();
  if (v.includes('glb')) return 'glb';
  if (v.includes('gltf')) return 'gltf';
  if (v.includes('obj')) return 'obj';
  if (v.includes('usdz') || v.includes('usd')) return 'usdz';
  if (v.includes('ply')) return 'ply';
  return 'unknown';
}
