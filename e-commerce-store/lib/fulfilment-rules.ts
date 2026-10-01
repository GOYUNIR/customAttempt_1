/**
 * FULFILMENT RULES (v1: the whole order ships at once) — pure, no imports,
 * unit-tested in tests/fulfilment-rules.test.ts.
 *
 * Carriers: a short list with public tracking pages (fewer choices, Hick's
 * Law), plus "Other" by name with no link. The list is reference data about
 * carriers, not about us.
 */
export type Carrier = { id: string; name: string; trackingUrl: ((n: string) => string) | null };

export const CARRIERS: Carrier[] = [
  { id: 'usps', name: 'USPS', trackingUrl: (n) => 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n) },
  { id: 'ups', name: 'UPS', trackingUrl: (n) => 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n) },
  { id: 'fedex', name: 'FedEx', trackingUrl: (n) => 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n) },
  { id: 'dhl', name: 'DHL', trackingUrl: (n) => 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=' + encodeURIComponent(n) },
  { id: 'other', name: 'Other', trackingUrl: null },
];

export type ShipInput = { carrier: string; carrierName: string; trackingNumber: string; trackingUrl: string | null };

/** What a merchant may send to mark an order shipped. */
export function validateShipInput(raw: any): { ok: true; value: ShipInput } | { ok: false; error: string } {
  const carrier = CARRIERS.find((c) => c.id === String(raw?.carrier || '').trim().toLowerCase());
  if (!carrier) return { ok: false, error: 'Choose a carrier.' };
  // Spaces are common when people copy a number from a label; they are not part of it.
  const trackingNumber = String(raw?.trackingNumber ?? '').replace(/\s+/g, '').trim();
  if (!/^[A-Za-z0-9-]{4,64}$/.test(trackingNumber)) return { ok: false, error: 'Enter the tracking number (letters, numbers and dashes).' };
  let carrierName = carrier.name;
  if (carrier.id === 'other') {
    carrierName = String(raw?.carrierName ?? '').replace(/[\r\n<>"]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (carrierName.length < 2 || carrierName.length > 40) return { ok: false, error: 'Enter the carrier\'s name.' };
  }
  return { ok: true, value: { carrier: carrier.id, carrierName, trackingNumber, trackingUrl: carrier.trackingUrl ? carrier.trackingUrl(trackingNumber) : null } };
}

/** The payment in the merchant's OWN Stripe Dashboard (refunds happen there). */
export function stripePaymentLink(paymentIntentId: string | null | undefined, testMode: boolean): string | null {
  const id = String(paymentIntentId || '');
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) return null;
  return 'https://dashboard.stripe.com/' + (testMode ? 'test/' : '') + 'payments/' + id;
}

/** Where an order stands, in one word a merchant reads at a glance. */
export function orderStage(o: { paymentStatus: string; shippedAt: string | null }): 'to_ship' | 'shipped' | 'refunded' | 'unpaid' {
  if (o.paymentStatus === 'refunded') return 'refunded';
  if (o.shippedAt) return 'shipped';
  if (o.paymentStatus === 'paid' || o.paymentStatus === 'partially_refunded') return 'to_ship';
  return 'unpaid';
}
