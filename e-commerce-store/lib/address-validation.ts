/**
 * Shared shipping-address validation used by both the React storefront
 * (client components) and the address/checkout APIs (server routes).
 *
 * Mapbox Address Autofill is the primary quality gate: when it is live on a
 * page, customers must pick a real address from the dropdown suggestions
 * (tracked via the SDK's `retrieve` event — see lib/mapbox-autofill.ts). These
 * structural checks are the fallback gate when autofill is unavailable (no
 * token configured), so garbage like "asdf" or "1234567890" can never be saved
 * as a shipping address.
 */
export function validateShippingAddress(address: string): string | null {
  const v = String(address || '').trim();
  if (!v) return 'Enter a shipping address.';
  if (v.length < 10) return 'Enter a complete shipping address (street, city, state and ZIP).';
  if (!/\d/.test(v)) return 'Shipping address needs a street number (e.g. "123 Main Street").';
  if (!/[a-zA-Z]/.test(v)) return 'Shipping address needs street or city names.';
  return null;
}
