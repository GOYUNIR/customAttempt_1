/**
 * SERVICES / MAPS â€” Mapbox driver.
 *
 * Returns the public `pk.` token + the search-js SDK bootstrap. This is the
 * SAME SDK/config the storefront's address autofill already speaks.
 */

import type { MapDriver, MapInitConfig } from './types.ts';
import { MAPBOX_SEARCH_JS_URL } from './types.ts';
import type { MapProvider } from '../config/types.ts';

export class MapboxDriver implements MapDriver {
  readonly provider: MapProvider = 'mapbox';
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
      sdkUrl: MAPBOX_SEARCH_JS_URL,
      scriptId: 'search-js',
      attributeName: 'data-mapbox-token',
    };
  }
}
