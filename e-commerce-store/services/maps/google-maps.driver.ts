/**
 * SERVICES / MAPS â€” Google Maps driver.
 *
 * Returns the Places API key + the classic loader bootstrap. The client can
 * boot the Places library with this config and implement the same
 * full-address autofill UX the Mapbox driver powers.
 */

import type { MapDriver, MapInitConfig } from './types.ts';
import type { MapProvider } from '../config/types.ts';

const GOOGLE_MAPS_LOADER_URL = 'https://maps.googleapis.com/maps/api/js';

export class GoogleMapsDriver implements MapDriver {
  readonly provider: MapProvider = 'google_maps';
  readonly configured: boolean;

  private readonly token: string;

  constructor(token: string) {
    this.token = String(token || '').trim();
    this.configured = Boolean(this.token);
  }

  getToken(): string {
    return this.token;
  }

  getInitConfig(): MapInitConfig {
    return {
      provider: this.provider,
      token: this.token,
      sdkUrl: `${GOOGLE_MAPS_LOADER_URL}?key=${encodeURIComponent(this.token)}&libraries=places&callback=__goyunirGoogleMapsReady`,
      scriptId: 'google-maps',
      attributeName: 'data-google-maps-key',
      options: { libraries: 'places', region: 'US' },
    };
  }
}
