import { INTENT_KEY_PREFIX, POOL_KEY_PREFIX } from './redis-keys.ts';

/**
 * Pure helpers for parsing `entries:pool:*` / `entries:intent:*` keys.
 * Deliberately dependency-light (relative import only) so the node --test
 * runner can import this module without resolving the `@/` alias.
 */

/** Parse the product name from an `entries:pool:<name>:<size>` key. The name
 * may itself contain colons, so only the 2-segment namespace prefix is
 * stripped and the FIRST remaining colon separates name from size. */
export function productNameFromPoolKey(poolKey: string): string {
  const withoutPrefix = poolKey.startsWith(POOL_KEY_PREFIX)
    ? poolKey.slice(POOL_KEY_PREFIX.length)
    : poolKey;
  const colon = withoutPrefix.indexOf(':');
  return colon > 0 ? withoutPrefix.slice(0, colon) : withoutPrefix;
}

/** Extract the `size` segment from an `entries:pool:<variant>:<size>` key. */
export function sizeFromPoolKey(poolKey: string): string {
  // `entries:pool:<variant>:<size>` — variant may itself contain colons, so we
  // only strip the fixed 2-segment namespace prefix, not split from the left.
  const withoutPrefix = poolKey.startsWith(POOL_KEY_PREFIX)
    ? poolKey.slice(POOL_KEY_PREFIX.length)
    : poolKey.startsWith(INTENT_KEY_PREFIX)
      ? poolKey.slice(INTENT_KEY_PREFIX.length)
      : poolKey;
  const colon = withoutPrefix.indexOf(':');
  return colon > 0 ? withoutPrefix.slice(colon + 1) : 'Standard';
}

