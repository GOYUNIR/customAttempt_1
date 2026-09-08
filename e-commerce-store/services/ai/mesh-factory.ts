/**
 * SERVICES / AI — 3D mesh runtime factory.
 *
 * `MeshFactory.getDriver()` is the ONLY way functional features obtain a mesh
 * driver. Resolution order:
 *
 *   1. `global_platform_settings.ai3d_provider` + `.ai3d_key` + `.ai3d_endpoint`
 *      (Setup Wizard / admin "API Keys & Integrations").
 *   2. Legacy env fallback (TRIPO3D_API_KEY / MESHY_API_KEY / …) so an
 *      un-wizarded store still works.
 *   3. null when nothing is configured → callers degrade to the 2D image shader.
 */

import { getPlatformSettings } from '@/services/config/platform-settings';
import type { Ai3dProvider } from '@/services/config/types';
import { createMeshDriver } from './mesh-registry';
import type { MeshDriver, MeshDriverResolutionOptions } from './mesh-driver';

export class MeshFactory {
  /** Resolve the active mesh driver (cached settings; null when none). */
  static async getDriver(opts?: { force?: boolean }): Promise<MeshDriver | null> {
    const options: MeshDriverResolutionOptions = {};
    const settings = await getPlatformSettings(opts);

    if (settings?.ai3d_provider) {
      const key = settings.ai3d_key || '';
      const endpoint = settings.ai3d_endpoint || '';
      const model = settings.ai3d_model || '';
      if (key || endpoint) {
        const driver = createMeshDriver(settings.ai3d_provider, key, { ...options, model }, endpoint);
        if (driver?.configured) return driver;
      }
    }

    return MeshFactory.resolveEnvDriver(options);
  }

  /** Legacy env-var resolution (used when the wizard hasn't persisted a provider). */
  private static resolveEnvDriver(options: MeshDriverResolutionOptions): MeshDriver | null {
    const envDrivers: Array<[Ai3dProvider, string | undefined, string | undefined]> = [
      ['tripo3d', process.env.TRIPO3D_API_KEY, process.env.TRIPO3D_API_URL],
      ['meshy', process.env.MESHY_API_KEY, process.env.MESHY_API_URL],
      ['stability_3d', process.env.STABILITY3D_API_KEY, process.env.STABILITY3D_API_URL],
    ];
    for (const [provider, key, endpoint] of envDrivers) {
      if (key && String(key).trim()) {
        return createMeshDriver(provider, String(key).trim(), options, String(endpoint || '').trim());
      }
    }
    return null;
  }
}
