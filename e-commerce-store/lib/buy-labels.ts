/**
 * The product page's primary button labels, shared by the storefront and the
 * admin's live preview. Plain, consequence-stating defaults for every store;
 * a store's own voice ("Secure piece", "Enter allocation") is an override in
 * its settings.copy (buyCta, entryCta), never the platform default.
 */

type Copy = { buyCta?: unknown; entryCta?: unknown } | null | undefined;

const own = (v: unknown) => String(v ?? '').trim();

/** An instant-buy size that sells now: "Buy now · $19.00". */
export function buyLabel(copy: Copy, price: number): string {
  return (own(copy?.buyCta) || 'Buy now') + ' · $' + price.toFixed(2);
}

/** A raffle size: enter the draw (the store's entry wording when it has one). */
export function entryLabel(copy: Copy, archived: boolean): string {
  if (archived) return 'Enter the next raffle';
  return own(copy?.entryCta) || 'Enter the raffle';
}
