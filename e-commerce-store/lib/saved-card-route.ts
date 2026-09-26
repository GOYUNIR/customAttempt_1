/**
 * SAVED-CARD ROUTE — where an off-session charge of a SAVED card (a raffle
 * winner, a waitlist conversion) may be made. Pure, so the cutover rule is
 * unit-tested rather than re-derived in each draw engine. Design: CONNECT.md
 * §4 "The saved-card cutover rule".
 *
 * A saved card (PaymentMethod + Customer) exists on exactly one Stripe account
 * and can only be charged there. So the charge follows THE CARD, as recorded
 * on the entry when the card was saved (raffle_entries.stripe_account, 00035;
 * `stripeAccount` on a KV pool entry) — never the store's current charge
 * route, which may have changed since the card was saved.
 *
 *   R1  No recorded account means the platform account: every entry saved
 *       before 00035, i.e. all of the original store's entries today.
 *   R2  The original (default) store charges platform-saved cards on the
 *       platform, as it always has. An entry of the default store recorded on
 *       a CONNECTED account can only exist after its switch to Connect, which
 *       has not been built: refuse, loudly, rather than half-run it.
 *   R3  Any other store's saved card must be on that store's OWN connected
 *       account. A platform card, or another account's, is refused: charging
 *       it would put one merchant's customer's money somewhere else.
 */

export type SavedCardRoute =
  | { ok: true; stripeAccount: string | null }
  | { ok: false; reason: 'malformed_account' | 'default_store_cutover_not_built' | 'platform_card_for_merchant' | 'foreign_account' | 'merchant_not_connected' };

const ACCOUNT_RE = /^acct_[A-Za-z0-9]+$/;

export function savedCardChargeRoute(input: {
  /** As recorded on the entry: null/undefined/'' means the platform (R1). */
  entryAccount: string | null | undefined;
  isDefaultStore: boolean;
  /** The store's own connected account id, if it has one. */
  storeAccount: string | null | undefined;
}): SavedCardRoute {
  const raw = String(input.entryAccount ?? '').trim();
  if (raw && !ACCOUNT_RE.test(raw)) return { ok: false, reason: 'malformed_account' };
  const entryAccount = raw || null;

  if (input.isDefaultStore) {
    if (!entryAccount) return { ok: true, stripeAccount: null }; // R1 + R2
    return { ok: false, reason: 'default_store_cutover_not_built' };
  }

  const store = String(input.storeAccount ?? '').trim();
  if (!store || !ACCOUNT_RE.test(store)) return { ok: false, reason: 'merchant_not_connected' };
  if (!entryAccount) return { ok: false, reason: 'platform_card_for_merchant' };
  if (entryAccount !== store) return { ok: false, reason: 'foreign_account' };
  return { ok: true, stripeAccount: entryAccount }; // R3
}
