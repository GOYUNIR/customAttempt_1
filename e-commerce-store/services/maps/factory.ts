/**
 * SERVICES / MAPS — runtime factory.
 *
 * `MapFactory.getDriver()` resolves the active map provider. Resolution order:
 *
 *   1. `global_platform_settings.map_provider` + `.map_api_key`
 *      (Setup Wizard) — read through the TTL-cached settings store.
 *   2. Legacy env fallback so an un-wizarded store keeps working:
 *        NEXT_PUBLIC_MAPBOX_TOKEN / NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN → Mapbox
 *        GOOGLE_MAPS_API_KEY / NEXT_PUBLIC_GOOGLE_MAPS_API_KEY      → Google
 *        (no key → OpenStreetMap, which needs none)
 *   3. A Mapbox driver with an empty token when truly nothing is configured —
 *      the client treats a missing token as "no autofill" exactly like today.
 */

import { getPlatformSettings } from '@/services/config/platform-settings';
import { createMapDriver } from './registry';
import type { MapDriver } from './types';

export class MapFactory {
  /** Resolve the active map driver (cached settings; never returns null). */
  static async getDriver(opts?: { force?: boolean }): Promise<MapDriver> {
    // 1. Wizard-configured provider.
    const settings = await getPlatformSettings(opts);
    if (settings?.map_provider) {
      const driver = createMapDriver(settings.map_provider, settings.map_api_key || undefined);
      if (driver) return driver;
    }

    // 2. Legacy env fallbacks.
    const mapboxToken =
      process.env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || '';
    if (mapboxToken) return createMapDriver('mapbox', mapboxToken) as MapDriver;

    const googleKey =
      process.env.GOOGLE_MAPS_API_KEY ||
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
      '';
    if (googleKey) return createMapDriver('google_maps', googleKey) as MapDriver;

    // 3. Keyless default — OpenStreetMap (or an empty Mapbox driver if the
    //    operator explicitly configured mapbox without a key).
    return (settings?.map_provider === 'mapbox'
      ? createMapDriver('mapbox', '')
      : createMapDriver('open_street_map', '')) as MapDriver;
  }
}
