/**
 * SERVICES / MAPS â€” driver registry (pure factory helper).
 *
 * `createMapDriver()` maps a provider string to its concrete driver with zero
 * `@/` imports / DB / network access so the node --test runner can load it
 * directly. The runtime `MapFactory` (factory.ts) resolves the provider + key
 * from the platform settings and delegates here.
 */

import type { MapProvider } from '../config/types.ts';
import type { MapDriver } from './types.ts';
import { MapboxDriver } from './mapbox.driver.ts';
import { GoogleMapsDriver } from './google-maps.driver.ts';
import { OpenStreetMapDriver } from './open-street-map.driver.ts';

/** Resolve the provider string â†’ driver instance. Returns null for unknown. */
export function createMapDriver(provider: MapProvider, apiKey?: string): MapDriver | null {
  switch (provider) {
    case 'mapbox':
      return new MapboxDriver(apiKey || '');
    case 'google_maps':
      return new GoogleMapsDriver(apiKey || '');
    case 'open_street_map':
      return new OpenStreetMapDriver(apiKey || '');
    default:
      return null;
  }
}

/** Every supported provider (used by the Setup Wizard dropdowns + tests). */
export const MAP_DRIVER_CATALOG: ReadonlyArray<{ provider: MapProvider; label: string; hint: string }> = [
  { provider: 'mapbox', label: 'Mapbox', hint: 'search-js address autofill (existing storefront integration)' },
  { provider: 'google_maps', label: 'Google Maps', hint: 'Places API address autofill' },
  { provider: 'open_street_map', label: 'OpenStreetMap', hint: 'free + keyless (Nominatim), rate limited' },
];
