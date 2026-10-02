/**
 * STOREFRONT FIRST SCREEN ON THE SERVER (flag, off by default).
 *
 * On: the store home renders its first screen (hero, products, prices as the
 * catalog shows them) in the server HTML, from the same 10s display cache
 * /api/store serves, instead of a "Loading" screen that waits for the JS and
 * a second request. The page still refreshes from /api/store once it is
 * running, and checkout reads prices and stock live as always
 * (scripts/verify-no-stale-money.ts).
 *
 *   STOREFRONT_SSR=on        (wrangler var) turns it on for every store
 *   ?ssr=1 / ?ssr=0          per-request override, for A/B measurement
 *                            (scripts/measure-speed.ts); display only
 */
export function storefrontSsrEnabled(override?: string | string[] | null): boolean {
  const o = Array.isArray(override) ? override[0] : override;
  if (o === '1') return true;
  if (o === '0') return false;
  return String(process.env.STOREFRONT_SSR || '').trim().toLowerCase() === 'on';
}
