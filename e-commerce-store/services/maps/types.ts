/**
 * SERVICES / MAPS â€” the MapDriver contract.
 *
 * Returns the provider token and the initialization configuration the client
 * needs to boot the right address-autofill / map SDK dynamically based on the
 * active provider. The storefront's address forms already resolve the token
 * from `window.ENV_MAPBOX_TOKEN` first â€” the layout bakes the factory's token
 * into that global at runtime, so a wizard-configured key takes effect without
 * a rebuild.
 *
 * This file has zero `@/` imports on purpose so the node --test runner can load
 * it directly.
 */

import type { MapProvider } from '../config/types.ts';

/** The client-side initialization payload for the active provider. */
export interface MapInitConfig {
  provider: MapProvider;
  /** The public token to load the SDK / queries with. */
  token: string;
  /** Script URL the client should inject (empty for OSM, which needs none). */
  sdkUrl?: string;
  /** `<script id>` used to avoid double-loading the SDK. */
  scriptId?: string;
  /** Attribute name used to carry the token into the SDK script tag. */
  attributeName?: string;
  /** Additional provider-specific options (region, libraries, â€¦). */
  options?: Record<string, string | boolean | number>;
}

export interface MapDriver {
  readonly provider: MapProvider;
  /** Whether this provider needs (and has) a token. OSM is always "configured". */
  readonly configured: boolean;
  getToken(): string;
  getInitConfig(): MapInitConfig;
}

/** Mapbox search-js bootstrap (the exact SDK the storefront already uses). */
export const MAPBOX_SEARCH_JS_URL = 'https://api.mapbox.com/search-js/v1.6.0/web.js';
