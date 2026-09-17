/**
 * RAFFLE / WAITLIST / SHARED-POOL (Postgres-backed) —
 * `public.raffle_entries` / `public.drop_draws` / `public.waitlist_entries` /
 * `public.shared_inventory_pools` (supabase/migrations/00012_drop_mode_schema.sql).
 *
 * See lib/inventory.ts's header for the storage-split rationale (Postgres =
 * source of truth, Redis = the atomic lock for the critical section only).
 * Winner selection is lib/raffle-draw.ts's pure, independently-tested
 * shuffle — this module is only the I/O shell around it.
 *
 * NOT wired into any live route yet — see the session's summary.
 */

import { createKvClient } from '@/lib/server-config';
import { withRedisLock } from '@/lib/redis-lock';
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { selectWinners } from '@/lib/raffle-draw';
import { resolveStripeClient } from '@/services/payment/factory';
import { deliverWinnerEmail } from '@/lib/notifications';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';
import { boundIdempotencyKey } from '@/lib/idempotency-key';

function assertSupabase(): void {
  if (!getDb().configured) {
    throw new Error('Postgres raffle engine requires Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

// ── Raffle entries ────────────────────────────────────────────────────────────

export type RaffleEntryInput = {
  tenantId: string;
  variantId: string;
  customerId?: string | null;
  email: string;
  paymentMethodRef?: string | null;
  promoCode?: string | null;
  discountPercent?: number | null;
  shippingAddress?: string | null;
};

export type CreateRaffleEntryResult =
  | { ok: true; entryId: string }
  | { ok: false; reason: 'already_entered' | 'error'; error?: string };

/** Submit a pending raffle entry. The table's partial unique index
 *  (tenant_id, variant_id, email) WHERE status='pending' is the actual
 *  duplicate-entry guard — this just turns that constraint violation into a
 *  clean result instead of a raw PostgREST 409. */
export async function createRaffleEntry(input: RaffleEntryInput): Promise<CreateRaffleEntryResult> {
  assertSupabase();
  try {
    const rows = await getDb().insert<{ id: string }>('raffle_entries', {
        tenant_id: input.tenantId,
        variant_id: input.variantId,
        customer_id: input.customerId ?? null,
        email: String(input.email || '').trim().toLowerCase(),
        payment_method_ref: input.paymentMethodRef ?? null,
        promo_code: input.promoCode ?? null,
        discount_percent: input.discountPercent ?? null,
        shipping_address: input.shippingAddress ?? null,
      status: 'pending',
    });
    const entryId = rows?.[0]?.id;
    if (!entryId) return { ok: false, reason: 'error', error: 'No row returned.' };
    return { ok: true, entryId };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      return { ok: false, reason: 'already_entered' };
    }
    return { ok: false, reason: 'error', error: message };
  }
}

async function listPendingEntries(tenantId: string, variantId: string) {
  return getDb().select<Record<string, unknown>>('raffle_entries', {
    where: { tenant_id: eq(tenantId), variant_id: eq(variantId), status: eq('pending') },
    select: ['*'],
  });
}

// ── Draws ─────────────────────────────────────────────────────────────────────

export type DrawExecutionResult = {
  drawId: string;
  winnerCount: number;
  entriesCount: number;
  winnerEntryIds: string[];
  notSelectedEntryIds: string[];
  /** The full winner entry rows (email, payment_method_ref, promo_code,
   *  discount_percent, shipping_address, …) — added so a caller charging
   *  winners (executeDrawWithCharging, below) doesn't need a second fetch
   *  to re-look-up what selectWinners already had in hand. */
  winners: Array<Record<string, unknown>>;
};

/**
 * Execute a draw for `variantId`: pull every pending entry, select winners
 * (lib/raffle-draw.ts), mark each entry's outcome, and record a
 * `drop_draws` row. This does NOT charge anyone — same separation the
 * existing Redis draw engine (lib/draw.ts) keeps: selecting a winner and
 * charging their card are two distinct steps.
 */
export async function executeDraw(tenantId: string, variantId: string, winnerCount: number): Promise<DrawExecutionResult> {
  assertSupabase();
  const entries = await listPendingEntries(tenantId, variantId);
  const { winners, notSelected } = selectWinners(entries, winnerCount);

  const nowIso = new Date().toISOString();
  const winnerIds = winners.map((e) => String(e.id));
  const notSelectedIds = notSelected.map((e) => String(e.id));

  if (winnerIds.length > 0) {
    // returning: 'default' — the legacy PATCH sent no Prefer header.
    await getDb().update(
      'raffle_entries',
      { where: { id: inList(winnerIds) } },
      { status: 'winner', decided_at: nowIso },
      { returning: 'default' },
    );
  }
  // NON-WINNERS STAY PENDING — they roll over into the next draw.
  //
  // This used to set status='not_selected', which removed them from
  // listPendingEntries and therefore from every future draw. That silently
  // changed a customer-facing mechanic: the KV engines re-push non-winners
  // into the pool (trigger-drop: "keep the rest ... who keep their entry for
  // the next draw"), so under Redis a loser is automatically in next week's
  // drop. Proven by running two consecutive draws: Postgres gave draw 2 zero
  // entries where Redis would have given it two.
  //
  // Storage migrations do not get to change what customers experience, so the
  // KV behaviour wins. Who was not selected is still recorded on the
  // drop_draws row below, so the draw history is unchanged.
  //
  // Whether a loss rolls over is a legitimate per-drop merchant choice -- see
  // ARCHITECTURE.md's merchant-panel commerce-mode requirements.

  const drawRows = await getDb().insert<{ id: string }>('drop_draws', {
      tenant_id: tenantId,
      variant_id: variantId,
      winner_count: winnerIds.length,
      entries_count: entries.length,
    // notSelectedEntryIds is the ONLY record that these entries lost this
    // draw, now that their status stays 'pending' so they roll over.
    summary: { winnerEntryIds: winnerIds, notSelectedEntryIds: notSelectedIds, nonWinnersRolledOver: true },
  });

  return {
    drawId: drawRows?.[0]?.id || '',
    winnerCount: winnerIds.length,
    entriesCount: entries.length,
    winnerEntryIds: winnerIds,
    notSelectedEntryIds: notSelectedIds,
    winners,
  };
}

/** Find a pending entry's id by tenant/variant/email — used by
 *  lib/auto-draw.ts's Postgres outcome mirror to resolve which
 *  `raffle_entries` row a Redis-decided winner/decline corresponds to
 *  (the row itself was dual-written by the checkout webhook, Phase 2).
 *  Returns null when no matching pending row exists (not dual-written yet,
 *  or already decided) — the caller skips the mirror, never errors. */
export async function findPendingEntryId(tenantId: string, variantId: string, email: string): Promise<string | null> {
  assertSupabase();
  const rows = await getDb().select<{ id: string }>('raffle_entries', {
    where: {
      tenant_id: eq(tenantId),
      variant_id: eq(variantId),
      email: eq(String(email || '').trim().toLowerCase()),
      status: eq('pending'),
    },
    select: ['id'],
    limit: 1,
  });
  return rows?.[0]?.id || null;
}

/** Mark a winning entry as charged (after a successful Stripe charge) or
 *  declined (after a failed one) — the caller (webhook/charge route) still
 *  owns the actual Stripe call; this only records the outcome. */
/**
 * Return a DECLINED winner to the pool, matching the KV engines, which
 * re-push declined winners alongside non-winners
 * (`[...shuffled.slice(winnerCount), ...declinedEntries]`).
 *
 * EDGE CASE that only exists in Postgres: the duplicate-entry index is
 * partial on 'pending', so while this entry sat at status='winner' the same
 * email was free to create a FRESH pending entry. Rolling this one back would
 * then violate the index. If that happens the entry stays 'declined' -- the
 * customer already has a live entry, so rolling this one over would give them
 * two slots in the next draw.
 *
 * Worth flagging as a policy question rather than a fact of nature: this
 * retries the same failing card every draw, indefinitely, which is what the
 * KV engines already do. Retry-on-decline belongs with the per-drop
 * commerce-mode settings.
 */
async function rollDeclinedEntryBackToPool(tenantId: string, entryId: string): Promise<void> {
  try {
    await getDb().update(
      'raffle_entries',
      { where: { tenant_id: eq(tenantId), id: eq(entryId) } },
      { status: 'pending', decided_at: null },
      { returning: 'default' },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      console.warn(
        '[raffle] declined entry ' + entryId + ' left as declined — the same email already has a ' +
          'pending entry, and rolling this one over would give them two slots.',
      );
      return;
    }
    console.error('[raffle] could not roll a declined entry back to the pool', entryId, message);
  }
}

export async function markRaffleEntryOutcome(tenantId: string, entryId: string, outcome: 'charged' | 'declined'): Promise<void> {
  assertSupabase();
  // returning: 'default' — the legacy PATCH sent no Prefer header.
  await getDb().update(
    'raffle_entries',
    { where: { tenant_id: eq(tenantId), id: eq(entryId) } },
    { status: outcome },
    { returning: 'default' },
  );
}

export type ChargeOutcome = { entryId: string; email: string; status: 'charged' | 'declined'; error?: string };

/**
 * Postgres-primary execution for `app/api/admin/trigger-drop`'s manual
 * "draw this variant now" action: select winners (`executeDraw`, above —
 * this writes `status='winner'`/`decided_at` into `raffle_entries` FIRST,
 * before any charge is attempted, matching the ask that Postgres holds the
 * winner status before notification), then charge each winner's card via
 * Stripe and email them.
 *
 * Deliberately narrower than the live Redis cron engine
 * (lib/auto-draw.ts) — no recurring-cadence rollover, no promoter payouts,
 * no auto-activation. Those stay on the Redis engine; see DEPLOYMENT.md.
 * A winner with no payment method, or whose charge is declined, is marked
 * `declined` and skipped — never blocks the rest of the batch.
 */
export async function executeDrawWithCharging(
  tenantId: string,
  variantId: string,
  winnerCount: number,
): Promise<{ draw: DrawExecutionResult; charges: ChargeOutcome[] }> {
  assertSupabase();
  const draw = await executeDraw(tenantId, variantId, winnerCount);
  if (draw.winners.length === 0) return { draw, charges: [] };
  const stripe = await resolveStripeClient();

  const variantRows = await getDb()
    .select<{ option_label: string; price_cents: number; products: { name: string } | null }>('product_variants', {
      where: { id: eq(variantId) },
      select: ['option_label', 'price_cents', { relation: 'products', columns: ['name'] }],
    })
    .catch(() => []);
  const variant = variantRows?.[0];
  const productName = variant?.products?.name || 'Item';
  const size = variant?.option_label || 'Standard';
  const basePriceCents = Math.max(0, Number(variant?.price_cents) || 0);
  const siteUrl = getSiteUrl() || fallbackSiteUrl();

  const charges: ChargeOutcome[] = [];
  for (const entry of draw.winners) {
    const entryId = String(entry.id);
    const email = String(entry.email || '');
    const customerId = String(entry.customer_id || '');
    const paymentMethodId = String(entry.payment_method_ref || '');
    const discountPercent = Math.min(50, Math.max(0, Number(entry.discount_percent) || 0));
    const priceCents = discountPercent > 0 ? Math.max(50, Math.round(basePriceCents * (1 - discountPercent / 100))) : basePriceCents;

    if (!stripe || !customerId || !paymentMethodId) {
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      // Option 1: a declined winner returns to the pool, as the KV engines do.
      await rollDeclinedEntryBackToPool(tenantId, entryId);
      charges.push({ entryId, email, status: 'declined', error: 'no_payment_method' });
      continue;
    }

    try {
      // Deterministic per (draw, entry). `draw.drawId` is the `drop_draws`
      // row minted by executeDraw() above, so it is unique per draw
      // execution — replaying this call (route retry, double-submit) returns
      // the original charge rather than billing the winner twice, while a
      // genuinely new draw of the same variant gets a new drawId and can
      // charge again.
      const idempotencyKey = boundIdempotencyKey(`raffle-draw:${draw.drawId}:${entryId}`);
      await stripe.paymentIntents.create(
        {
          amount: priceCents,
          currency: 'usd',
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          receipt_email: email || undefined,
          description: `${productName} (${size})`,
        },
        { idempotencyKey },
      );
      await markRaffleEntryOutcome(tenantId, entryId, 'charged');
      charges.push({ entryId, email, status: 'charged' });

      try {
        await deliverWinnerEmail({
          to: email,
          product: productName,
          size,
          amountLabel: `$${(priceCents / 100).toFixed(2)}`,
          originalPrice: `$${(basePriceCents / 100).toFixed(2)}`,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          shippingAddress: (entry.shipping_address as string) || undefined,
          siteUrl,
        });
      } catch (emailErr) {
        console.error('[raffle] winner email failed', emailErr);
      }
    } catch (err) {
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      // Option 1: a declined winner returns to the pool, as the KV engines do.
      await rollDeclinedEntryBackToPool(tenantId, entryId);
      charges.push({ entryId, email, status: 'declined', error: (err as Error)?.message || String(err) });
    }
  }

  return { draw, charges };
}

// ── Shared inventory pools ───────────────────────────────────────────────────

export type PoolDecrementResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'insufficient_stock' | 'lock_contended' | 'no_pool'; remaining?: number };

async function getPoolLevel(tenantId: string, slug: string): Promise<{ id: string; quantityAvailable: number } | null> {
  const rows = await getDb().select<{ id: string; quantity_available: number }>('shared_inventory_pools', {
    where: { tenant_id: eq(tenantId), slug: eq(slug) },
    select: ['id', 'quantity_available'],
    limit: 1,
  });
  const row = rows?.[0];
  return row ? { id: row.id, quantityAvailable: Number(row.quantity_available) || 0 } : null;
}

async function getPoolLevelById(tenantId: string, poolId: string): Promise<{ id: string; quantityAvailable: number } | null> {
  const rows = await getDb().select<{ id: string; quantity_available: number }>('shared_inventory_pools', {
    where: { tenant_id: eq(tenantId), id: eq(poolId) },
    select: ['id', 'quantity_available'],
    limit: 1,
  });
  const row = rows?.[0];
  return row ? { id: row.id, quantityAvailable: Number(row.quantity_available) || 0 } : null;
}

/**
 * CAS decrement with bounded retry, mirroring lib/inventory.ts.
 *
 * A LOST compare-and-swap means a concurrent draw moved the row between our
 * read and our write. It does NOT mean the pool is out of stock, and reporting
 * insufficient_stock for it refused entrants while stock remained -- the same
 * lost-sales bug measured on decrementInventory (12 buyers, 5 units, 1 sold).
 * `reread` re-reads the row so a race costs a round trip, not a sale.
 */
async function decrementPoolRow(
  tenantId: string,
  pool: { id: string; quantityAvailable: number },
  qty: number,
  reread?: () => Promise<{ id: string; quantityAvailable: number } | null>,
): Promise<PoolDecrementResult> {
  const ATTEMPTS = 5;
  let current: { id: string; quantityAvailable: number } | null = pool;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (!current) return { ok: false, reason: 'no_pool' };
    if (current.quantityAvailable < qty) {
      return { ok: false, reason: 'insufficient_stock', remaining: current.quantityAvailable };
    }
    const nextAvailable = current.quantityAvailable - qty;
    const updated = await getDb().update<{ quantity_available: number }>(
      'shared_inventory_pools',
      { where: { id: eq(current.id), quantity_available: eq(current.quantityAvailable) } },
      { quantity_available: nextAvailable },
    );
    if (Array.isArray(updated) && updated.length > 0) {
      return { ok: true, remaining: nextAvailable };
    }
    if (!reread) {
      // No way to re-read (legacy caller) — report contention honestly rather
      // than claiming the pool is empty.
      return { ok: false, reason: 'lock_contended' };
    }
    current = await reread();
  }
  return { ok: false, reason: 'lock_contended' };
}

/** Atomic decrement of a shared pool by slug — identical lock + optimistic-
 *  concurrency pattern to lib/inventory.ts's `decrementInventory`, applied
 *  to a pool that multiple variants draw from instead of one variant's own
 *  row. */
export async function decrementSharedPool(tenantId: string, slug: string, quantity: number): Promise<PoolDecrementResult> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const redis = createKvClient();
  if (!redis) return { ok: false, reason: 'lock_contended' };

  const lockResult = await withRedisLock(redis, `shared-pool:pg:${tenantId}:${slug}`, async (): Promise<PoolDecrementResult> => {
    const current = await getPoolLevel(tenantId, slug);
    if (!current) return { ok: false, reason: 'no_pool' };
    return decrementPoolRow(tenantId, current, qty, () => getPoolLevel(tenantId, slug));
  });

  if (!lockResult.ok) return { ok: false, reason: 'lock_contended' };
  return lockResult.value;
}

/** Same as `decrementSharedPool`, keyed by the pool's id instead of its
 *  slug — for callers (order creation) that already resolved
 *  `product_variants.shared_pool_id` and shouldn't need a second lookup to
 *  recover the slug. */
export async function decrementSharedPoolById(tenantId: string, poolId: string, quantity: number): Promise<PoolDecrementResult> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const redis = createKvClient();
  if (!redis) return { ok: false, reason: 'lock_contended' };

  const lockResult = await withRedisLock(redis, `shared-pool:pg:id:${tenantId}:${poolId}`, async (): Promise<PoolDecrementResult> => {
    const current = await getPoolLevelById(tenantId, poolId);
    if (!current) return { ok: false, reason: 'no_pool' };
    return decrementPoolRow(tenantId, current, qty, () => getPoolLevelById(tenantId, poolId));
  });

  if (!lockResult.ok) return { ok: false, reason: 'lock_contended' };
  return lockResult.value;
}

/** Restock a shared pool by id (the inverse of decrementSharedPoolById) —
 *  used to roll back a partially-reserved multi-line order when a later
 *  line fails. No lock needed (a plain additive increment has no "not
 *  enough stock" race to protect against on the way up, same as
 *  lib/inventory.ts's `restockInventory`). */
export async function restockSharedPoolById(tenantId: string, poolId: string, quantity: number): Promise<void> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const current = await getPoolLevelById(tenantId, poolId);
  if (!current) return;
  // returning: 'default' — the legacy PATCH sent no Prefer header.
  await getDb().update(
    'shared_inventory_pools',
    { where: { id: eq(poolId) } },
    { quantity_available: current.quantityAvailable + qty },
    { returning: 'default' },
  );
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function addToWaitlist(tenantId: string, variantId: string, email: string): Promise<{ ok: boolean; alreadyWaiting?: boolean }> {
  assertSupabase();
  try {
    await getDb().insert('waitlist_entries', {
      tenant_id: tenantId,
      variant_id: variantId,
      email: String(email || '').trim().toLowerCase(),
    });
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      return { ok: true, alreadyWaiting: true };
    }
    throw err;
  }
}

/**
 * Does this email already hold an ACTIVE entry for this product+size?
 *
 * H6: the Postgres half of the pre-charge duplicate gate. The KV check it
 * joins is `sismember(emailBlockKey)` + a pool scan, and `sadd` runs through
 * the same non-atomic read-modify-write as the broken lock did -- so two
 * concurrent entries from one email could both pass it. The partial unique
 * index cannot be raced, which is why this is the half that actually decides.
 *
 * Semantics deliberately match the KV gate rather than replace it: one active
 * entry per email per variant, and re-entry allowed once that entry has been
 * decided (the index is partial on 'pending'). Verified by evaluating the KV
 * predicate across its state space -- `maxPerEmail > 1` is unreachable there,
 * because the email-block set is written on every registration.
 *
 * Returns false when Postgres cannot answer. Callers OR this with the KV
 * check, so an unavailable database can never turn into "allowed twice"; it
 * just falls back to the weaker guard.
 */
export async function hasActiveRaffleEntry(
  tenantId: string,
  externalProductId: string,
  size: string,
  email: string,
): Promise<boolean> {
  try {
    const { resolveVariantId } = await import('./inventory.ts');
    const variantId = await resolveVariantId(tenantId, externalProductId, size);
    if (!variantId) return false;
    return (await findPendingEntryId(tenantId, variantId, String(email || '').trim().toLowerCase())) !== null;
  } catch (err) {
    console.error('[raffle] duplicate-entry check failed, deferring to the KV gate', externalProductId, size, (err as Error)?.message || err);
    return false;
  }
}
