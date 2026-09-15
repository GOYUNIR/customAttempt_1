/**
 * ADAPTERS / MAPS — facade over `services/maps/*`.
 *
 * Same rationale as `lib/adapters/payment.ts`: `services/maps/` already
 * implements the driver+registry+factory pattern (`types.ts`'s `MapDriver` →
 * `mapbox.driver.ts` / `google-maps.driver.ts` / `open-street-map.driver.ts`
 * → `registry.ts` → `factory.ts`'s `MapFactory.getDriver()`). This
 * re-exports it under `lib/adapters/` rather than reimplementing it.
 * Swapping to Radar means adding a driver under `services/maps/` and
 * registering it — nothing here changes.
 */

export type { MapDriver, MapInitConfig } from '@/services/maps/types';
export { MapFactory } from '@/services/maps/factory';

import { MapFactory } from '@/services/maps/factory';
import type { MapDriver } from '@/services/maps/types';

/** Resolve the active map adapter (wizard-configured → env fallback → OSM). */
export function getMapAdapter(opts?: { force?: boolean }): Promise<MapDriver> {
  return MapFactory.getDriver(opts);
}
