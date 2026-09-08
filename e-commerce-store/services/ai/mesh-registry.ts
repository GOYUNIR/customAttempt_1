/**
 * SERVICES / AI — 3D mesh driver registry (pure factory helper).
 *
 * `createMeshDriver()` maps an `Ai3dProvider` string to its concrete driver.
 * Free of `@/` imports so `node --test` loads it directly — the runtime
 * `MeshFactory` (mesh-factory.ts) resolves provider + key + endpoint and
 * delegates here.
 */

import type { Ai3dProvider } from '../config/types.ts';
import type { MeshDriver, MeshDriverResolutionOptions } from './mesh-driver.ts';
import { Tripo3dDriver } from './tripo3d.ts';
import { MeshyDriver } from './meshy.ts';
import { Stability3dDriver } from './stability3d.ts';
import { CustomWebhookDriver } from './custom-webhook.ts';

export interface MeshDriverResolution {
  apiKey: string;
  endpoint?: string;
  options?: MeshDriverResolutionOptions;
}

/** Resolve the provider string → mesh driver instance. Returns null for unknown. */
export function createMeshDriver(
  provider: Ai3dProvider,
  apiKey: string,
  options: MeshDriverResolutionOptions = {},
  endpoint = '',
): MeshDriver | null {
  switch (provider) {
    case 'tripo3d':
      return new Tripo3dDriver({ apiKey, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, maxPolls: options.maxPolls, pollDelayMs: options.pollDelayMs });
    case 'meshy':
      return new MeshyDriver({ apiKey, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, maxPolls: options.maxPolls, pollDelayMs: options.pollDelayMs });
    case 'stability_3d':
      return new Stability3dDriver({ apiKey, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, maxPolls: options.maxPolls, pollDelayMs: options.pollDelayMs });
    case 'custom_webhook':
      return new CustomWebhookDriver({ apiKey, endpoint, fetchImpl: options.fetchImpl, maxPolls: options.maxPolls, pollDelayMs: options.pollDelayMs });
    default:
      return null;
  }
}

/** Every supported 3D mesh provider (used by the Setup panel dropdown + tests). */
export const MESH_DRIVER_CATALOG: ReadonlyArray<{ provider: Ai3dProvider; label: string; hint: string }> = [
  { provider: 'tripo3d', label: 'Tripo3D', hint: 'api.tripo3d.ai — image-to-3D GLB/GLTF task generation (the recommended default).' },
  { provider: 'meshy', label: 'Meshy', hint: 'api.meshy.ai — image-to-3D via the openapi endpoint.' },
  { provider: 'stability_3d', label: 'Stability 3D', hint: 'api.stability.ai — image-to-3D via the 3D endpoints.' },
  { provider: 'custom_webhook', label: 'Custom Webhook', hint: 'Your own image-to-3D endpoint — POST { imageUrl, prompt }, returns a model URL.' },
];
