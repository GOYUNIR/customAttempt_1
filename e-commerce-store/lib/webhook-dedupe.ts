/**
 * WEBHOOK DEDUPE — "has this event already been handled?", decided by the
 * database in one statement.
 *
 * Backed by public.webhook_dedupe (00031). It replaces a KV sorted-set blob
 * whose "atomic" claim was four read-modify-writes with no compare-and-swap —
 * a lost update in that exact path was observed in production (00031 has the
 * detail) — and which cost roughly eight PostgREST round trips per delivery.
 *
 * THE CONTRACT
 *   claim()    → 'claimed'   : you are the first; do the work, then complete()
 *              → 'reclaimed' : an earlier run claimed this and never finished
 *                              (older than STALE_CLAIM_MS); you take it over
 *              → 'duplicate' : someone else has it, or it is done; do nothing
 *              → THROWS      : the database could not answer
 *   complete() → marks it done. Never throws: the work already happened.
 *
 * WHY claim() THROWS instead of returning 'duplicate' on error. The KV version
 * caught every storage error and reported "already processed", so an outage
 * made the webhook answer Stripe 200 and drop the event for good — a paid
 * order silently never fulfilled. Throwing lets the handler return 5xx, and
 * Stripe's own retry becomes the recovery. An unknowable answer must never be
 * treated as "yes, handled".
 *
 * THE RECLAIM TRADE, stated plainly. Taking over an abandoned claim means a
 * handler that crashed after some of its writes will run those writes again.
 * The order write is idempotent on order_ref, so no second order appears. The
 * Postgres stock decrement is NOT keyed by order, so a crash-then-reclaim can
 * decrement twice — understating stock, which is the safe direction (it can
 * show "sold out" early; it cannot sell a unit that does not exist), and the
 * oversold audit flags it. The alternative, never reclaiming, loses the whole
 * sale for a charged customer. Idempotent stock movements belong to the
 * inventory-reservation work (STRATEGY.md §9), which removes this trade.
 */
// Relative with extensions, like the rest of this import chain: lib/redis-maintenance.ts
// imports this, tests/redis-maintenance.test.ts imports that, and plain
// `node --test` does not resolve the '@/' alias.
import { getDb } from './db/client.ts';
import { eq, lt } from './db/query.ts';

/**
 * How long a claim may sit unfinished before a retry can take it over. The
 * checkout webhook runs for seconds; nothing legitimate is still going after
 * five minutes, and Stripe's first retry of a failed delivery comes later than
 * that, so a crashed run is picked up by the retry that follows it.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

export type ClaimOutcome = 'claimed' | 'reclaimed' | 'duplicate';

const TABLE = 'webhook_dedupe';

export async function claimWebhookKey(scope: string, key: string, now: number = Date.now()): Promise<ClaimOutcome> {
  const db = getDb();
  if (!db.configured) {
    throw new Error('[webhook-dedupe] database not configured — cannot decide whether ' + key + ' was handled');
  }
  const dedupeKey = String(key || '').trim();
  if (!dedupeKey) throw new Error('[webhook-dedupe] empty dedupe key');

  // ONE statement decides the winner. ignore-duplicates + representation
  // returns the row only when THIS insert created it.
  const inserted = await db.insert(
    TABLE,
    { scope, dedupe_key: dedupeKey, status: 'claimed', claimed_at: new Date(now).toISOString() },
    { onConflict: 'scope,dedupe_key', ignoreDuplicates: true },
  );
  if (inserted.length > 0) return 'claimed';

  // It exists. Take it over only if it is an abandoned claim. Postgres
  // row-locks the UPDATE and re-checks the WHERE after any concurrent winner
  // commits, so of two retries racing for the same stale claim exactly one
  // matches — the other sees a fresh claimed_at and gets nothing back.
  const cutoff = new Date(now - STALE_CLAIM_MS).toISOString();
  const taken = await db.update(
    TABLE,
    { where: { scope: eq(scope), dedupe_key: eq(dedupeKey), status: eq('claimed'), claimed_at: lt(cutoff) } },
    { claimed_at: new Date(now).toISOString() },
  );
  return taken.length > 0 ? 'reclaimed' : 'duplicate';
}

export async function completeWebhookKey(scope: string, key: string, now: number = Date.now()): Promise<void> {
  try {
    const db = getDb();
    if (!db.configured) return;
    await db.update(
      TABLE,
      { where: { scope: eq(scope), dedupe_key: eq(String(key || '').trim()) } },
      { status: 'done', completed_at: new Date(now).toISOString() },
      { returning: 'minimal' },
    );
  } catch (err) {
    // The work is done; failing here leaves a 'claimed' row that a retry
    // could take over after STALE_CLAIM_MS. Stripe got 200 and will not
    // retry, so in practice it just sits there — but it must be visible.
    console.error('[webhook-dedupe] could not mark ' + scope + '/' + key + ' done — it stays claimed',
      (err as Error)?.message || err);
  }
}

/** The one scope in use today: a Stripe Checkout Session id. */
export const STRIPE_SESSION_SCOPE = 'stripe_checkout_session';

export function claimStripeSession(sessionId: string): Promise<ClaimOutcome> {
  return claimWebhookKey(STRIPE_SESSION_SCOPE, sessionId);
}

export function completeStripeSession(sessionId: string): Promise<void> {
  return completeWebhookKey(STRIPE_SESSION_SCOPE, sessionId);
}

/**
 * Give back a claim this run took but did not finish, so another path (the
 * Stripe webhook, or a retry) can do the work. Only a row still 'claimed' is
 * removed — never a 'done' one, so a release racing a completion cannot undo
 * finished work. Never throws: a failed release leaves a claim that becomes
 * reclaimable after STALE_CLAIM_MS, which is the fallback, not a loss.
 *
 * Exists because confirm-setup claimed a session and then returned early on
 * validation errors without releasing it; the webhook arriving seconds later
 * saw the claim, answered "already processed", and the raffle entry was never
 * created. The KV claim had the same flaw and never expired at all.
 */
export async function releaseWebhookKey(scope: string, key: string): Promise<void> {
  try {
    const db = getDb();
    if (!db.configured) return;
    await db.remove(TABLE, {
      where: { scope: eq(scope), dedupe_key: eq(String(key || '').trim()), status: eq('claimed') },
    });
  } catch (err) {
    console.error('[webhook-dedupe] could not release ' + scope + '/' + key +
      ' — it becomes reclaimable after ' + STALE_CLAIM_MS / 60000 + ' minutes',
      (err as Error)?.message || err);
  }
}

export function releaseStripeSession(sessionId: string): Promise<void> {
  return releaseWebhookKey(STRIPE_SESSION_SCOPE, sessionId);
}
