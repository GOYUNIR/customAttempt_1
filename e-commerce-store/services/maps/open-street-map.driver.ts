/**
 * SERVICES / MAPS â€” OpenStreetMap driver.
 *
 * OSM + Nominatim need NO API key (rate-limited, free). `configured` is always
 * true; a stored key is optional and forwarded as a courtesy if provided.
 */

import type { MapDriver, MapInitConfig } from './types.ts';
import type { MapProvider } from '../config/types.ts';

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

export class OpenStreetMapDriver implements MapDriver {
  readonly provider: MapProvider = 'open_street_map';
  readonly configured = true;

  private readonly token: string;

  constructor(token = '') {
    this.token = String(token || '').trim();
  }

  getToken(): string {
    return this.token;
  }

  getInitConfig(): MapInitConfig {
    return {
      provider: this.provider,
      token: this.token,
      scriptId: 'open-street-map',
      attributeName: 'data-osm-endpoint',
      options: { endpoint: NOMINATIM_ENDPOINT },
    };
  }
}
