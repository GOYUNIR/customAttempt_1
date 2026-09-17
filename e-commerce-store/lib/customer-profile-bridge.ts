/**
 * THE KV BRIDGE for the customer profile (H7). Deleted by H9.
 *
 * public.customers is authoritative for rewards_balance, email_opt_in,
 * terms_agreed_at and role (migration 00022). But `store:users` is still read
 * by paths this phase does not repoint — the order-confirmation email, the
 * entry-confirmation email, the winner emails and the admin users list all
 * scan the hash for `u.rewards` to print a points balance to a customer.
 *
 * If the authoritative balance moved and the KV copy did not, those emails
 * would quietly start lying. So every writer that changes the authoritative
 * balance mirrors the RESULT back here. The mirror is display-only: nothing
 * decides anything from it, and a mirror failure never fails the write that
 * already succeeded in Postgres.
 *
 * Direction matters. Postgres is written FIRST (with the compare-and-swap),
 * and KV is told what Postgres ended up holding. Writing KV first, or writing
 * the two independently, would reintroduce the lost update the CAS exists to
 * prevent.
 *
 * DELETION CRITERIA (H9): when no code outside this file reads `rewards`,
 * `emailOptIn`, `termsAgreedAt` or `role` from `store:users`, delete this file
 * and its call sites. `password` and `emailVerified` stay in the hash
 * regardless — that is DEFERRED-6, not a leftover.
 */
import { USERS_KEY } from '@/lib/redis-keys';
import { safeParseKvItem } from '@/lib/server-config';

/**
 * Find the `store:users` hash field holding this email, with the parsed record.
 *
 * The hash is keyed by internal user id, not email, so every caller that wants
 * "the user for this address" has to scan. That scan is duplicated in seven
 * places today; this is the one the bridge uses.
 */
export async function findKvUserByEmail(
  redis: any,
  email: string,
): Promise<{ field: string; user: any } | null> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!redis || !normalized) return null;
  try {
    const raw = await redis.hgetall(USERS_KEY);
    if (!raw) return null;
    for (const [field, value] of Object.entries(raw)) {
      const u = safeParseKvItem<any>(value);
      if (u && String(u.email || '').trim().toLowerCase() === normalized) {
        return { field, user: u };
      }
    }
  } catch (err) {
    console.error('[profile-bridge] user scan failed', normalized, (err as Error)?.message || err);
  }
  return null;
}

/**
 * Copy the authoritative balance into the KV record so the unmigrated readers
 * keep printing the right number.
 *
 * Best-effort on purpose: the points have already been granted or spent in
 * Postgres by the time this runs. Failing the request here would tell the
 * customer their redemption failed when it did not.
 */
export async function mirrorRewardsToKv(redis: any, email: string, balance: number): Promise<void> {
  const found = await findKvUserByEmail(redis, email);
  if (!found) return;
  const next = Math.max(0, Math.floor(Number(balance) || 0));
  if (Math.floor(Number(found.user.rewards || 0)) === next) return;
  try {
    await redis.hset(USERS_KEY, {
      [found.field]: JSON.stringify({ ...found.user, rewards: next, updatedAt: new Date().toISOString() }),
    });
  } catch (err) {
    console.error('[profile-bridge] rewards mirror failed', email, (err as Error)?.message || err);
  }
}

/** Patch arbitrary fields onto the KV record (used for auth fields that stay). */
export async function patchKvUser(redis: any, email: string, patch: Record<string, unknown>): Promise<any | null> {
  const found = await findKvUserByEmail(redis, email);
  if (!found) return null;
  const updated = { ...found.user, ...patch, updatedAt: new Date().toISOString() };
  try {
    await redis.hset(USERS_KEY, { [found.field]: JSON.stringify(updated) });
    return updated;
  } catch (err) {
    console.error('[profile-bridge] user patch failed', email, (err as Error)?.message || err);
    return null;
  }
}
